/**
 * {@link UserFs} factory. Picks the implementation from `deployMode`, the same
 * way {@link createDbAdapter} picks a DB backend and `buildServer` picks a
 * {@link Spawner}.
 * @module dsh-server-login/fs/provider
 */

import type { ServerConfig } from '../config.js'
import type { Endpoint } from '../supervisor/spawner.js'
import { FILE_SERVICE_PORT } from '../web/file-service.js'
import { K8sUserFs, type EnsureFileService } from './k8s-user-fs.js'
import { LocalUserFs } from './local-user-fs.js'
import type { UserFs } from './user-fs.js'
import { userRoot } from './workspace.js'

/** Headless Service fronting a user's file sidecar (docs/k8s.md §4.10). */
export function fileServiceName(userId: string): string {
  return `dsh-files-${userId}`
}

/** In-cluster address of a user's file sidecar. */
export function fileServiceEndpoint(namespace: string, userId: string): Endpoint {
  return { host: `${fileServiceName(userId)}.${namespace}.svc.cluster.local`, port: FILE_SERVICE_PORT }
}

/**
 * Build the configured per-user filesystem.
 *
 * `local` touches the users volume in-process. `k8s` delegates to each user's
 * file sidecar, which the spawner brings up on demand via `ensureFileService`.
 * `cubesandbox` has neither yet — see the throw below.
 */
export function createUserFs(config: ServerConfig, ensureFileService?: EnsureFileService): UserFs {
  if (config.deployMode === 'k8s' && ensureFileService !== undefined) {
    return new K8sUserFs(ensureFileService, (userId) => fileServiceEndpoint(config.k8sNamespace, userId))
  }
  if (config.deployMode === 'cubesandbox') {
    // Under the sandbox backend the user's files live on the sandbox **volume**,
    // not under `dataRoot` — the control plane holds no user volume, exactly as
    // under k8s. Falling through to `LocalUserFs` would silently serve the wrong
    // disk (empty, control-plane-local directories), so refuse instead of
    // guessing. Needs a client-backed `UserFs`; phase P3.
    throw new Error(
      'the cubesandbox backend has no UserFs yet (phase P3 — see docs/plan/cubesandbox-backend.md §10/§14); its files live on the sandbox volume, not under dataRoot',
    )
  }
  return new LocalUserFs((userId) => userRoot(config.dataRoot, userId))
}
