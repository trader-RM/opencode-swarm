/**
 * Dispatch: pick the right `LanguageBackend` for a directory.
 *
 * `pickBackend(dir)` walks up from `dir` to find the nearest project
 * manifest, runs language detection on that root, and returns the
 * registered (or defaulted) backend for the dominant language. Caches
 * results in a bounded LRU keyed by (dir, manifest-hash) so repeated calls
 * during a session do not re-walk the filesystem.
 *
 * Per the language-agnostic plan, hot-path callers (hooks, tools) wrap
 * this in `withTimeout(200ms)` and fail open on the cache miss; session-
 * start callers use `withTimeout(2000ms)`. Both budgets are caller-set —
 * the dispatch function itself does not impose timeouts.
 *
 * Invariant 4: this module never writes to `.swarm/`. All caching is
 * in-process. `dir` is treated as caller-supplied and not validated as a
 * project root — callers are responsible for passing the right directory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LanguageBackend } from './backend';
import { detectProjectLanguages } from './detector';
import { LANGUAGE_BACKEND_REGISTRY } from './registry-backend';

const _internals: {
	detectProjectLanguages: typeof detectProjectLanguages;
	cacheCapacity: number;
} = {
	detectProjectLanguages,
	cacheCapacity: 64,
};
export { _internals };

/**
 * Cache key shape: directory absolute path + hash of all detected manifest
 * files' contents. When any manifest file changes, the hash changes and the
 * cache entry is invalidated. Manifests not present contribute nothing.
 */
type CacheValue = {
	hash: string;
	backend: LanguageBackend | null;
	insertOrder: number;
};

const cache = new Map<string, CacheValue>();
let insertCounter = 0;

/**
 * Common manifest filenames to hash for cache invalidation. Sourced from
 * every profile's `build.detectFiles` plus the union of common test/lint
 * detect files. Listing them explicitly (rather than re-scanning every
 * profile on every cache check) is cheaper.
 */
const MANIFEST_FILES = [
	'package.json',
	'tsconfig.json',
	'pyproject.toml',
	'setup.py',
	'setup.cfg',
	'requirements.txt',
	'Pipfile',
	'Cargo.toml',
	'go.mod',
	'pom.xml',
	'build.gradle',
	'build.gradle.kts',
	'build.zig',
	'CMakeLists.txt',
	'Makefile',
	'meson.build',
	'Package.swift',
	'pubspec.yaml',
	'Gemfile',
	'composer.json',
] as const;

/**
 * Compute a stable hash of all manifest file contents present in `dir`.
 * Returns the empty string if none are present.
 *
 * Combines size + mtimeMs + inode. inode catches atomic-replace edits
 * (same size, same mtime granularity) which size+mtime alone misses on
 * filesystems with second-level mtime rounding (HFS+, some Docker overlay
 * layouts). On Windows, fs.statSync returns a synthesized ino that is
 * stable per-handle within a process — sufficient for cache invalidation.
 */
function manifestHash(dir: string): string {
	const parts: string[] = [];
	for (const name of MANIFEST_FILES) {
		const p = path.join(dir, name);
		try {
			const stat = fs.statSync(p);
			parts.push(`${name}:${stat.size}:${stat.mtimeMs}:${stat.ino}`);
		} catch {
			// not present — skip
		}
	}
	return parts.join('|');
}

/**
 * Walk up from `start` until a directory containing any of MANIFEST_FILES
 * is found, or we reach the filesystem root. Returns the manifest-bearing
 * directory, or `start` itself if none found (per-directory dispatch then
 * resolves to the default backend or null).
 */
function findManifestRoot(start: string): string {
	let cur = path.resolve(start);
	for (let i = 0; i < 32; i++) {
		for (const name of MANIFEST_FILES) {
			try {
				fs.accessSync(path.join(cur, name));
				return cur;
			} catch {
				// not here
			}
		}
		const parent = path.dirname(cur);
		if (parent === cur) return start; // reached root
		cur = parent;
	}
	return start;
}

/**
 * Bounded LRU eviction. Removes the oldest insertion when cache exceeds
 * capacity. Simple insertCounter ordering — sufficient for our use case
 * (per-session, ~tens of distinct directories at most).
 */
function evictIfNeeded(): void {
	if (cache.size <= _internals.cacheCapacity) return;
	let oldestKey: string | undefined;
	let oldestOrder = Infinity;
	for (const [k, v] of cache.entries()) {
		if (v.insertOrder < oldestOrder) {
			oldestOrder = v.insertOrder;
			oldestKey = k;
		}
	}
	if (oldestKey !== undefined) cache.delete(oldestKey);
}

/**
 * Pick the most appropriate `LanguageBackend` for `dir`. Walks up to find
 * the manifest root, detects languages there, returns the highest-tier
 * backend (with the default backend synthesized for ids that have no
 * registered override). Returns null if no language is detected.
 *
 * The dispatch is cached by `(manifestRoot, manifestHash)`; cache entries
 * are invalidated automatically when any manifest's size or mtime changes.
 */
export async function pickBackend(
	dir: string,
): Promise<LanguageBackend | null> {
	const root = findManifestRoot(dir);
	const hash = manifestHash(root);
	const cacheKey = root;
	const cached = cache.get(cacheKey);
	if (cached && cached.hash === hash) {
		return cached.backend;
	}

	const profiles = await _internals.detectProjectLanguages(root);
	if (profiles.length === 0) {
		cache.set(cacheKey, { hash, backend: null, insertOrder: insertCounter++ });
		evictIfNeeded();
		return null;
	}
	// detectProjectLanguages returns profiles tier-sorted (lowest tier first).
	// Pick the first one — caller can list secondary languages via
	// detectProjectLanguages directly if needed.
	const winner = profiles[0];
	const backend = LANGUAGE_BACKEND_REGISTRY.getOrDefault(winner.id) ?? null;
	cache.set(cacheKey, { hash, backend, insertOrder: insertCounter++ });
	evictIfNeeded();
	return backend;
}

/**
 * Test-only: clear the dispatch cache. Production code should never call
 * this — the cache is invalidated automatically by manifest hashes.
 */
export function clearDispatchCache(): void {
	cache.clear();
	insertCounter = 0;
}
