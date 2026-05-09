/**
 * TypeScript / JavaScript backend.
 *
 * Overrides the default backend's `selectTestFramework` to honor
 * `package.json#scripts.test` (the canonical signal in the JS ecosystem)
 * and `extractImports` to parse ES6 + CommonJS imports for the
 * graph/impact analyzer.
 *
 * Phase 2 deliverable: this backend exists and registers itself, but
 * `src/tools/test-runner.ts` and `src/test-impact/analyzer.ts` do not yet
 * call into it — they still use their existing switch-statement helpers.
 * Phase 3 wires the test-runner dispatch through this backend.
 *
 * Invariants:
 *   - No subprocess calls (defers to `isCommandAvailable` from
 *     `../../build/discovery` for binary checks; that helper already
 *     satisfies invariant 3).
 *   - No `bun:` imports, no `Bun.*` calls (invariant 2).
 *   - No mutation of LANGUAGE_REGISTRY at import time — only registers a
 *     backend in LANGUAGE_BACKEND_REGISTRY via `backends/index.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
	LanguageBackend,
	TestFrameworkSelection,
	TestRunSummary,
} from '../backend';
import {
	defaultBuildTestCommand,
	defaultParseTestOutput,
	defaultSelectBuildCommand,
	defaultSelectTestFramework,
	defaultTestFilesFor,
	tokenizeCommand,
} from '../default-backend';
import { LANGUAGE_REGISTRY, type LanguageProfile } from '../profiles';

const PROFILE_ID = 'typescript';

/**
 * ES6 + CommonJS import patterns. Mirrors the patterns used by
 * `src/test-impact/analyzer.ts:11–14` (ES, REQUIRE, REEXPORT) and adds
 * BARE and DYNAMIC to widen graph coverage for Phase 5. Phase 3 will
 * route the analyzer through this backend; the inputs must remain a
 * superset of what the analyzer produces today, so REEXPORT is
 * required (loss would silently shrink the impact graph and is
 * caught by `tests/unit/lang/typescript-backend-imports.test.ts`).
 */
const IMPORT_REGEX_ES = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
const IMPORT_REGEX_BARE = /import\s+['"]([^'"]+)['"]/g;
const IMPORT_REGEX_REQUIRE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_REGEX_DYNAMIC = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_REGEX_REEXPORT =
	/export\s+(?:\{[^}]*\}|\*)\s+from\s+['"]([^'"]+)['"]/g;

interface PackageJsonShape {
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

/**
 * Read package.json. Returns null when missing or malformed. Bounded by a
 * single sync `fs.readFileSync` — no subprocess.
 */
function readPackageJson(dir: string): PackageJsonShape | null {
	try {
		const content = fs.readFileSync(path.join(dir, 'package.json'), 'utf-8');
		return JSON.parse(content) as PackageJsonShape;
	} catch {
		return null;
	}
}

/** Convenience: read just `scripts.test` (used by tests). */
function readPackageJsonTestScript(dir: string): string | null {
	return readPackageJson(dir)?.scripts?.test ?? null;
}

/**
 * Map a `package.json#scripts.test` invocation to a framework name. The
 * mapping mirrors `detectTestFramework` in `src/tools/test-runner.ts:286–326`.
 */
function frameworkFromScriptsTest(script: string): string | null {
	if (script.includes('vitest')) return 'vitest';
	if (script.includes('jest')) return 'jest';
	if (script.includes('mocha')) return 'mocha';
	if (script.includes('bun test')) return 'bun:test';
	return null;
}

/**
 * Detect a JS test framework by presence in `devDependencies`. Mirrors
 * `test-runner.ts:309–312` so when the user has `devDependencies.vitest`
 * but no `vitest.config.ts` and a custom `scripts.test` (e.g.
 * "make test"), we still resolve to vitest as the existing logic does.
 */
function frameworkFromDevDeps(
	devDeps: Record<string, string> | undefined,
): string | null {
	if (!devDeps) return null;
	if (devDeps.vitest || devDeps['@vitest/ui']) return 'vitest';
	if (devDeps.jest || devDeps['@types/jest']) return 'jest';
	if (devDeps.mocha || devDeps['@types/mocha']) return 'mocha';
	return null;
}

function selectionFromFramework(
	profile: LanguageProfile,
	fwName: string,
	dir: string,
	detectedVia: string,
): TestFrameworkSelection | null {
	const fw = profile.test.frameworks.find((f) => f.name === fwName);
	if (!fw) return null;
	const argv = tokenizeCommand(fw.cmd);
	if (argv.length === 0) return null;
	return {
		name: fw.name,
		cmd: argv,
		cwd: dir,
		detectedVia,
		filesIgnored: false,
	};
}

async function selectTestFramework(
	dir: string,
): Promise<TestFrameworkSelection | null> {
	const profile = LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) return null;
	const pkg = readPackageJson(dir);

