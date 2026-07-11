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
});
