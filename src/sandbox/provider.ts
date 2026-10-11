/**
 * {@link SandboxClient} factory — the seam that turns sandbox configuration into
 * a live client. Mirrors `src/fs/provider.ts` and `createDbAdapter`: the wiring
 * layer asks for a client and does not know how it talks to the platform.
 *
 * **Phase P3 fills this in.** Until then it throws rather than returning a stub,
 * for the same reason `CubesandboxSpawner` requires its client as a constructor
 * argument (`cubesandbox-spawner.ts:15-19`): a client that compiles but cannot
 * work would let a deployment be *configured* for a backend it can never run, and
 * the failure would surface as a confusing runtime error instead of at startup.
 * Throwing here means `deployMode: 'cubesandbox'` fails loudly and immediately,
 * with a message that says which phase is missing.
 *
 * The real client (REST or the `cubesandbox` SDK — **not** the `e2b` Python SDK,
 * which is hardcoded to e2b.cloud) is written only after the seven real-machine
 * assumptions in `docs/plan/cubesandbox-backend.md` §13 have readouts: writing it
 * earlier would encode unverified endpoint shapes as if they were knowledge.
 * @module dsh-server-login/sandbox/provider
 */

import type { ServerConfig } from '../config.js'
import type { SandboxClient } from './client.js'

/** Message shared by the startup failure and its test, so they cannot drift. */
export const SANDBOX_CLIENT_UNAVAILABLE =
  'the cubesandbox backend has no sandbox API client yet (phase P3 — see docs/plan/cubesandbox-backend.md §14); deploy with DSH_SERVER_LOGIN_DEPLOY_MODE=local or k8s meanwhile'

/** Build the sandbox control-plane client for this config. Phase P3. */
export function createSandboxClient(_config: ServerConfig): SandboxClient {
  throw new Error(SANDBOX_CLIENT_UNAVAILABLE)
}
