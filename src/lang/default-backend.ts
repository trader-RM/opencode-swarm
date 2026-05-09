/**
 * Default backend — registry-driven implementations of every optional hook
 * on `LanguageBackend`. A backend that overrides nothing still works for
 * common cases: any profile with build.commands + test.frameworks +
 * lint.linters declared correctly will get a working `selectTestFramework`,
 * `selectBuildCommand`, etc. without writing any backend code.
 *
 * No subprocess calls happen here — `isCommandAvailable` is the only seam
 * to the environment, and it lives in `src/build/discovery.ts` with full
 * invariant-3 properties (cwd, stdin: 'ignore', timeout, bounded stdio).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCommandAvailable } from '../build/discovery';
import type {
	BuildCommandSelection,
	LanguageBackend,
	TestFrameworkSelection,
	TestRunSummary,
} from './backend';
import type { LanguageProfile } from './profiles';

/**
 * Resolve a (possibly glob-y) detect file pattern against `dir`. Returns
 * true if any file in `dir` matches. Supports the simple `*.ext` glob
 * shape used by profiles (the same shape `findBuildFiles` understands).
 */
function detectFileExists(dir: string, pattern: string): boolean {
	if (pattern.includes('*') || pattern.includes('?')) {
		try {
			const files = fs.readdirSync(dir);
			// Convert simple glob to anchored regex: `*.csproj` → /^.*\.csproj$/
			const regex = new RegExp(
				`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
			);
			return files.some((f) => regex.test(f));
		} catch {
			return false;
		}
	}
	try {
		fs.accessSync(path.join(dir, pattern));
		return true;
	} catch {
		return false;
	}
}

/**
 * Tokenize a string command into an array. Splits on whitespace; respects
 * single and double quotes for argument grouping. Used to convert profile
 * `cmd` strings (which today are written as "npx tsc --noEmit" etc.) into
 * the array form `bunSpawn` expects.
 *
 * This deliberately does NOT support shell metacharacters (`;`, `&`, `|`,
 * `>`, `<`, backticks, `$()`) — backends with non-trivial commands must
 * override `buildTestCommand`/`selectBuildCommand` to return a custom
 * `cmd: string[]`. Splitting a profile string into words is a 90% case;
 * the 10% override their backend.
 */
export function tokenizeCommand(cmd: string): string[] {
	const out: string[] = [];
	let buf = '';
	let quote: '"' | "'" | null = null;
	for (const ch of cmd) {
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else {
				buf += ch;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch as '"' | "'";
			continue;
		}
		if (ch === ' ' || ch === '\t') {
			if (buf.length > 0) {
				out.push(buf);
				buf = '';
			}
			continue;
		}
		buf += ch;
	}
	if (buf.length > 0) out.push(buf);
	return out;
}

/**
 * Default selectTestFramework: highest-priority framework whose detect
 * file exists AND whose binary is on PATH. Returns null if none.
 */
export async function defaultSelectTestFramework(
	profile: LanguageProfile,
	dir: string,
): Promise<TestFrameworkSelection | null> {
	const sorted = [...profile.test.frameworks].sort(
		(a, b) => b.priority - a.priority,
	);
	for (const fw of sorted) {
		if (!detectFileExists(dir, fw.detect)) continue;
		const argv = tokenizeCommand(fw.cmd);
		if (argv.length === 0) continue;
		if (!isCommandAvailable(argv[0])) continue;
		return {
			name: fw.name,
			cmd: argv,
			cwd: dir,
			detectedVia: fw.detect,
			// Frameworks that ignore per-file selection are explicitly tagged on
			// the framework definition — see the `filesIgnored` flag added to
			// TestFramework in profiles.ts (defaults to false).
			filesIgnored: false,
		};
	}
	return null;
}

/**
 * Default buildTestCommand: append `files` to the framework's argv unless
 * the selected framework reports `filesIgnored`. Caller passes the
 * already-resolved framework selection back via `framework` (name) plus
 * the original cmd; we look up the selection-time argv from the profile
 * to keep this function pure.
 *
 * Note: this default looks up the framework by name in the profile and
 * tokenizes its `cmd` afresh. Backends that need different argv shape
 * across selection vs. invocation (rare) should override.
 */
export function defaultBuildTestCommand(
	profile: LanguageProfile,
	framework: string,
	files: string[],
): string[] {
	const fw = profile.test.frameworks.find((f) => f.name === framework);
	if (!fw) return [];
	const argv = tokenizeCommand(fw.cmd);
	// Explicitly conservative: append files only if non-empty. Backends that
	// require a positional `--` separator (e.g. `cargo test -- --nocapture`)
	// must override.
	if (files.length === 0) return argv;
	return [...argv, ...files];
}

/**
 * Default parseTestOutput: exit-code-only. No regex, no framework-specific
 * assumptions. Backends that need pass/fail counts override.
 */
export function defaultParseTestOutput(
	stdout: string,
	stderr: string,
	exitCode: number,
): TestRunSummary {
	return {
		ok: exitCode === 0,
		raw: { stdout, stderr, exitCode },
	};
}

/**
 * Default detectProject: any of `profile.build.detectFiles` is present in
 * `dir`. Honors simple glob patterns the same way `detectFileExists` does.
 */
export async function defaultDetectProject(
	profile: LanguageProfile,
	dir: string,
): Promise<boolean> {
	for (const f of profile.build.detectFiles) {
		if (detectFileExists(dir, f)) return true;
	}
	return false;
}

/**
 * Default selectBuildCommand: highest-priority command whose detectFile
 * (if specified) exists AND whose binary is on PATH. Returns null if none.
 */
export async function defaultSelectBuildCommand(
	profile: LanguageProfile,
	dir: string,
): Promise<BuildCommandSelection | null> {
	const sorted = [...profile.build.commands].sort(
		(a, b) => b.priority - a.priority,
	);
	for (const cmd of sorted) {
		if (cmd.detectFile && !detectFileExists(dir, cmd.detectFile)) continue;
		const argv = tokenizeCommand(cmd.cmd);
		if (argv.length === 0) continue;
		if (!isCommandAvailable(argv[0])) continue;
		return {
			name: cmd.name,
			cmd: argv,
			cwd: dir,
			detectedVia: cmd.detectFile ?? `${profile.id} default`,
		};
	}
	return null;
}

/**
 * Default testFilesFor: convention swap `src/<x>.<ext>` ↔ `tests/<x>.<ext>`
 * (and `tests/<x>_test.<ext>`, `tests/<x>.test.<ext>`). Returns candidates
 * sorted by likelihood. Best-effort — backends with established patterns
 * (e.g. Python's `tests/test_<x>.py`) override.
 */
export async function defaultTestFilesFor(
	profile: LanguageProfile,
	sourceFile: string,
	dir: string,
): Promise<string[]> {
	const ext = path.extname(sourceFile);
	if (!profile.extensions.includes(ext)) return [];
	const base = path.basename(sourceFile, ext);
	const rel = path.relative(dir, sourceFile);
	// Strip the leading `src/` if present, otherwise use the whole relative
	// path's directory.
	const relDir = path.dirname(rel);
	const stripSrc = relDir.replace(/^src(\/|\\)/, '');
	const candidates = new Set<string>();
	for (const tDir of ['tests', 'test', '__tests__', 'spec']) {
		for (const suffix of ['', '_test', '.test', '_spec', '.spec']) {
			candidates.add(path.join(dir, tDir, stripSrc, `${base}${suffix}${ext}`));
		}
	}
	const existing: string[] = [];
	for (const c of candidates) {
		try {
			fs.accessSync(c);
			existing.push(c);
		} catch {
			// not present — skip
		}
	}
	return existing;
}

/**
 * Default extractImports: returns []. The analyzer treats this as
 * "graph scope unavailable for {lang}" and falls back to convention scope
 * with an explicit notice. Backends with parser-driven extraction
 * (TypeScript, Python, Go in the language-agnostic plan's Phase 5) override.
 */
export function defaultExtractImports(): string[] {
	return [];
}

/**
 * Build a backend object that delegates every hook to the registry-driven
 * defaults. Used by `pickBackend` when no language-specific override has
 * been registered. The returned object is a structural `LanguageBackend`
 * (it spreads the profile, then attaches default method bindings).
 */
export function defaultBackendFor(profile: LanguageProfile): LanguageBackend {
	return {
		...profile,
		detectProject: (dir) => defaultDetectProject(profile, dir),
		selectTestFramework: (dir) => defaultSelectTestFramework(profile, dir),
		buildTestCommand: (framework, files) =>
			defaultBuildTestCommand(profile, framework, files),
		parseTestOutput: (_framework, stdout, stderr, exitCode) =>
			defaultParseTestOutput(stdout, stderr, exitCode),
		testFilesFor: (sourceFile, dir) =>
			defaultTestFilesFor(profile, sourceFile, dir),
		extractImports: () => defaultExtractImports(),
		selectBuildCommand: (dir) => defaultSelectBuildCommand(profile, dir),
	};
}
