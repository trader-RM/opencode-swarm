/**
 * Lazy Database constructor resolution shared by the project and global DBs.
 *
 * Resolution order:
 *   1. `bun:sqlite`  — Bun built-in (preferred when running under Bun).
 *   2. `node:sqlite` — Node built-in (stable in Node 22.5+, no native compile,
 *                     no ABI-mismatch risk under Electron's bundled Node).
 *
 * Both backends are wrapped to expose the bun:sqlite-shaped surface the rest
 * of the codebase relies on:
 *   - `new Db(path)`
 *   - `db.run(sql, params?)`            — paramless DDL/PRAGMA goes through `exec`,
 *                                         params go through `prepare(sql).run(...spread)`
 *   - `db.query(sql)`                   — returns a prepared statement with .get/.all/.run
 *   - `db.transaction(fn)`              — returns a callable that runs fn inside BEGIN/COMMIT/ROLLBACK
 *   - `db.close()`
 */
import type { Database } from 'bun:sqlite';
export declare function loadDatabaseCtor(): typeof Database;
