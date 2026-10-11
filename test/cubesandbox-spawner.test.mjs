// CubesandboxSpawner unit tests against a fake SandboxClient — the whole
// per-user lifecycle with no sandbox node in sight (docs/plan/cubesandbox-backend.md
// §13). The load-bearing assertions are that `stop` PAUSES (never destroys, never
// drops the desired row) and that the in-sandbox dsh argv keeps `--patch` ahead
// of `--host`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CubesandboxSpawner } from '../lib/supervisor/cubesandbox-spawner.js'
import { FakeSandboxClient } from '../lib/sandbox/fake-client.js'
import { SandboxNotFoundError } from '../lib/sandbox/client.js'
import { resolveConfig } from '../lib/config.js'
import { AlreadyRunningError } from '../lib/supervisor/spawner.js'
import { planReconcile } from '../lib/supervisor/reconcile.js'

const PATCH = '- insert:\n    - id: dsh-server-login-runtime\n      name: dsh-server-login/runtime\n'
const USER_ROOT = '/var/lib/dsh-server-login/users/u1'

/** Undo the `sh -c` single-quote escaping so a command can be asserted exactly. */
function unquote(command) {
  return command
    .replace(/^sh -c /, '')
    .replace(/^'/, '')
    .replace(/'$/, '')
    .replaceAll("'\\''", "'")
}

/** A spawner plus its fake client and a recording DB stub. */
function build(options = {}) {
  const client = options.client ?? new FakeSandboxClient(options.fake ?? {})
  const config = resolveConfig({
    // Present so resolveConfig does not write <dataRoot>/secret.key.
    encryptionSecret: 'test-secret',
    enablePatch: options.enablePatch ?? true,
    cubesandbox: { template: 'tpl-dsh:1', endpoint: 'https://cube.test:3000', ...(options.sandbox ?? {}) },
  })
  const rows = new Map()
  const journals = { upserts: [], deletes: [] }
  const db = {
    async upsertInstance(input) {
      journals.upserts.push(input)
      rows.set(input.id, input)
    },
    async findUserInstance(userId, role) {
      return [...rows.values()].find((row) => row.userId === userId && row.role === role)
    },
    async deleteInstance(id) {
      journals.deletes.push(id)
      return rows.delete(id)
    },
  }
  return { config, db, journals, rows, client, spawner: new CubesandboxSpawner(config, db, async () => 'sk-test', client) }
}

test('cube: launch creates the sandbox with volume/env/patch and starts dsh', async () => {
  const { client, journals, spawner } = build()
  const inst = await spawner.launch('u1', '/ws/proj', PATCH)
  assert.equal(inst.id, 'dsh-u1')

  const sb = client.sandboxes.get('dsh-u1')
  assert.ok(sb, 'sandbox created')
  assert.equal(sb.spec.template, 'tpl-dsh:1')
  assert.deepEqual(sb.spec.volumes, [{ name: 'dsh-vol-u1', mountPath: USER_ROOT }])
  assert.equal(sb.spec.env.HOME, `${USER_ROOT}/ws`)
  assert.equal(sb.spec.env.DSH_HOME, `${USER_ROOT}/home`)
  assert.equal(sb.spec.env.DEEPSEEK_API_KEY, 'sk-test')
  assert.equal(sb.spec.files['/etc/dsh/patch.yml'], PATCH, 'patch delivered as content, not a path')
  assert.deepEqual(sb.spec.labels, { app: 'dsh', user: 'u1', 'dsh.io/managed-by': 'dsh-server-login' })
  assert.ok(client.volumes.has('dsh-vol-u1'), 'volume ensured before the mount')

  assert.equal(journals.upserts.length, 1, 'desired row recorded for reconcile')
  assert.equal(journals.upserts[0].id, 'dsh-u1')

  const start = client.execCalls.at(-1)
  assert.equal(start.opts.background, true, 'dsh runs detached')
  const startScript = unquote(start.command)
  assert.match(startScript, /^printf %s \$\$ > \/run\/dsh\.pid && exec /)
  assert.ok(startScript.includes("'--profile' 'web'"))

  await assert.rejects(() => spawner.launch('u1', '/ws/proj'), AlreadyRunningError)
})

test('cube: the in-sandbox argv keeps --patch ahead of --host/--port', async () => {
  const { client, spawner } = build()
  await spawner.launch('u1', '/ws', PATCH)
  const script = unquote(client.execCalls.at(-1).command)
  // Exact lock: `--patch` is a launcher flag, so it must follow `--profile web`
  // and precede `--host`/`--port` (orchestrator.ts:164-177).
  assert.match(
    script,
    /^printf %s \$\$ > \/run\/dsh\.pid && exec 'dsh' '--profile' 'web' '--patch' '\/etc\/dsh\/patch\.yml' '--host' '127\.0\.0\.1' '--port' '8080'$/,
  )
})

test('cube: launch fails loudly without a sandbox template', async () => {
  const { spawner } = build({ sandbox: { template: '' } })
  await assert.rejects(() => spawner.launch('u1', '/ws'), /CUBESANDBOX_TEMPLATE/)
})

test('cube: launch on a paused sandbox resumes it instead of creating a second one', async () => {
  const { client, spawner } = build()
  await spawner.launch('u1', '/ws', PATCH)
  client.setState('dsh-u1', 'paused')
  client.execCalls.length = 0

  const inst = await spawner.launch('u1', '/ws', PATCH)
  assert.equal(inst.status, 'running')
  assert.deepEqual(client.resumed, ['dsh-u1'])
  assert.equal(client.sandboxes.size, 1, 'no second sandbox')
  assert.equal(client.execCalls.length, 1, 'only the liveness probe runs')
  assert.match(client.execCalls[0].command, /kill -0/)
  assert.ok(
    !client.execCalls.some((call) => call.command.includes('printf %s')),
    'the snapshot kept dsh alive → no restart',
  )
})

test('cube: waking a paused sandbox restarts dsh when the snapshot lost it', async () => {
  const { client, spawner } = build()
  await spawner.launch('u1', '/ws', PATCH)
  client.setState('dsh-u1', 'paused')
  client.execCalls.length = 0
  client.execExitCode = 1 // `kill -0` finds nothing

  await spawner.launch('u1', '/ws', PATCH)
  assert.equal(client.execCalls.length, 2, 'probe, then start')
  assert.match(client.execCalls[0].command, /kill -0/)
  assert.match(client.execCalls.at(-1).command, /printf %s \$\$ > \/run\/dsh\.pid/)
})

test('cube: endpointFor maps running and paused, and lets real failures through', async () => {
  const { client, spawner } = build()
  assert.equal(await spawner.endpointFor('u1'), undefined, 'absent → undefined')

  await spawner.launch('u1', '/ws')
  assert.deepEqual(await spawner.endpointFor('u1'), { host: '10.0.0.5', port: 30001 })
  client.setState('dsh-u1', 'paused')
  assert.deepEqual(
    await spawner.endpointFor('u1'),
    { host: '10.0.0.5', port: 30001 },
    'paused keeps its address so the next request can wake it',
  )
  client.setState('dsh-u1', 'error')
  assert.equal(await spawner.endpointFor('u1'), undefined, 'an errored sandbox is not dialable')

  client.failNext('info', new SandboxNotFoundError('dsh-u1'))
  assert.equal(await spawner.endpointFor('u1'), undefined, 'a thrown not-found still means "absent"')

  const forbidden = new Error('forbidden')
  forbidden.code = 403
  client.failNext('info', forbidden)
  await assert.rejects(() => spawner.endpointFor('u1'), (err) => err.code === 403, '403 is not "not running"')
})

test("cube: stop PAUSES — the sandbox and the desired row both survive", async () => {
  const { client, journals, spawner } = build()
  await spawner.launch('u1', '/ws')
  await spawner.stop('u1')

  assert.deepEqual(client.paused, ['dsh-u1'])
  assert.deepEqual(client.destroyed, [], 'stop must not destroy the sandbox')
  assert.equal(client.sandboxes.get('dsh-u1').state, 'paused')
  assert.deepEqual(journals.deletes, [], "the desired row is the user's long-lived claim (§9)")

  await spawner.stop('u1') // idempotent
  assert.deepEqual(client.paused, ['dsh-u1'])
})

test('cube: status maps sandbox states (paused → stopped until the P2 migration)', async () => {
  const { client, spawner } = build()
  assert.deepEqual(await spawner.status('u1'), {}, 'absent → empty status')

  await spawner.launch('u1', '/ws')
  assert.equal((await spawner.status('u1')).main.status, 'running')
  client.setState('dsh-u1', 'paused')
  // Deliberate P1 mapping: `paused` is in neither `InstanceStatus` nor the two
  // `dsh_instances.status` CHECKs. P2 adds it to all four mirrors (§7) and
  // flips this assertion to 'paused'.
  assert.equal((await spawner.status('u1')).main.status, 'stopped')
  client.setState('dsh-u1', 'error')
  assert.equal((await spawner.status('u1')).main.status, 'crashed')
})

test('cube: restartMain restarts dsh inside the same sandbox (no destroy)', async () => {
  const { client, spawner } = build()
  assert.equal(await spawner.restartMain('u1'), undefined, 'no desired row → nothing to restart')

  await spawner.launch('u1', '/ws', PATCH)
  client.execCalls.length = 0
  const inst = await spawner.restartMain('u1')
  assert.equal(inst.id, 'dsh-u1')
  assert.equal(client.sandboxes.size, 1)
  assert.deepEqual(client.destroyed, [], 'restart never destroys the sandbox')
  assert.match(client.execCalls[0].command, /kill "\$\(cat \/run\/dsh\.pid/)
  assert.match(client.execCalls.at(-1).command, /printf %s \$\$ > \/run\/dsh\.pid/)
})

test('cube: restartMain recreates a sandbox the node lost, keeping the volume', async () => {
  const { client, spawner } = build()
  await spawner.launch('u1', '/ws', PATCH)
  client.sandboxes.delete('dsh-u1')

  const inst = await spawner.restartMain('u1')
  assert.equal(inst.id, 'dsh-u1')
  assert.ok(client.sandboxes.has('dsh-u1'), 'sandbox recreated')
  assert.ok(client.volumes.has('dsh-vol-u1'), 'the user volume was never dropped')
})

test('cube: spawnWatchdog runs the headless task inside the same sandbox', async () => {
  const { client, spawner } = build()
  assert.equal(await spawner.spawnWatchdog('u1'), undefined, 'no sandbox → no watchdog')

  await spawner.launch('u1', '/ws', PATCH)
  client.execCalls.length = 0
  const inst = await spawner.spawnWatchdog('u1')
  assert.equal(inst.role, 'watchdog')
  assert.equal(inst.id, 'dsh-u1-watchdog')

  const call = client.execCalls.at(-1)
  assert.equal(call.opts.background, true)
  assert.ok(call.command.includes("'--profile' 'headless'"))
  assert.equal(call.opts.env.DSH_SERVER_LOGIN_ROLE, 'watchdog')
  assert.equal(call.opts.env.DSH_SERVER_LOGIN_HANDOFF_PATH, `${USER_ROOT}/handoff.json`)
})

test('cube: spawnWatchdog is a no-op without the runtime patch', async () => {
  const { spawner } = build({ enablePatch: false })
  assert.equal(await spawner.spawnWatchdog('u1'), undefined)
})

test('cube: ensureFileService is idempotent', async () => {
  const { client, spawner } = build()
  await spawner.ensureFileService('u1')
  await spawner.ensureFileService('u1')
  assert.deepEqual(client.volumeCalls, ['dsh-vol-u1', 'dsh-vol-u1'])
  assert.deepEqual([...client.volumes], ['dsh-vol-u1'], 'one volume, created once')
})

test('cube: teardown destroys every owned sandbox and keeps the volumes', async () => {
  const { client, spawner } = build()
  await spawner.launch('u1', '/ws')
  await spawner.launch('u2', '/ws')
  await spawner.launch('u3', '/ws')
  client.setState('dsh-u3', 'paused')

  await spawner.teardown()
  assert.deepEqual(client.destroyed.slice().sort(), ['dsh-u1', 'dsh-u2', 'dsh-u3'])
  assert.deepEqual([...client.volumes].sort(), ['dsh-vol-u1', 'dsh-vol-u2', 'dsh-vol-u3'], 'workspaces survive')
  assert.equal(client.sandboxes.size, 0)
})

test('cube: listLiveInstances feeds planReconcile', async () => {
  const { client, rows, spawner } = build()
  await spawner.launch('u1', '/ws')

  const live = await spawner.listLiveInstances()
  assert.deepEqual(
    live.map((entry) => [entry.name, entry.userId, entry.running, entry.crashed]),
    [['dsh-u1', 'u1', true, false]],
  )
  assert.deepEqual(planReconcile([rows.get('dsh-u1')], live), { launch: [], delete: [] }, 'a running sandbox is not relaunched')

  // P2 decides the `paused` verdict (a paused row must stop counting as
  // "missing"); P1 only pins the shape it maps.
  client.setState('dsh-u1', 'paused')
  assert.deepEqual((await spawner.listLiveInstances()).map((entry) => entry.running), [false])
})

test('cube: launch replaces a sandbox stuck in the error state', async () => {
  const { client, spawner } = build()
  await spawner.launch('u1', '/ws')
  client.setState('dsh-u1', 'error')

  await spawner.launch('u1', '/ws')
  assert.deepEqual(client.destroyed, ['dsh-u1'])
  assert.equal(client.sandboxes.size, 1, 'recreated')
})

test('cube: launch gives up when the sandbox never reaches running', async () => {
  const { spawner } = build({ sandbox: { readyTimeoutMs: 0 }, fake: { bootState: 'starting' } })
  await assert.rejects(() => spawner.launch('u1', '/ws'), /not running within 0ms/)
})
