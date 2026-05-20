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

import { createRequire } from 'node:module';

// ── Shared interface ───────────────────────────────────────────────────────────

/**
 * Minimal bun:sqlite.Database surface used by this plugin's db layer.
 * Defined locally so no file statically imports bun:sqlite (which would
 * break plugin loading under Node's ESM resolver before any code runs).
 */
export interface SwarmDb {
	run(sql: string, params?: unknown[]): void;
	// Second type param (_P) matches bun:sqlite's query<T, P> signature at existing call sites.
	query<T, _P = unknown>(sql: string): {
		get(...args: unknown[]): T | null;
		all(...args: unknown[]): T[];
	};
	transaction<T>(fn: () => T): () => T;
	close(): void;
}

/** Constructor type returned by `loadDatabaseCtor()`. */
export type SwarmDbConstructor = new (path: string) => SwarmDb;

// ── node:sqlite shim ──────────────────────────────────────────────────────────

interface NodeStatementRaw {
	run(...params: unknown[]): unknown;
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

interface NodeDatabaseSyncRaw {
	exec(sql: string): void;
	prepare(sql: string): NodeStatementRaw;
	close(): void;
}

/**
 * Build a SwarmDbConstructor backed by node:sqlite's DatabaseSync.
 * Called only when bun:sqlite is unavailable.
 */
function makeNodeSqliteConstructor(): SwarmDbConstructor {
	const req = createRequire(import.meta.url);
	const { DatabaseSync } = req('node:sqlite') as {
		DatabaseSync: new (path: string) => NodeDatabaseSyncRaw;
	};

	return class NodeDatabase implements SwarmDb {
		private readonly _db: NodeDatabaseSyncRaw;

		constructor(path: string) {
			this._db = new DatabaseSync(path);
		}

		run(sql: string, params?: unknown[]): void {
			if (params && params.length > 0) {
				this._db.prepare(sql).run(...params);
			} else {
				this._db.exec(sql);
			}
		}

		query<T, _P = unknown>(
			sql: string,
		): { get(...args: unknown[]): T | null; all(...args: unknown[]): T[] } {
			const stmt = this._db.prepare(sql);
			return {
				get: (...args: unknown[]) => (stmt.get(...args) as T | null) ?? null,
				all: (...args: unknown[]) => stmt.all(...args) as T[],
			};
		}

		transaction<T>(fn: () => T): () => T {
			return () => {
				this._db.exec('BEGIN');
				try {
					const result = fn();
					this._db.exec('COMMIT');
					return result;
				} catch (err) {
					try {
						this._db.exec('ROLLBACK');
					} catch {
						// ignore rollback errors — original error is more informative
					}
					throw err;
				}
			};
		}

		close(): void {
			this._db.close();
		}
	};
}

// ── Cached constructor ─────────────────────────────────────────────────────────

let _Ctor: SwarmDbConstructor | null = null;

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
export function loadDatabaseCtor(): SwarmDbConstructor {
	if (_Ctor) return _Ctor;

	const req = createRequire(import.meta.url);

	// 1. bun:sqlite (Bun runtime)
	try {
		const bunMod = req('bun:sqlite') as { Database: SwarmDbConstructor };
		_Ctor = bunMod.Database;
		return _Ctor;
	} catch {
		// bun:sqlite unavailable — fall through to node:sqlite
	}

	// 2. node:sqlite (Node.js ≥ 22.5.0)
	try {
		_Ctor = makeNodeSqliteConstructor();
		return _Ctor;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(
			'opencode-swarm: SQLite unavailable — neither bun:sqlite nor node:sqlite ' +
				'could be loaded. This plugin requires Bun or Node.js ≥ 22.5.0.\n' +
				`Underlying error: ${msg}`,
		);
	}
}
