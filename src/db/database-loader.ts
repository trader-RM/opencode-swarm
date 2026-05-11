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
import { createRequire } from 'node:module';

let _DatabaseCtor: typeof Database | null = null;

export function loadDatabaseCtor(): typeof Database {
	if (_DatabaseCtor) return _DatabaseCtor;
	const req = createRequire(import.meta.url);

	try {
		const mod = req('bun:sqlite') as { Database: typeof Database };
		_DatabaseCtor = mod.Database;
		return _DatabaseCtor;
	} catch {
		// Node fallback — wrap node:sqlite (built-in, Node 22.5+ stable) with a
		// bun:sqlite-compatible surface. No native compile, no ABI mismatch.
		const NodeSqlite = req('node:sqlite') as {
			DatabaseSync: new (
				path: string,
				options?: Record<string, unknown>,
			) => NodeSqliteDatabase;
		};

		class BunCompatDatabase {
			private readonly _db: NodeSqliteDatabase;

			constructor(path: string, options?: Record<string, unknown>) {
				// node:sqlite rejects `undefined` as the options arg (must be an object
				// when provided). Omit the second arg entirely when caller didn't pass one.
				this._db = options
					? new NodeSqlite.DatabaseSync(path, options)
					: new NodeSqlite.DatabaseSync(path);
			}

			run(sql: string, params?: unknown[] | unknown): unknown {
				if (params === undefined) {
					this._db.exec(sql);
					return undefined;
				}
				const paramArr = Array.isArray(params) ? params : [params];
				if (paramArr.length === 0) {
					this._db.exec(sql);
					return undefined;
				}
				return this._db.prepare(sql).run(...paramArr);
			}

			query(sql: string): NodeSqliteStatement {
				return this._db.prepare(sql);
			}

			exec(sql: string): void {
				this._db.exec(sql);
			}

			prepare(sql: string): NodeSqliteStatement {
				return this._db.prepare(sql);
			}

			transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
				const db = this._db;
				return ((...args: unknown[]) => {
					db.exec('BEGIN');
					try {
						const result = fn(...args);
						db.exec('COMMIT');
						return result;
					} catch (err) {
						try {
							db.exec('ROLLBACK');
						} catch {
							// best-effort — original error is what matters
						}
						throw err;
					}
				}) as T;
			}

			close(): void {
				this._db.close();
			}
		}

		_DatabaseCtor = BunCompatDatabase as unknown as typeof Database;
		return _DatabaseCtor;
	}
}

interface NodeSqliteStatement {
	run(...params: unknown[]): unknown;
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

interface NodeSqliteDatabase {
	prepare(sql: string): NodeSqliteStatement;
	exec(sql: string): void;
	close(): void;
}
