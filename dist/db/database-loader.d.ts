/**
 * Lazy Database constructor resolution shared by the project and global DBs.
 *
 * Prefers `bun:sqlite` (Bun built-in). Falls back to `better-sqlite3` when
 * running under Node (the case when OpenCode loads Swarm as a plugin inside
 * its Electron NodeService, where `bun:sqlite` does not exist).
 *
 * The fallback returns a small shim class that implements the bun:sqlite-
 * shaped surface the rest of the codebase relies on (`db.run(sql, params?)`,
 * `db.query(sql)` returning a prepared statement with `.get`/`.all`/`.run`).
 * `db.transaction(fn)` and `db.close()` are provided by better-sqlite3 with
 * the same semantics.
 */
import type { Database } from 'bun:sqlite';
export declare function loadDatabaseCtor(): typeof Database;
