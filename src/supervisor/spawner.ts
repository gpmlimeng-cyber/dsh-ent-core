/**
 * Backend abstraction for per-user DSH lifecycle (docs/k8s.md §5.2).
 *
 * `local` spawns child processes (setuid/iptables) via `LocalSpawner`; `k8s`
 * creates/deletes per-user DSH Pods via the K8s API (`K8sSpawner`);
 * `cubesandbox` runs one long-lived sandbox per user (`CubesandboxSpawner`).
 * The route layer depends only on this interface, so all backends coexist
 * behind the same API. Shared instance/status types live here so no backend
 * owns them.
 *
 * {@link SupervisedSpawner} is the narrower, *supervised* half: the extra
 * capabilities the leader-only reconcile controller needs. `LocalSpawner` is
 * deliberately not one — it has no cluster to supervise.
 * @module dsh-server-login/supervisor/spawner
 */

import type { Fencing } from './leader.js'

export type InstanceStatus = 'starting' | 'running' | 'crashed' | 'stopped' | 'paused'
export type InstanceRole = 'main' | 'watchdog'

/** A tracked DSH instance (main or watchdog). `port`/`pid` are local-only. */
export interface Instance {
  id: string
  userId: string
  role: InstanceRole
  folder: string
  port?: number
  status: InstanceStatus
  pid?: number
  exitCode?: number
  lastError?: string
  /** Rendered cordis patch **content**, not a path — see {@link Spawner.launch}. */
  patch?: string
}

/** Thrown when a user already has a running main DSH. */
export class AlreadyRunningError extends Error {
  constructor(userId: string) {
    super(`user ${userId} already has a running DSH`)
    this.name = 'AlreadyRunningError'
  }
}

/** A user's main + watchdog pair. */
export interface UserStatus {
  main?: Instance
  watchdog?: Instance
}

/** The host:port the proxy forwards a user's DSH traffic to. */
export interface Endpoint {
  host: string
  port: number
}

/** A main DSH Pod as observed by the k8s backend (for reconcile + the watch). */
export interface LivePod {
  name: string
  userId: string
  running: boolean
  crashed: boolean
}

/**
 * The lifecycle seam the route layer delegates to.
 *
 * `endpointFor` is spawner-specific: local → `127.0.0.1:<port>`, k8s → the
 * per-user Headless Service DNS (docs/k8s.md §5.4).
 *
 * `launch` takes the rendered cordis patch as **content**, not a path: under
 * k8s the control plane holds no user volume, so it can neither write the patch
 * nor read it back. `LocalSpawner` materializes it to a file (it does have the
 * volume) and `K8sSpawner` puts it straight into a ConfigMap.
 */
export interface Spawner {
  launch(userId: string, folder: string, patch?: string): Promise<Instance>
  restartMain(userId: string): Promise<Instance | undefined>
  spawnWatchdog(userId: string): Promise<Instance | undefined>
  status(userId: string): Promise<UserStatus>
  endpointFor(userId: string): Promise<Endpoint | undefined>
  stop(userId: string): Promise<void>
  teardown(): Promise<void>
  /** Make the user's file sidecar exist and be ready (k8s). No-op under local,
   * where the control plane touches the volume in-process. */
  ensureFileService(userId: string): Promise<void>
}

/**
 * What idle reaping does to a user's desired `dsh_instances` row
 * (docs/plan/cubesandbox-backend.md §9).
 *
 * - `release` (k8s): drop the row and stop the workload. The next request
 *   cold-starts.
 * - `retain` (cubesandbox): keep the row and mark it `paused`. The row *is* the
 *   user's long-lived claim on their sandbox; the next request resumes the
 *   whole-machine snapshot, which is what makes the sandbox per-user instead of
 *   per-session.
 */
export type IdlePolicy = 'release' | 'retain'

/**
 * The part of a live-instance watcher the controller uses. Declared structurally
 * so this shared module imports no cluster client; `@kubernetes/client-node`'s
 * `Informer` satisfies it, as does the sandbox backend's polling adapter.
 */
export interface LiveWatcher {
  start(): Promise<unknown>
  stop(): Promise<unknown>
}

/**
 * The lifecycle seam the leader-only reconcile controller depends on.
 *
 * Kept separate from {@link Spawner} so `LocalSpawner` need not implement — and
 * must not fake — cluster supervision. `ReconcileController` used to take the
 * concrete `K8sSpawner`, which is what made a second supervised backend
 * impossible (docs/plan/cubesandbox-backend.md §8).
 */
export interface SupervisedSpawner extends Spawner {
  /** See {@link IdlePolicy} — the backend, not the controller, decides. */
  readonly idlePolicy: IdlePolicy
  /** The live side of `planReconcile`. */
  listUserPods(): Promise<LivePod[]>
  /** Recreate a lost per-user resource (k8s: Service/NetworkPolicy; sandbox:
   * the volume). Called every tick for every desired instance. */
  ensureUserResources(userId: string): Promise<void>
  /** Watch live instances; `callback` fires with their state (best-effort — the
   * reconcile tick still converges if the watch never starts). */
  watchMainPods(callback: (pod: LivePod) => void): LiveWatcher
  /** Stamp the current leader's fencing token onto resources created from now
   * on (see `K8sSpawner.setFencing`). */
  setFencing(fencing: Fencing | undefined): void
  /** Best-effort error surface for the tick loop. */
  logError?(err: unknown): void
}

/**
 * Runtime check for the one cast the wiring cannot avoid: `buildServer` returns
 * a {@link Spawner}, but only *some* deploy modes have a supervised one.
 *
 * This replaces a blind `as K8sSpawner` in the CLI, which would have produced a
 * controller that fails confusingly at the first tick instead of at startup.
 */
export function isSupervisedSpawner(value: Spawner): value is SupervisedSpawner {
  const candidate = value as Partial<SupervisedSpawner>
  return (
    typeof candidate.listUserPods === 'function' &&
    typeof candidate.ensureUserResources === 'function' &&
    typeof candidate.watchMainPods === 'function' &&
    typeof candidate.setFencing === 'function' &&
    typeof candidate.idlePolicy === 'string'
  )
}
