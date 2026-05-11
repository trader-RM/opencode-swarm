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
		// Node fallback — wrap better-sqlite3 with a bun:sqlite-compatible surface.
		const BetterSqlite3 = req('better-sqlite3') as new (
			path: string,
			options?: Record<string, unknown>,
		) => BetterSqliteDatabase;

		class BunCompatDatabase extends BetterSqlite3 {
			run(sql: string, params?: unknown[] | unknown): unknown {
				if (params === undefined) {
					this.exec(sql);
					return undefined;
				}
				const paramArr = Array.isArray(params) ? params : [params];
				if (paramArr.length === 0) {
					this.exec(sql);
					return undefined;
				}
				return this.prepare(sql).run(...paramArr);
			}
			query(sql: string): BetterSqliteStatement {
				return this.prepare(sql);
			}
		}

		_DatabaseCtor = BunCompatDatabase as unknown as typeof Database;
		return _DatabaseCtor;
	}
}

interface BetterSqliteStatement {
	run(...params: unknown[]): unknown;
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

interface BetterSqliteDatabase {
	prepare(sql: string): BetterSqliteStatement;
	exec(sql: string): void;
	transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
	close(): void;
	pragma(source: string): unknown;
}
