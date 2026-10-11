/**
 * Leader-only controller: reconciles the cluster against the desired state in
 * `dsh_instances` (docs/k8s.md §5.7) and watches the main DSH instances for
 * crashes.
 *
 * Under a supervised backend there is no child-process `exit` event the way the
 * local backend has — a crashed instance is observed either by the watch (here)
 * or by the next reconcile tick (a desired main whose instance is gone). Both
 * funnel into the same repair path: mark the instance crashed, pull up the
 * one-shot watchdog Job, and let the reconcile relaunch the main if it stays
 * absent.
 *
 * The coupling is to {@link SupervisedSpawner} — the *capabilities* — not to a
 * concrete backend, so `K8sSpawner` and `CubesandboxSpawner` share one
 * controller (docs/plan/cubesandbox-backend.md §8).
 * @module dsh-server-login/supervisor/reconcile
 */

import type { DbAdapter } from '../db/adapter.js'
import type { DshInstance } from '../db/types.js'
import type { LeaderElector } from './leader.js'
import type { LivePod, LiveWatcher, SupervisedSpawner } from './spawner.js'

/** The result of diffing desired state against live instances. Pure and testable. */
export interface ReconcilePlan {
  /** Desired mains whose instance is missing (or crashed) → relaunch. */
  launch: DshInstance[]
  /** Live instances with no desired row → delete (orphans). */
  delete: LivePod[]
  /** Rows still marked `paused` whose instance is observed running again →
   * record the resume. Empty for a `release` backend, which never writes
   * `paused`. */
  markRunning: DshInstance[]
}

/** Diff desired mains vs live instances. */
export function planReconcile(desired: DshInstance[], live: LivePod[]): ReconcilePlan {
  const liveByUser = new Map(live.map((pod) => [pod.userId, pod]))
  const launch: DshInstance[] = []
  const markRunning: DshInstance[] = []
  for (const instance of desired) {
    if (instance.role !== 'main') continue
    const pod = liveByUser.get(instance.userId)
    if (pod === undefined) {
      launch.push(instance)
      continue
    }
    if (pod.running) {
      // Observed running. A row that still says `paused` was resumed out of band
      // — the platform's AutoResume, triggered by the user's next request — so
      // record it; otherwise `paused` would be sticky and the next idle period
      // could never reap this instance.
      if (instance.status === 'paused') markRunning.push(instance)
      continue
    }
    // Present but not running: a *paused* row is the intended steady state for a
    // retaining backend (the whole-machine snapshot is the point), so it must not
    // be relaunched every tick. A crash still is.
    if (instance.status === 'paused' && !pod.crashed) continue
    launch.push(instance)
  }
  const desiredUsers = new Set(desired.filter((i) => i.role === 'main').map((i) => i.userId))
  const del = live.filter((pod) => !desiredUsers.has(pod.userId))
  return { launch, delete: del, markRunning }
}

/** Loop that reconciles only while leader, plus a live-instance watch for
 * crashes. The watch is a {@link LiveWatcher}, not a k8s informer: each backend
 * supplies its own (k8s: informer; sandbox: polling adapter). */
export class ReconcileController {
  private informer: LiveWatcher | undefined
  private timer: NodeJS.Timeout | undefined
  private leading = false
  private readonly watchdogFired = new Set<string>()
  private readonly intervalMs: number

  constructor(
    private readonly db: DbAdapter,
    private readonly spawner: SupervisedSpawner,
    private readonly elector: LeaderElector,
    intervalMs = 10_000,
  ) {
    this.intervalMs = intervalMs
    elector.setLeadershipCallbacks(
      (fencing) => {
        this.leading = true
        this.spawner.setFencing(fencing)
        this.startInformer()
        this.scheduleTick(0)
      },
      () => {
        this.leading = false
        this.stopInformer()
      },
    )
  }

  async start(): Promise<void> {
    await this.elector.start()
  }

  stop(): void {
    this.elector.stop()
    this.stopInformer()
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private startInformer(): void {
    if (this.informer !== undefined) return
    this.informer = this.spawner.watchMainPods((pod) => this.onPodEvent(pod))
    void this.informer.start().catch(() => {
      // The informer is best-effort; the reconcile tick still converges.
      this.informer = undefined
    })
  }

  private stopInformer(): void {
    void this.informer?.stop().catch(() => {})
    this.informer = undefined
  }

  private scheduleTick(delayMs: number): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.leading) return
      void this.tick().finally(() => this.scheduleTick(this.intervalMs))
    }, delayMs)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    const [desired, live] = await Promise.all([
      this.db.listInstancesByRole('main'),
      this.spawner.listUserPods(),
    ])
    const plan = planReconcile(desired, live)

    for (const orphan of plan.delete) {
      // Orphan = a main Pod with no desired row (user deleted or disabled).
      await this.safe(`orphan ${orphan.userId}`, async () => {
        await this.db.deleteInstance(orphan.name)
        await this.spawner.stop(orphan.userId)
      })
    }
    for (const instance of plan.launch) {
      await this.safe(`launch ${instance.userId}`, () =>
        this.spawner.launch(instance.userId, instance.folder ?? '', instance.patch ?? undefined))
    }
    // Recreate a lost Service/NetworkPolicy for any desired main that still has a Pod.
    for (const instance of desired) {
      if (plan.launch.includes(instance)) continue
      await this.safe(`ensure ${instance.userId}`, () => this.spawner.ensureUserResources(instance.userId))
    }
    // Idle reap (Phase 4): a desired main whose user has no active session has
    // outlived its session TTL. What that does to the desired row is the
    // backend's call, via {@link IdlePolicy}: k8s drops the row (the next
    // request cold-starts); a retaining backend keeps it and marks it `paused`
    // (the next request resumes the snapshot) — docs/plan/cubesandbox-backend.md
    // §9. That one branch is the difference between per-session and per-user.
    for (const instance of desired) {
      if (instance.status === 'paused') continue // already reaped — do not rewrite it every tick
      await this.safe(`reap ${instance.userId}`, async () => {
        if (await this.db.hasActiveSession(instance.userId)) return
        await this.spawner.stop(instance.userId)
        if (this.spawner.idlePolicy === 'retain') {
          await this.db.setInstanceStatus(instance.id, 'paused')
        } else {
          await this.db.deleteInstance(instance.id)
        }
      })
    }
    // Converge a stale `paused` row back to `running` when the instance is
    // observed running again (the platform resumed it). Runs after the reap so a
    // resume recorded this tick is reaped on the next one, once the user's
    // session has gone.
    for (const instance of plan.markRunning) {
      await this.safe(`resume ${instance.userId}`, () =>
        this.db.setInstanceStatus(instance.id, 'running'),
      )
    }
  }

  /** Run one per-user step without letting its failure abort the rest of the tick. */
  private async safe(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      // One bad user (e.g. a files Pod that can't become Ready) must not block
      // launches/idle-reap for every other user.
      this.spawner.logError?.(new Error(`reconcile ${label}: ${err instanceof Error ? err.message : String(err)}`))
    }
  }

  private async onPodEvent(pod: LivePod): Promise<void> {
    if (!pod.crashed || !pod.running) {
      // A healthy transition clears the "already fired" guard so a later crash
      // triggers the watchdog again.
      if (pod.running && !pod.crashed) this.watchdogFired.delete(pod.userId)
      return
    }
    if (this.watchdogFired.has(pod.userId)) return
    this.watchdogFired.add(pod.userId)
    try {
      await this.spawner.spawnWatchdog(pod.userId)
    } catch (err) {
      this.watchdogFired.delete(pod.userId)
      this.spawner.logError?.(err)
    }
  }
}
