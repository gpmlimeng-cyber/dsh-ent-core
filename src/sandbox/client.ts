/**
 * Vendor-neutral sandbox-control surface (CubeSandbox).
 *
 * The `Spawner` implementations depend on **this interface**, never on a vendor
 * SDK, so the sandbox backends are unit-testable with no sandbox node in sight
 * (docs/plan/cubesandbox-backend.md §16.3). The real REST/SDK client is phase P3
 * — it needs a live control plane to be coded against and verified.
 *
 * Error discipline mirrors the k8s backend: **"absent" and "failed" are never
 * conflated.** {@link SandboxClient.info} returns `undefined` when the sandbox
 * does not exist, while a transport/auth failure throws — so a caller such as
 * `endpointFor` cannot report a 403 as "not running" (compare
 * `k8s-spawner.ts:237-253`).
 * @module dsh-server-login/sandbox/client
 */

/** Lifecycle state as reported by the sandbox control plane. */
export type SandboxState = 'starting' | 'running' | 'paused' | 'error'

/** A named volume mounted into a sandbox. */
export interface SandboxVolumeMount {
  name: string
  mountPath: string
  readOnly?: boolean
}

/** Everything needed to bring one sandbox up. */
export interface SandboxSpec {
  /** Deterministic name; the caller reuses it so `create` is idempotent-by-key. */
  name: string
  /** Template the sandbox is created from (must carry the DSH CLI). */
  template: string
  /** Environment for the sandbox's own processes. */
  env?: Record<string, string>
  /** Volumes to attach — already ensured via {@link SandboxClient.ensureVolume}. */
  volumes?: SandboxVolumeMount[]
  /** Files written after boot, keyed by absolute path inside the sandbox. */
  files?: Record<string, string>
  /** Labels for ownership/selection; `list` filters on these. */
  labels?: Record<string, string>
  /** Boot budget for this sandbox, in ms. */
  timeoutMs?: number
}

/** A sandbox as observed by the control plane. */
export interface SandboxInfo {
  id: string
  name: string
  state: SandboxState
  /** Host the DSH proxy can dial (sandbox node / preview host). */
  host?: string
  /** Host port mapped to the sandbox's DSH listener. */
  port?: number
  labels?: Record<string, string>
}

export interface ExecOptions {
  /** Detach and return immediately — used for the long-running DSH servers. */
  background?: boolean
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  /** Handle for a background command, when the backend assigns one. */
  processId?: string
}

/** Raised by `pause`/`resume`/`destroy`/`exec` when the sandbox is gone. */
export class SandboxNotFoundError extends Error {
  constructor(id: string) {
    super(`sandbox ${id} not found`)
    this.name = 'SandboxNotFoundError'
  }
}

/**
 * The control-plane surface every sandbox backend implements.
 *
 * The per-user (long-lived) and per-task (one-shot) lifecycles share this one
 * interface and differ only in lifecycle policy, which lives in the
 * spawner/service layer — that separation is what keeps one-shot tasks out of
 * `Spawner` (docs/plan/cubesandbox-backend.md §6).
 */
export interface SandboxClient {
  create(spec: SandboxSpec): Promise<SandboxInfo>
  /** `undefined` means "no such sandbox"; any other failure throws. */
  info(id: string): Promise<SandboxInfo | undefined>
  list(filter?: { labels?: Record<string, string> }): Promise<SandboxInfo[]>
  /** Suspend with memory + filesystem snapshotted. **Not** a destroy. */
  pause(id: string): Promise<void>
  resume(id: string): Promise<void>
  destroy(id: string): Promise<void>
  exec(id: string, command: string, opts?: ExecOptions): Promise<ExecResult>
  /** Idempotent. Volumes outlive their sandboxes — they hold user workspaces. */
  ensureVolume(name: string): Promise<void>
}