	// 1. Honor scripts.test — the canonical signal in JS projects.
	const script = pkg?.scripts?.test;
	if (script) {
		const fwName = frameworkFromScriptsTest(script);
		if (fwName) {
			const sel = selectionFromFramework(
				profile,
				fwName,
				dir,
				'package.json#scripts.test',
			);
			if (sel) return sel;
		}
	}

	// 2. Fall back to devDependencies — mirrors the existing behavior in
	//    `src/tools/test-runner.ts:309–312`. Without this, a project with
	//    `devDependencies.vitest` and no `vitest.config.ts` would silently
	//    miss vitest under the default's `detectFile`-driven selection.
	const devDepsFw = frameworkFromDevDeps(pkg?.devDependencies);
	if (devDepsFw) {
		const sel = selectionFromFramework(
			profile,
			devDepsFw,
			dir,
			'package.json#devDependencies',
		);
		if (sel) return sel;
	}

	// 3. Fall back to the default registry-driven selection (detectFile +
	//    binary-on-PATH check from the profile's framework list).
	return defaultSelectTestFramework(profile, dir);
}

function buildTestCommand(framework: string, files: string[]): string[] {
	const profile = LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) return [];
	return defaultBuildTestCommand(profile, framework, files);
}

function parseTestOutput(
	_framework: string,
	stdout: string,
	stderr: string,
	exitCode: number,
): TestRunSummary {
	// Phase 2 keeps parseTestOutput at the default behavior. Phase 3 will
	// lift the bun:test JSON parsing in `src/tools/test-runner.ts:1061-1098`
	// into this method.
	return defaultParseTestOutput(stdout, stderr, exitCode);
}

/**
 * Extract import paths from a TS/JS source file. Mirrors the four regex
 * passes in `src/test-impact/analyzer.ts` so Phase 5 can route extraction
 * through the backend.
 */
function extractImports(_sourceFile: string, source: string): string[] {
	const out = new Set<string>();
	for (const re of [
		IMPORT_REGEX_ES,
		IMPORT_REGEX_BARE,
		IMPORT_REGEX_REQUIRE,
		IMPORT_REGEX_DYNAMIC,
		IMPORT_REGEX_REEXPORT,
	]) {
		// Each regex has /g; reset lastIndex defensively because we share the
		// regex constants across calls.
		re.lastIndex = 0;
		let m: RegExpExecArray | null = re.exec(source);
		while (m !== null) {
			out.add(m[1]);
			m = re.exec(source);
		}
	}
	return [...out];
}

async function selectBuildCommand(dir: string) {
	const profile = LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) return null;
	return defaultSelectBuildCommand(profile, dir);
}

async function testFilesFor(
	sourceFile: string,
	dir: string,
): Promise<string[]> {
	const profile = LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) return [];
	return defaultTestFilesFor(profile, sourceFile, dir);
}

/**
 * Build the TypeScript backend from the registered profile. Backend
 * registration happens in `./index.ts` (the single import-and-register
 * surface) — this module just exports the factory so the registration
 * site is explicit.
 */
export function buildTypescriptBackend(): LanguageBackend {
	const profile: LanguageProfile | undefined =
		LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) {
		throw new Error(
			'buildTypescriptBackend: typescript profile not in LANGUAGE_REGISTRY. ' +
				'profiles.ts must be imported before this backend.',
		);
	}
	return {
		...profile,
		selectTestFramework,
		buildTestCommand,
		parseTestOutput,
		extractImports,
		selectBuildCommand,
		testFilesFor,
	};
}

// Internals exposed for test-only override of `readPackageJsonTestScript`
// without resorting to mock.module (per engineering-conventions skill).
export const _internals: {
	readPackageJsonTestScript: typeof readPackageJsonTestScript;
	frameworkFromScriptsTest: typeof frameworkFromScriptsTest;
} = {
	readPackageJsonTestScript,
	frameworkFromScriptsTest,
};
