/**
 * Schema migrations, dual-dialect. Each migration carries SQLite and Postgres
 * DDL; the active adapter runs only its own dialect. `schema_migrations` is
 * shared (same table shape), so a SQLite↔Postgres dump/restore round-trips the
 * applied-version marker too.
 *
 * Dialect notes (kept out of the route layer):
 * - timestamps are epoch **milliseconds** (Date.now()), which exceeds 32-bit
 *   `INTEGER`; SQLite `INTEGER` is 64-bit, Postgres uses `BIGINT`.
 * - `enabled`/`verified` are `INTEGER 0/1` in *both* dialects so the row mappers
 *   stay byte-identical across backends (no boolean/0/1 branch).
 * - `audit_log.id` uses SQLite `AUTOINCREMENT` vs Postgres `IDENTITY`.
 * @module dsh-server-login/db/schema
 */

import type { Database } from './connection.js'
import type { Pool } from 'pg'

const SQLITE_V1 = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  pass_hash    TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'pending'
               CHECK (role IN ('admin','pending','active','disabled')),
  home_dir     TEXT NOT NULL,
  api_key_ref  TEXT,
  created_at   INTEGER NOT NULL,
  approved_by  TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  rel_path     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (user_id, rel_path)
);

CREATE TABLE IF NOT EXISTS folder_plugins (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plugin_id    TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  description  TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, plugin_id)
);

CREATE TABLE IF NOT EXISTS dsh_instances (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id),
  role         TEXT NOT NULL CHECK (role IN ('main','watchdog')),
  pid          INTEGER,
  port         INTEGER,
  status       TEXT NOT NULL
               CHECK (status IN ('starting','running','crashed','repairing','stopped')),
  started_at   INTEGER,
  last_exit    INTEGER,
  exit_code    INTEGER,
  last_error   TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  actor        TEXT,
  action       TEXT NOT NULL,
  detail       TEXT
);

CREATE TABLE IF NOT EXISTS domains (
  id            TEXT PRIMARY KEY,
  user_id       TEXT UNIQUE REFERENCES users(id),
  domain        TEXT NOT NULL,
  verified      INTEGER NOT NULL DEFAULT 0,
  nginx_config  TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credential_vault (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  key_name   TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, key_name)
);
`

const SQLITE_V2 = `
ALTER TABLE credential_vault ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0;
`

const PG_V1 = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  pass_hash    TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'pending'
               CHECK (role IN ('admin','pending','active','disabled')),
  home_dir     TEXT NOT NULL,
  api_key_ref  TEXT,
  created_at   BIGINT NOT NULL,
  approved_by  TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  rel_path     TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  UNIQUE (user_id, rel_path)
);

CREATE TABLE IF NOT EXISTS folder_plugins (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plugin_id    TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  description  TEXT,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, plugin_id)
);

CREATE TABLE IF NOT EXISTS dsh_instances (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id),
  role         TEXT NOT NULL CHECK (role IN ('main','watchdog')),
  pid          INTEGER,
  port         INTEGER,
  status       TEXT NOT NULL
               CHECK (status IN ('starting','running','crashed','repairing','stopped')),
  started_at   BIGINT,
  last_exit    BIGINT,
  exit_code    INTEGER,
  last_error   TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts           BIGINT NOT NULL,
  actor        TEXT,
  action       TEXT NOT NULL,
  detail       TEXT
);

CREATE TABLE IF NOT EXISTS domains (
  id            TEXT PRIMARY KEY,
  user_id       TEXT UNIQUE REFERENCES users(id),
  domain        TEXT NOT NULL,
  verified      INTEGER NOT NULL DEFAULT 0,
  nginx_config  TEXT,
  updated_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS credential_vault (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  key_name   TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (user_id, key_name)
);
`

const PG_V2 = `
ALTER TABLE credential_vault ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0;
`

// v3: per-user Linux uid (non-colliding for new users via an identity column).
// SQLite reuses its implicit `rowid` for the incrementing integer, so only the
// `uid` column is added here; Postgres adds an explicit identity `row_id`.
const SQLITE_V3 = `
ALTER TABLE users ADD COLUMN uid INTEGER;
`

const PG_V3 = `
ALTER TABLE users ADD COLUMN row_id BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE users ADD COLUMN uid BIGINT;
`

