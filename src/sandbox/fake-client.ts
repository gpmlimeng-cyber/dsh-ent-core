/**
 * In-memory {@link SandboxClient} for unit tests (and local dry-runs).
 *
 * This is the sandbox equivalent of the fake K8s API clients in
 * `test/k8s-spawner.test.mjs`: it makes the whole per-user lifecycle testable
 * without a sandbox node, which is why phases P1/P2 can be finished and gated
 * before any hardware exists (docs/plan/cubesandbox-backend.md §14).
 *
 * It is a **test double, not a backend**: nothing in the production wiring may
 * hand it to `CubesandboxSpawner` — the constructor takes the client as a
 * required parameter precisely so a deployment cannot silently fall back to it.
 * @module dsh-server-login/sandbox/fake-client
 */

import {
  SandboxNotFoundError,
  type ExecOptions,
  type ExecResult,
  type SandboxClient,
  type SandboxInfo,
  type SandboxSpec,
  type SandboxState,
} from './client.js'

export interface FakeSandboxOptions {
  /** Host every created sandbox reports (stand-in for the sandbox node). */
  host?: string
  /** First mapped port; each create takes the next one. */
  basePort?: number
  /** State a freshly created sandbox reports (default `running`, so tests do
   * not wait on a readiness loop). */
  bootState?: SandboxState
}

/** A stored sandbox plus the spec it was created from (asserted by tests). */
export interface FakeSandboxRecord extends SandboxInfo {
  spec: SandboxSpec
  execLog: string[]
}

interface FakeExecCall {
  id: string
  command: string
  opts: ExecOptions
}

/** A recorded call that changed a sandbox's lifecycle state. */
export class FakeSandboxClient implements SandboxClient {
  readonly sandboxes = new Map<string, FakeSandboxRecord>()
  readonly volumes = new Set<string>()
  /** Every `exec`, in order, across all sandboxes. */
  readonly execCalls: FakeExecCall[] = []
  readonly volumeCalls: string[] = []
  readonly paused: string[] = []
  readonly resumed: string[] = []
  readonly destroyed: string[] = []
  /** Exit code returned by a **foreground** `exec` (default 0). Set to 1 to
   * simulate a probe that finds nothing alive. */
  execExitCode = 0

  private readonly host: string
  private readonly basePort: number
  private readonly bootState: SandboxState
  private readonly failures = new Map<string, Error>()
  private seq = 0

  constructor(options: FakeSandboxOptions = {}) {
    this.host = options.host ?? '10.0.0.5'
    this.basePort = options.basePort ?? 30000
    this.bootState = options.bootState ?? 'running'
  }

  /** Make the next call to `op` (`create`/`info`/`pause`/… ) reject. */
  failNext(op: string, err: Error): void {
    this.failures.set(op, err)
  }

  /** Force a lifecycle state, standing in for the control plane's view. */
  setState(id: string, state: SandboxState): void {
    const record = this.sandboxes.get(id)
    if (record === undefined) throw new SandboxNotFoundError(id)
    record.state = state
  }

  async create(spec: SandboxSpec): Promise<SandboxInfo> {
    this.take('create')
    this.seq += 1
    const record: FakeSandboxRecord = {
      id: spec.name,
      name: spec.name,
      state: this.bootState,
      host: this.host,
      port: this.basePort + this.seq,
      labels: spec.labels,
      spec,
      execLog: [],
    }
    this.sandboxes.set(record.id, record)
    return record
  }

  async info(id: string): Promise<SandboxInfo | undefined> {
    this.take('info')
    return this.sandboxes.get(id)
  }

  async list(filter?: { labels?: Record<string, string> }): Promise<SandboxInfo[]> {
    this.take('list')
    const wanted = filter?.labels
    return [...this.sandboxes.values()].filter((record) => {
      if (wanted === undefined) return true
      return Object.entries(wanted).every(([key, value]) => record.labels?.[key] === value)
    })
  }

  async pause(id: string): Promise<void> {
    this.take('pause')
    const record = this.require(id)
    record.state = 'paused'
    this.paused.push(id)
  }

  async resume(id: string): Promise<void> {
    this.take('resume')
    const record = this.require(id)
    record.state = 'running'
    this.resumed.push(id)
  }

  async destroy(id: string): Promise<void> {
    this.take('destroy')
    this.require(id)
    this.sandboxes.delete(id)
    this.destroyed.push(id)
  }

  async exec(id: string, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.take('exec')
    const record = this.require(id)
    record.execLog.push(command)
    this.execCalls.push({ id, command, opts })
    return {
      exitCode: opts.background === true ? 0 : this.execExitCode,
      stdout: '',
      stderr: '',
      ...(opts.background === true ? { processId: `proc-${this.execCalls.length}` } : {}),
    }
  }

  async ensureVolume(name: string): Promise<void> {
    this.take('ensureVolume')
    this.volumes.add(name)
    this.volumeCalls.push(name)
  }

  private require(id: string): FakeSandboxRecord {
    const record = this.sandboxes.get(id)
    if (record === undefined) throw new SandboxNotFoundError(id)
    return record
  }

  private take(op: string): void {
    const err = this.failures.get(op)
    if (err !== undefined) {
      this.failures.delete(op)
      throw err
    }
  }
}
