// Reconcile tests (node:test) — the P2 headline semantics, driven end to end
// through the leader-only controller with fakes only (no cluster, no sandbox):
//
//   1. planReconcile is a pure diff; `paused` must stop meaning "missing".
//   2. Idle reaping asks the *backend* what happens to the desired row
//      (IdlePolicy): `release` drops it, `retain` marks it `paused` and keeps it.
//      That single branch is the difference between per-session and per-user.
//   3. `local`/`k8s` behaviour is unchanged: a release backend still drops the row.
//
// Runs against the built `lib/` output — `npm test` builds first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ReconcileController, planReconcile } from '../lib/supervisor/reconcile.js'
import { isSupervisedSpawner } from '../lib/supervisor/spawner.js'

const row = (over = {}) => ({
  id: 'dsh-u1',
  userId: 'u1',
  workspaceId: null,
  role: 'main',
  pid: null,
  port: null,
  status: 'running',
  startedAt: null,
  lastExit: null,
  exitCode: null,
  lastError: null,
  folder: '/ws',
  patch: null,
  ...over,
})
const live = (over = {}) => ({ name: 'dsh-u1', userId: 'u1', running: true, crashed: false, ...over })

// --- 1. the pure diff ------------------------------------------------------

test('planReconcile: an absent instance is relaunched, a running one is not', () => {
  assert.deepEqual(planReconcile([row()], []).launch.map((i) => i.id), ['dsh-u1'])
  assert.deepEqual(planReconcile([row()], [live()]), { launch: [], delete: [], markRunning: [] })
})

test('planReconcile: a paused row whose instance is paused is NOT relaunched', () => {
  const plan = planReconcile([row({ status: 'paused' })], [live({ running: false })])
  assert.deepEqual(plan, { launch: [], delete: [], markRunning: [] }, 'paused is the intended steady state')
})

test('planReconcile: a paused row whose instance is running was resumed out of band', () => {
  const plan = planReconcile([row({ status: 'paused' })], [live()])
  assert.deepEqual(plan.markRunning.map((i) => i.id), ['dsh-u1'])
  assert.deepEqual(plan.launch, [], 'and is not relaunched either')
})

test('planReconcile: a crashed instance is relaunched even when the row says paused', () => {
  const plan = planReconcile([row({ status: 'paused' })], [live({ running: false, crashed: true })])
  assert.deepEqual(plan.launch.map((i) => i.id), ['dsh-u1'])
})

test('planReconcile: a paused row still claims its instance (no orphan delete)', () => {
  const plan = planReconcile([row({ status: 'paused' })], [live({ running: false })])
  assert.deepEqual(plan.delete, [], 'the row is the claim, so the instance is not an orphan')
  // …and with the row gone, the same instance IS an orphan.
  assert.deepEqual(planReconcile([], [live({ running: false })]).delete.map((p) => p.name), ['dsh-u1'])
})

test('planReconcile: only main rows are reconciled', () => {
  const plan = planReconcile([row({ id: 'dsh-u1-watchdog', role: 'watchdog' })], [])
  assert.deepEqual(plan.launch, [])
})

// --- 2. the capability guard ----------------------------------------------

test('isSupervisedSpawner accepts a supervised backend and rejects a bare one', () => {
  const supervised = {
    launch: async () => {},
    stop: async () => {},
    listUserPods: async () => [],
    ensureUserResources: async () => {},
    watchMainPods: () => ({ start: async () => {}, stop: async () => {} }),
    setFencing: () => {},
    idlePolicy: 'retain',
  }
  assert.equal(isSupervisedSpawner(supervised), true)
  assert.equal(isSupervisedSpawner({ ...supervised, listUserPods: undefined }), false)
  assert.equal(isSupervisedSpawner({ ...supervised, idlePolicy: undefined }), false)
  // LocalSpawner: a real Spawner, not a supervised one.
  assert.equal(isSupervisedSpawner({ launch: async () => {}, stop: async () => {} }), false)
})

// --- 3. the controller: idle reap asks the backend --------------------------

/** A recording fake supervisor with a selectable idle policy.
 *
 * `livePods` is what the tick's live side sees: pass the matching `live()` entry
 * when the instance exists, `[]` when it is missing. */
function fakeSupervisor(policy, livePods = []) {
  const journal = { stopped: [], ensured: [], fences: [] }
  return {
    journal,
    idlePolicy: policy,
    async launch() {},
    async restartMain() {},
    async spawnWatchdog() {},
    async status() {
      return {}
    },
    async endpointFor() {},
    async stop(userId) {
      journal.stopped.push(userId)
    },
    async teardown() {},
    async ensureFileService() {},
    async ensureUserResources(userId) {
      journal.ensured.push(userId)
    },
    async listUserPods() {
      return livePods
    },
    watchMainPods() {
      return { start: async () => {}, stop: async () => {} }
    },
    setFencing(fencing) {
      journal.fences.push(fencing)
    },
    logError() {},
  }
}

