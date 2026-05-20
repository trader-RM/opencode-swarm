/**
 * Runtime-agnostic SQLite loader.
 *
 * Tries bun:sqlite first (native under Bun). If unavailable — e.g. when the
 * plugin runs under Node.js inside the OpenCode host — falls back to
 * node:sqlite (Node.js ≥ 22.5.0). Exposes a single `loadDatabaseCtor()`
 * function that returns a constructor whose instances match the bun:sqlite
 * Database API subset used throughout src/db/.
 *
 * Both db files (project-db.ts, global-db.ts) used identical inline
 * `loadDatabaseCtor` functions that only tried bun:sqlite. This shared
 * module replaces them and adds the Node.js fallback (issue: bun:sqlite
 * unavailable in Node.js host environments).
 */
/**
 * Minimal bun:sqlite.Database surface used by this plugin's db layer.
 * Defined locally so no file statically imports bun:sqlite (which would
 * break plugin loading under Node's ESM resolver before any code runs).
 */
export interface SwarmDb {
    run(sql: string, params?: unknown[]): void;
    query<T, _P = unknown>(sql: string): {
        get(...args: unknown[]): T | null;
        all(...args: unknown[]): T[];
    };
    transaction<T>(fn: () => T): () => T;
    close(): void;
}
/** Constructor type returned by `loadDatabaseCtor()`. */
export type SwarmDbConstructor = new (path: string) => SwarmDb;
/**
 * Load and cache the SQLite constructor for the current runtime.
 *
 * Resolution order:
 *   1. bun:sqlite  — available natively when the host is Bun
 *   2. node:sqlite — available in Node.js ≥ 22.5.0
 *
 * Throws with a human-readable message if neither is available so that
 * plugin init fails loudly rather than with a cryptic module-not-found error.
 */
export declare function loadDatabaseCtor(): SwarmDbConstructor;
