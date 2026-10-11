/**
 * CubeSandbox backend for the **per-user** DSH lifecycle
 * (docs/plan/cubesandbox-backend.md §4).
 *
 * One long-lived sandbox per user (`dsh-<userId>`) with the user's workspace on
 * a dedicated volume. The one behavioural difference from the `local`/`k8s`
 * backends is what idle reaping means: {@link CubesandboxSpawner.stop} **pauses**
 * (whole-machine snapshot) and **never drops the desired `dsh_instances` row** —
 * that is what turns the platform from "one-shot per session" into "held per
 * user" (§9).
 *
 * Deliberately **not** carried over from the k8s backend: per-user UIDs,
 * `setpriv` privilege dropping and iptables rules. A sandbox *is* the isolation
 * boundary, so account-level isolation inside it buys nothing (§4) — which is
 * why this constructor takes no `resolveUid`.
 *
 * The `SandboxClient` is injected with no default: the real REST/SDK client is
 * phase P3, and an optional-with-throwing-default would let a deployment compile
 * against a client that cannot exist yet (§16.3).
 * @module dsh-server-login/supervisor/cubesandbox-spawner
 */

import type { ServerConfig } from '../config.js'
import type { DbAdapter } from '../db/adapter.js'
import { HANDOFF_FILE, HOME_DIR, USERS_DIR, WORKSPACE_DIR } from '../fs/workspace.js'
import {
  SandboxNotFoundError,
  type SandboxClient,
  type SandboxInfo,
  type SandboxSpec,
  type SandboxState,
} from '../sandbox/client.js'
import type { Fencing } from './leader.js'
import {
  AlreadyRunningError,
  type Endpoint,
  type IdlePolicy,
  type Instance,
  type InstanceStatus,
  type LivePod,
  type LiveWatcher,
  type SupervisedSpawner,
  type UserStatus,
} from './spawner.js'

/** Label pair selecting the sandboxes this backend owns (`list`/`teardown`). */
const MANAGED_BY_KEY = 'dsh.io/managed-by'
const MANAGED_BY_VALUE = 'dsh-server-login'
/** App label shared with the k8s backend, so both describe "a user's main DSH". */
const APP_LABEL = 'dsh'

/** Where the rendered cordis patch is written inside the sandbox. Same path as
 * the k8s ConfigMap mount, and **outside** the user volume so a reused volume
 * can never carry a stale patch. */
const PATCH_PATH = '/etc/dsh/patch.yml'

/** Where the main DSH records its pid — lets a restart target exactly one
 * process, and lets `kill -0` tell whether a resumed snapshot still has it
 * (the hedge against real-machine assumption #1, §13). */
const DSH_PID_FILE = '/run/dsh.pid'

/** Task the headless watchdog runs. Mirrors `k8s-spawner.ts:24`; kept local so
 * the sandbox backend pulls in no k8s client. */
const WATCHDOG_TASK =
  'Read DSH_SERVER_LOGIN_HANDOFF_PATH. If it contains a JSON {"command": ...}, run that command. Then exit.'

/** Deterministic names — reusing them keeps create/ensure idempotent. */
function names(userId: string): { sandbox: string; volume: string } {
  return { sandbox: `dsh-${userId}`, volume: `dsh-vol-${userId}` }
}

/** Labels stamped on every sandbox this backend creates. The fencing pair
 * mirrors `K8sSpawner` (`k8s-spawner.ts:112`), so a successor can identify work
 * a dead leader left in flight. */
function sandboxLabels(userId: string, fencing?: Fencing): Record<string, string> {
  const labels: Record<string, string> = { app: APP_LABEL, user: userId, [MANAGED_BY_KEY]: MANAGED_BY_VALUE }
  if (fencing !== undefined) {
    labels['dsh.io/holder'] = fencing.holder
    labels['dsh.io/operation-id'] = String(fencing.operationId)
  }
  return labels
}

/** Per-user paths **inside** the sandbox; the volume is mounted at `mount`.
 * Built with POSIX separators — the control plane may be tested on Windows. */
function userPaths(config: ServerConfig, userId: string): { mount: string; home: string; ws: string } {
  const mount = `${config.cubesandbox.volumeMountPath}/${USERS_DIR}/${userId}`
  return { mount, home: `${mount}/${HOME_DIR}`, ws: `${mount}/${WORKSPACE_DIR}` }
}