/** A recording fake DB whose instance rows are mutable (so tick 2 sees tick 1). */
function fakeDb(instances, activeSessions = []) {
  const rows = new Map(instances.map((i) => [i.id, { ...i }]))
  const journal = { paused: [], running: [], deleted: [] }
  return {
    rows,
    journal,
    async listInstancesByRole(role) {
      return [...rows.values()].filter((i) => i.role === role)
    },
    async hasActiveSession(userId) {
      return activeSessions.includes(userId)
    },
    async setInstanceStatus(id, status) {
      journal[status === 'paused' ? 'paused' : 'running'].push(id)
      const current = rows.get(id)
      if (current !== undefined) current.status = status
      return true
    },
    async deleteInstance(id) {
      journal.deleted.push(id)
      return rows.delete(id)
    },
  }
}

/** A fake elector that becomes leader on start (the controller takes a
 * LeaderElector; tests are plain JS, so structural is enough). */
function fakeElector() {
  let started
  return {
    setLeadershipCallbacks(onStarted) {
      started = onStarted
    },
    async start() {
      started?.({ holder: 'pod-1', operationId: 1 })
    },
    stop() {},
  }
}

/** Wait for a condition instead of sleeping a fixed amount (no flaky timing). */
async function waitFor(predicate, what, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('idle reap with a RETAINING backend pauses and KEEPS the desired row', async () => {
  const db = fakeDb([row()])
  const spawner = fakeSupervisor('retain', [live()])
  const controller = new ReconcileController(db, spawner, fakeElector(), 10_000)
  try {
    await controller.start()
    await waitFor(() => db.journal.paused.length > 0, 'the row to be marked paused')

    assert.deepEqual(spawner.journal.stopped, ['u1'], 'idle means stop (which the sandbox backend turns into a pause)')
    assert.deepEqual(db.journal.paused, ['dsh-u1'], 'the row survives as `paused`')
    assert.deepEqual(db.journal.deleted, [], 'and is NOT dropped — that would cold-start the user')
    assert.deepEqual(spawner.journal.ensured, ['u1'], 'per-user resources are still ensured')
    assert.deepEqual(spawner.journal.fences, [{ holder: 'pod-1', operationId: 1 }], 'the fence is passed through')
  } finally {
    controller.stop()
  }
})

test('idle reap with a RELEASING backend still drops the row (k8s unchanged)', async () => {
  const db = fakeDb([row()])
  const spawner = fakeSupervisor('release', [live()])
  const controller = new ReconcileController(db, spawner, fakeElector(), 10_000)
  try {
    await controller.start()
    await waitFor(() => db.journal.deleted.length > 0, 'the row to be dropped')

    assert.deepEqual(spawner.journal.stopped, ['u1'])
    assert.deepEqual(db.journal.deleted, ['dsh-u1'])
    assert.deepEqual(db.journal.paused, [], 'a releasing backend never writes `paused`')
  } finally {
    controller.stop()
  }
})

test('idle reap leaves a user with an active session alone', async () => {
  const db = fakeDb([row()], ['u1'])
  const spawner = fakeSupervisor('retain', [live()])
  const controller = new ReconcileController(db, spawner, fakeElector(), 10_000)
  try {
    await controller.start()
    await waitFor(() => spawner.journal.ensured.length > 0, 'the tick to reach the reap step')

    assert.deepEqual(spawner.journal.stopped, [])
    assert.deepEqual(db.journal.paused, [])
    assert.deepEqual(db.journal.deleted, [])
  } finally {
    controller.stop()
  }
})

test('an already-paused row is not rewritten on every subsequent tick', async () => {
  const db = fakeDb([row({ status: 'paused' })])
  const spawner = fakeSupervisor('retain', [live({ running: false })])
  // Short interval so several ticks run; the guard must keep the write count at 1
  // — i.e. the first tick pauses, later ticks skip the row entirely.
  const controller = new ReconcileController(db, spawner, fakeElector(), 5)
  try {
    await controller.start()
    await waitFor(() => spawner.journal.ensured.length >= 3, 'several ticks to run')

    assert.deepEqual(db.journal.paused, [], 'nothing to pause: the row is already paused')
    assert.deepEqual(spawner.journal.stopped, [], 'and the sandbox is not re-paused')
  } finally {
    controller.stop()
  }
})

test('observing a paused row running again converges it back to running', async () => {
  const db = fakeDb([row({ status: 'paused' })])
  // The platform resumed it: the live side reports running for a `paused` row.
  const spawner = fakeSupervisor('retain', [live()])
  const controller = new ReconcileController(db, spawner, fakeElector(), 10_000)
  try {
    await controller.start()
    await waitFor(() => db.journal.running.length > 0, 'the row to be marked running')

    assert.deepEqual(db.journal.running, ['dsh-u1'])
    assert.deepEqual(db.journal.paused, [], 'it is not paused again while it is observed running')
  } finally {
    controller.stop()
  }
})