// v4: desired-state columns on `dsh_instances`. The table has existed since v1
// but was never read or written; the k8s controller uses it as the reconcile
// target (docs/k8s.md §5.7), which needs the launch folder and the rendered
// Cordis patch to rebuild a Pod that went missing.
const SQLITE_V4 = `
ALTER TABLE dsh_instances ADD COLUMN folder TEXT;
ALTER TABLE dsh_instances ADD COLUMN patch TEXT;
`

const PG_V4 = `
ALTER TABLE dsh_instances ADD COLUMN folder TEXT;
ALTER TABLE dsh_instances ADD COLUMN patch TEXT;
`

// v5: `paused` on `dsh_instances.status`, written by the reconcile idle-reap for
// a backend that keeps the user's instance (CubeSandbox — see
// docs/plan/cubesandbox-backend.md §7/§9). Both dialects must move together:
// the CHECK exists once per dialect and `types.ts` mirrors it.
//
// SQLite cannot ALTER a CHECK constraint, so the table is rebuilt
// (create → copy → drop → rename). Safe here because `dsh_instances` has **no
// inbound** foreign keys — it only references `users`/`workspaces` — so no other
// table's DDL moves. `PRAGMA foreign_keys=off` is deliberately not used:
// `runSqliteMigrations` wraps every migration in one transaction, inside which
// that pragma is a no-op. The copy below therefore satisfies the foreign keys as
// they stand (they do: rows are already constrained by v1's REFERENCES).
//
// The old `dsh_instances` is dropped *after* the copy and the new table is
// renamed into place, so a failure anywhere rolls the whole migration back and
// leaves the original table intact.
const SQLITE_V5 = `
CREATE TABLE dsh_instances_v5 (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id),
  role         TEXT NOT NULL CHECK (role IN ('main','watchdog')),
  pid          INTEGER,
  port         INTEGER,
  status       TEXT NOT NULL
               CHECK (status IN ('starting','running','crashed','repairing','stopped','paused')),
  started_at   INTEGER,
  last_exit    INTEGER,
  exit_code    INTEGER,
  last_error   TEXT,
  folder       TEXT,
  patch        TEXT
);

INSERT INTO dsh_instances_v5
  (id, user_id, workspace_id, role, pid, port, status, started_at, last_exit, exit_code, last_error, folder, patch)
SELECT
   id, user_id, workspace_id, role, pid, port, status, started_at, last_exit, exit_code, last_error, folder, patch
FROM dsh_instances;

DROP TABLE dsh_instances;
ALTER TABLE dsh_instances_v5 RENAME TO dsh_instances;
`

// Postgres can alter a CHECK in place. The column-level CHECK created by v1 was
// auto-named by Postgres, so the drop looks the name up instead of assuming it
// (`dsh_instances_status_check` is only the conventional guess): dropping by
// pattern cannot leave an older, stricter constraint behind, which a plain
// `DROP CONSTRAINT IF EXISTS <guess>` would.
const PG_V5 = `
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'dsh_instances'::regclass
       AND contype = 'c'
       AND conname LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE dsh_instances DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE dsh_instances ADD CONSTRAINT dsh_instances_status_check
  CHECK (status IN ('starting','running','crashed','repairing','stopped','paused'));
`

interface Migration {
  version: number
  name: string
  sqlite: string
  pg: string
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial schema', sqlite: SQLITE_V1, pg: PG_V1 },
  { version: 2, name: 'credential vault enabled flag', sqlite: SQLITE_V2, pg: PG_V2 },
  { version: 3, name: 'per-user uid', sqlite: SQLITE_V3, pg: PG_V3 },
  { version: 4, name: 'instance desired state', sqlite: SQLITE_V4, pg: PG_V4 },
  { version: 5, name: 'paused instance status', sqlite: SQLITE_V5, pg: PG_V5 },
]

/** Apply unapplied SQLite migrations inside a single transaction. */
export function runSqliteMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>
  const applied = new Set(rows.map((row) => row.version))

  const apply = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      db.exec(migration.sqlite)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        Date.now(),
      )
    }
  })
  apply()
}

/** Apply unapplied Postgres migrations inside a single transaction. */
export async function runPgMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        applied_at BIGINT NOT NULL
      );
    `)
    const { rows } = await client.query('SELECT version FROM schema_migrations')
    const applied = new Set(rows.map((row) => row.version as number))
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      await client.query(migration.pg)
      await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [
        migration.version,
        Date.now(),
      ])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}