/** POSIX single-quote one argv element before it reaches `sh -c`. */
function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`
}

/** Quote a whole argv for `sh -c` (the sandbox `exec` surface takes a string). */
function quoteCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ')
}

/**
 * Sandbox state → upstream `InstanceStatus`.
 *
 * `paused` maps to itself: the row keeps saying `paused` while the snapshot is
 * held, which is what tells the reconcile idle-reap loop not to write it again
 * every tick (`reconcile.ts`). The two DB mirrors and both CHECK constraints
 * carry the value as of migration v5.
 */
function toInstanceStatus(state: SandboxState): InstanceStatus {
  if (state === 'running') return 'running'
  if (state === 'starting') return 'starting'
  if (state === 'error') return 'crashed'
  if (state === 'paused') return 'paused'
  return 'stopped'
}

/** The CubeSandbox per-user backend. */
export class CubesandboxSpawner implements SupervisedSpawner {
  /** Idle means **pause**, not release: the desired `dsh_instances` row survives
   * so the user's next request resumes the snapshot instead of cold-starting. */
  readonly idlePolicy: IdlePolicy = 'retain'
  private fencing: Fencing | undefined

  constructor(
    private readonly config: ServerConfig,
    private readonly db: DbAdapter,
    private readonly resolveApiKey: (userId: string) => Promise<string | null>,
    private readonly client: SandboxClient,
  ) {}

  async launch(userId: string, folder: string, patch?: string): Promise<Instance> {
    const { sandbox: name, volume } = names(userId)
    const existing = await this.info(userId)
    if (existing !== undefined) {
      if (existing.state === 'paused') return await this.wake(userId, existing, folder, patch)
      if (existing.state !== 'error') throw new AlreadyRunningError(userId)
      // `error`: replace it. The workspace lives on its own volume, so the
      // user's files survive the destroy.
      await this.ignoreNotFound(() => this.client.destroy(existing.id))
    }
    this.requireTarget()
    await this.ensureFileService(userId) // the volume must exist before it is mounted
    const apiKey = await this.resolveApiKey(userId)
    const { mount, home, ws } = userPaths(this.config, userId)
    const env: Record<string, string> = { HOME: ws, DSH_HOME: home }
    if (apiKey !== null) env.DEEPSEEK_API_KEY = apiKey
    const spec: SandboxSpec = {
      name,
      template: this.config.cubesandbox.template,
      env,
      volumes: [{ name: volume, mountPath: mount }],
      labels: sandboxLabels(userId, this.fencing),
    }
    if (this.config.enablePatch && patch !== undefined) spec.files = { [PATCH_PATH]: patch }
    const info = await this.client.create(spec)
    await this.waitForRunning(info.id)
    await this.startMain(userId)
    try {
      // reconcile needs this row to keep the sandbox alive; a bookkeeping
      // failure must not fail the launch (mirrors K8sSpawner.launch).
      await this.db.upsertInstance({ id: name, userId, role: 'main', status: 'starting', folder, patch })
    } catch (err) {
      this.logError(err)
    }
    return { id: name, userId, role: 'main', folder, status: 'starting', patch }
  }

  async restartMain(userId: string): Promise<Instance | undefined> {
    const desired = await this.db.findUserInstance(userId, 'main')
    if (desired === undefined) return undefined
    const folder = desired.folder ?? ''
    const patch = desired.patch ?? undefined
    const existing = await this.info(userId)
    if (existing === undefined) {
      // No sandbox (e.g. the node lost it): recreate. The workspace is on a
      // separate volume, so the user's files survive.
      return await this.launch(userId, folder, patch)
    }
    // Restart **in place**: never destroy, or the in-sandbox state the pause
    // snapshot exists to protect would be thrown away (§4).
    if (existing.state === 'paused') await this.client.resume(existing.id)
    await this.killMain(userId)
    await this.startMain(userId)
    return { id: existing.id, userId, role: 'main', folder, status: 'running', patch }
  }

  async spawnWatchdog(userId: string): Promise<Instance | undefined> {
    if (!this.config.enablePatch) return undefined // the watchdog needs the runtime patch
    const existing = await this.info(userId)
    if (existing === undefined) return undefined // nothing to run the task inside
    if (existing.state === 'paused') await this.client.resume(existing.id)
    const { mount, home, ws } = userPaths(this.config, userId)
    const argv = [...this.config.cubesandbox.dshCommand, '--profile', 'headless']
    if (this.config.enablePatch) argv.push('--patch', PATCH_PATH)
    argv.push(WATCHDOG_TASK)
    await this.client.exec(existing.id, quoteCommand(argv), {
      background: true,
      env: {
        HOME: ws,
        DSH_HOME: home,
        DSH_SERVER_LOGIN_ROLE: 'watchdog',
        DSH_SERVER_LOGIN_HANDOFF_PATH: `${mount}/${HANDOFF_FILE}`,
      },
    })
    return { id: `${existing.id}-watchdog`, userId, role: 'watchdog', folder: ws, status: 'starting' }
  }

  async status(userId: string): Promise<UserStatus> {
    const existing = await this.info(userId)
    if (existing === undefined) return {}
    return {
      main: { id: existing.id, userId, role: 'main', folder: '', status: toInstanceStatus(existing.state) },
    }
  }

  async endpointFor(userId: string): Promise<Endpoint | undefined> {
    const existing = await this.info(userId) // not-found → undefined; real failures propagate
    if (existing === undefined) return undefined
    // A **paused** sandbox still advertises its mapping on purpose: the request
    // that follows is what triggers AutoResume, so returning the address is the
    // point. The wake latency must be measured against the proxy's read timeout
    // (real-machine assumptions #2, §13).
    if (existing.state !== 'running' && existing.state !== 'paused') return undefined
    if (existing.host === undefined || existing.port === undefined) return undefined
    return { host: existing.host, port: existing.port }
  }

  async stop(userId: string): Promise<void> {
    const existing = await this.info(userId)
    if (existing === undefined) return // already gone
    if (existing.state === 'paused') return // already suspended
    await this.client.pause(existing.id)
    // The desired `dsh_instances` row is deliberately **not** deleted here,
    // unlike the k8s backend. Under this backend the row *is* the user's
    // long-lived claim on their sandbox, so its fate belongs to the reconcile
    // idle-reap caller, which marks it `paused` instead of dropping it (§9) —
    // this method only decides *how* the instance stops.
  }

  async teardown(): Promise<void> {
    const owned = await this.client.list({ labels: { [MANAGED_BY_KEY]: MANAGED_BY_VALUE } })
    for (const sandbox of owned) {
      try {
        await this.client.destroy(sandbox.id)
      } catch (err) {
        this.logError(err) // shutdown must not be blocked by one stuck sandbox
      }
    }
    // Volumes are left alone on purpose: they hold user workspaces, and a
    // control-plane restart is not a reason to erase them.
  }

  /** Ensure the user's volume exists (it is the mount the DSH sandbox needs). */
  async ensureFileService(userId: string): Promise<void> {
    await this.ensureUserResources(userId)
  }

  /** The sandbox backend's per-user resource is the volume. Called every
   * reconcile tick for every desired instance (including paused ones), so it
   * must stay cheap and idempotent. */
  async ensureUserResources(userId: string): Promise<void> {
    await this.client.ensureVolume(names(userId).volume)
  }

  /** Live sandboxes in the shape `planReconcile` diffs.
   *
   * ★ Invariant this relies on: the sandbox API's `list` must include **paused**
   * sandboxes. If it did not, a paused user would look "missing" every tick and
   * be relaunched — though `launch` would then resume the existing sandbox
   * rather than create a second one (it re-checks `info` first), so the failure
   * mode is a wasted round-trip, not a duplicate sandbox. Real-machine
   * verification item (§13). */
  async listUserPods(): Promise<LivePod[]> {
    const owned = await this.client.list({ labels: { app: APP_LABEL, [MANAGED_BY_KEY]: MANAGED_BY_VALUE } })
    return owned.map((sandbox) => ({
      name: sandbox.id,
      userId: sandbox.labels?.user ?? '',
      running: sandbox.state === 'running',
      crashed: sandbox.state === 'error',
    }))
  }

  /**
   * Watch live sandboxes by **polling** — this backend has no informer.
   *
   * Emits every managed sandbox on every poll rather than only on change. That
   * is safe because the controller's crash path is guarded by its own
   * "already fired" set (`reconcile.ts` `watchdogFired`), so a repeated emit for
   * a crashed sandbox does not spawn a second watchdog, and a healthy emit is a
   * no-op. Best-effort: a failed poll logs and retries on the next interval, so
   * the reconcile tick still converges if the watch never works at all.
   */
  watchMainPods(callback: (pod: LivePod) => void): LiveWatcher {
    let timer: NodeJS.Timeout | undefined
    let stopped = false
    const poll = async (): Promise<void> => {
      if (stopped) return
      try {
        for (const pod of await this.listUserPods()) callback(pod)
      } catch (err) {
        this.logError(err)
      }
      if (stopped) return
      timer = setTimeout(() => void poll(), this.config.cubesandbox.watchIntervalMs)
      timer.unref?.()
    }
    return {
      start: async () => {
        stopped = false
        await poll()
      },
      stop: async () => {
        stopped = true
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
      },
    }
  }

  /** Stamp the current leader's fencing token onto the sandboxes created from
   * now on. Mirrors `K8sSpawner.setFencing`: the token is telemetry for a human
   * (nothing in this repo reads it back), so an unstamped sandbox is harmless —
   * which is why no reconciliation is attempted for the ones already created. */
  setFencing(fencing: Fencing | undefined): void {
    this.fencing = fencing
  }

  /** Best-effort error surface for the controller's tick loop. */
  logError(err: unknown): void {
    console.error('[dsh-cubesandbox]', err)
  }

  // --- helpers ---

  /** `undefined` only when the sandbox is genuinely absent. A transport or auth
   * failure propagates, so callers cannot mistake it for "not running"
   * (same rule as `K8sSpawner.endpointFor`). */
  private async info(userId: string): Promise<SandboxInfo | undefined> {
    try {
      return await this.client.info(names(userId).sandbox)
    } catch (err) {
      if (err instanceof SandboxNotFoundError) return undefined
      throw err
    }
  }

  /** A held sandbox waking up: resume, then make sure its DSH is still there. */
  private async wake(
    userId: string,
    existing: SandboxInfo,
    folder: string,
    patch?: string,
  ): Promise<Instance> {
    await this.client.resume(existing.id)
    if (!(await this.isMainAlive(userId))) await this.startMain(userId)
    return { id: existing.id, userId, role: 'main', folder, status: 'running', patch }
  }

  private requireTarget(): void {
    if (this.config.cubesandbox.template === '') {
      throw new Error(
        'DSH_SERVER_LOGIN_CUBESANDBOX_TEMPLATE is required by the cubesandbox backend (the sandbox template must carry the DSH CLI)',
      )
    }
  }

  /** Poll until the sandbox reports `running` (mirrors `waitForPodReady`). */
  private async waitForRunning(id: string, timeoutMs = this.config.cubesandbox.readyTimeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const info = await this.client.info(id)
      if (info === undefined) throw new SandboxNotFoundError(id)
      if (info.state === 'running') return
      if (info.state === 'error') throw new Error(`sandbox ${id} failed to start`)
      if (Date.now() >= deadline) throw new Error(`sandbox ${id} not running within ${timeoutMs}ms`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  /** The argv that starts the main DSH **inside** the sandbox.
   *
   * Order matters and follows the working local backend
   * (`orchestrator.ts:164-177`): `--patch` is a launcher flag and must precede
   * `--host`/`--port`, or dsh forwards it to the inner app as an unknown option.
   * (The k8s backend gets this wrong — see `k8s-spawner.ts:411`.) */
  private dshArgv(): string[] {
    const argv = [...this.config.cubesandbox.dshCommand, '--profile', 'web']
    if (this.config.enablePatch) argv.push('--patch', PATCH_PATH)
    argv.push('--host', '127.0.0.1', '--port', String(this.config.cubesandbox.dshPort))
    return argv
  }

  /** Start the main DSH detached, recording its pid first so a later restart can
   * target exactly this process (and `kill -0` can probe it). */
  private async startMain(userId: string): Promise<void> {
    const script = `printf %s $$ > ${DSH_PID_FILE} && exec ${quoteCommand(this.dshArgv())}`
    await this.client.exec(names(userId).sandbox, `sh -c ${shellQuote(script)}`, { background: true })
  }

  /** Best effort: a resumed snapshot may have no pid file, and a fresh sandbox
   * certainly has none — "already gone" must not surface as a failure. */
  private async killMain(userId: string): Promise<void> {
    const script = `kill "$(cat ${DSH_PID_FILE} 2>/dev/null)" 2>/dev/null || true`
    await this.client.exec(names(userId).sandbox, `sh -c ${shellQuote(script)}`)
  }

  private async isMainAlive(userId: string): Promise<boolean> {
    const script = `kill -0 "$(cat ${DSH_PID_FILE} 2>/dev/null)" 2>/dev/null`
    try {
      const result = await this.client.exec(names(userId).sandbox, `sh -c ${shellQuote(script)}`)
      return result.exitCode === 0
    } catch (err) {
      if (err instanceof SandboxNotFoundError) return false
      throw err
    }
  }

  private async ignoreNotFound(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      if (err instanceof SandboxNotFoundError) return
      throw err
    }
  }
}
