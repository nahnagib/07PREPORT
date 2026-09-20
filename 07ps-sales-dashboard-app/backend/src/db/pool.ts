import mysql from 'mysql2/promise';

/**
 * Single MySQL pool for the whole API.
 *
 * REPLACES the previous Postgres (`pg`) pool + Postgres-native Row-Level-Security scaffold
 * (SET LOCAL/current_setting(), see the old rlsContext.ts). MySQL has no equivalent native RLS
 * mechanism, and the warehouse decision moved to MySQL 8 (docs/tech-stack-decision.md) before this
 * backend package was updated to match -- this pool is that update.
 *
 * Scope enforcement (Standards Section 5.2's "enforced at the data layer, not just hidden UI
 * elements") is now done in application code instead of database-native RLS: see
 * src/middleware/scopeContext.ts, which calls src/measures/filters.ts's applySalespersonLock on
 * every request before any query runs, and src/measures/tachometer.ts's query functions, which
 * always take the already-locked Filters object as a required parameter -- there is no query path
 * in this codebase that builds SQL without going through that same filter object.
 */
export const pool = mysql.createPool({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME ?? 'ps_warehouse',
  socketPath: process.env.DB_SOCKET || undefined,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: false,
  // Bounds how long mysql2 will wait to establish a NEW connection (e.g. the host is unreachable,
  // as when DB_HOST doesn't resolve/answer) before rejecting with ETIMEDOUT -- without this, the
  // OS-level TCP timeout can run 20s+, during which every request waiting on a pool connection
  // hangs. This does not bound an already-open connection's query time.
  connectTimeout: 5000,
  // Fail a request fast instead of letting it queue forever when all 10 connections are stuck.
  queueLimit: 100,
  // Keep idle sockets alive and recycle them before a NAT/firewall/MySQL wait_timeout silently
  // drops them (which otherwise surfaces as ECONNRESET / PROTOCOL_CONNECTION_LOST on first use).
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  maxIdle: 5,
  idleTimeout: 60_000,
  // The DB server's session time_zone otherwise defaults to SYSTEM (observed as UTC+2 on the
  // deployment host), while every JS-side timestamp this app compares against a DB-read value
  // (JWT `iat` in middleware/auth.ts, Date.now() elsewhere) is always genuine UTC. Without pinning
  // the session to UTC, mysql2 reads TIMESTAMP columns (sessions_revoked_at, password_changed_at,
  // password_reset_expires_at, ...) back as if the server's local wall-clock string were already
  // UTC -- silently shifting every DB-read timestamp hours into the future relative to Node's
  // clock. That previously caused a token issued genuinely *after* a revocation/password-change
  // to still be rejected as revoked, because the revocation timestamp looked like it hadn't
  // happened yet. `timezone` only controls mysql2's own JS Date parsing; the `SET time_zone`
  // below (via the pool 'connection' event) is what actually makes the server hand back UTC wall
  // values in the first place -- both are needed together.
  timezone: 'Z',
});

pool.on('connection', (connection) => {
  // The 'connection' event yields mysql2's callback-style core connection even on a promise pool,
  // so this takes a callback -- calling .catch() on it throws and stalls connection setup.
  (connection as unknown as { query(sql: string, cb: (err: Error | null) => void): void }).query(
    "SET time_zone = '+00:00'",
    (err) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.error('MySQL: failed to set session time_zone to UTC on new connection', err);
      }
    },
  );
  // An idle pooled connection can die at any time; without a listener the 'error' event is thrown.
  connection.on('error', (err: NodeJS.ErrnoException) => {
    // eslint-disable-next-line no-console
    console.error('MySQL: pooled connection error', { code: err.code, message: err.message });
  });
});

// mysql2's core pool has no 'error' event of its own; connection-level errors are handled above.
// This guards the (rare) case where a version of the driver does emit one, so it can never crash us.
(pool.pool as unknown as NodeJS.EventEmitter).on('error', (err: NodeJS.ErrnoException) => {
  // eslint-disable-next-line no-console
  console.error('MySQL: pool error', { code: err.code, message: err.message });
});

export interface DependencyStatus {
  status: 'ok' | 'down';
  latencyMs: number;
  /** Error code only (e.g. ETIMEDOUT) -- never the raw message, which can contain host/user details. */
  error?: string;
}

const CHECK_TIMEOUT_MS = 5000;

async function timed(fn: () => Promise<unknown>): Promise<DependencyStatus> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('health check timed out'), { code: 'ETIMEDOUT' })), CHECK_TIMEOUT_MS);
      }),
    ]);
    return { status: 'ok', latencyMs: Date.now() - started };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 'down', latencyMs: Date.now() - started, error: e.code ?? e.message ?? 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}

/** Can we open a connection and run a trivial query against the user/warehouse DB? */
export function checkDatabase(): Promise<DependencyStatus> {
  return timed(() => pool.query('SELECT 1'));
}

/** The auth/token-revocation store is the same MySQL, but this also proves its table exists. */
export function checkAuthStore(): Promise<DependencyStatus> {
  return timed(() => pool.query('SELECT 1 FROM revoked_tokens LIMIT 1'));
}
