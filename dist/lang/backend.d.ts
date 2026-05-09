/**
 * LanguageBackend — behavior-bearing extension of LanguageProfile.
 *
 * `LanguageProfile` (in `./profiles.ts`) is a passive data record: it
 * declares which build commands, test frameworks, linters etc. exist for a
 * language, but does not know how to run them. A `LanguageBackend` adds
 * optional behavior hooks. Every hook has a registry-driven default in
 * `./default-backend.ts`, so a backend that overrides nothing still works.
 *
 * Invariant boundaries (per AGENTS.md):
 *   - Backends NEVER spawn subprocesses. They return command-arrays only.
 *     The single spawn site stays in `src/tools/test-runner.ts` (and the
 *     existing helpers in `src/build/discovery.ts:isCommandAvailable`),
 *     each of which already satisfies invariant 3 (cwd, stdin: 'ignore',
 *     timeout, bounded stdio, killable). This rule is enforced by
 *     `tests/unit/lang/backend-purity.test.ts`.
 *   - Backends do no top-level `bun:` imports and no direct `Bun.*` calls
 *     (invariant 2 — runtime portability). Same purity test enforces this.
 *
 * Extension model: a new language is a single new file under
 * `src/lang/backends/<id>.ts` plus one import line in
 * `src/lang/backends/index.ts`. The default backend handles everything the
 * new file does not override.
 */
import type { LanguageProfile } from './profiles';
/**
 * Selected test framework for a project, including the concrete spawn argv
 * and explicit cwd. Returned by `LanguageBackend.selectTestFramework`.
 */
export interface TestFrameworkSelection {
    /** Framework id matching one of LanguageProfile.test.frameworks[*].name. */
    name: string;
    /**
     * Spawn-arg array. Never includes shell metacharacters or relies on shell
     * interpretation — passed directly to `bunSpawn(cmd, ...)`. Backends that
     * cannot avoid a shell-mediated invocation (e.g. PowerShell `-EncodedCommand`)
     * still produce an array; the array's first element is the binary and the
     * rest are individual arguments.
     */
    cmd: string[];
    /** Explicit cwd for the spawn (invariant 3). */
    cwd: string;
    /** Human-readable note: "package.json scripts.test", "Cargo.toml", etc. */
    detectedVia: string;
    /**
     * When true, the `files` argument to `buildTestCommand` is ignored — the
     * framework runs all tests in the project by default (e.g. cargo test,
     * go test ./..., swift test). Per-file selection is the framework's
     * concern, not the backend's.
     */
    filesIgnored?: boolean;
}
/**
 * Structured summary of a test run. The default backend returns only
 * exit-code-driven `ok` and the raw streams; richer parsing is opt-in per
 * backend (e.g. the TypeScript backend parses bun:test JSON output).
 */
export interface TestRunSummary {
    ok: boolean;
    raw: {
        stdout: string;
        stderr: string;
        exitCode: number;
    };
    passed?: number;
    failed?: number;
    skipped?: number;
    durationMs?: number;
}
/**
 * Selected build command for a project.
 */
export interface BuildCommandSelection {
    /** Display name matching `LanguageProfile.build.commands[*].name`. */
    name: string;
    /** Spawn-arg array. Same constraints as TestFrameworkSelection.cmd. */
    cmd: string[];
    /** Explicit cwd. */
    cwd: string;
    /** Human-readable note: "Cargo.toml", "package.json#scripts.build", etc. */
    detectedVia: string;
}
/**
 * The behavior surface for a language. Every method is optional; the
 * default-backend implementation in `./default-backend.ts` provides
 * registry-driven fallbacks that work for most languages out of the box.
 */
export interface LanguageBackend extends LanguageProfile {
    /**
     * Stronger signal than extension matching alone. Default behavior
     * (provided by the default backend) checks that any of
     * `profile.build.detectFiles` is present in `dir`. A backend may override
     * to add language-specific heuristics (e.g. the TypeScript backend reads
     * `package.json#scripts.test` to confirm a test runner is configured).
     */
    detectProject?(dir: string): Promise<boolean>;
    /**
     * Pick the highest-priority test framework whose detect file exists in
     * `dir` AND whose binary is on PATH. Returns `null` if no framework is
     * configured + available. Default behavior consults
     * `profile.test.frameworks` sorted by priority and uses
     * `isCommandAvailable` from `src/build/discovery.ts`.
     */
    selectTestFramework?(dir: string): Promise<TestFrameworkSelection | null>;
    /**
     * Build the spawn argv for a given framework + file list. Default
     * behavior: append files to the framework's cmd unless `filesIgnored`.
     * Backends with non-trivial command shape (e.g. pwsh -EncodedCommand for
     * Pester) override this.
     */
    buildTestCommand?(framework: string, files: string[], dir: string): string[];
    /**
     * Parse stdout/stderr into a structured summary. Default behavior
     * returns only `{ ok: exitCode === 0, raw: { stdout, stderr, exitCode } }`
     * — no regex, no framework-specific assumptions. Backends that want
     * pass/fail counts (e.g. the TypeScript backend's bun:test JSON parser)
     * override this.
     */
    parseTestOutput?(framework: string, stdout: string, stderr: string, exitCode: number): TestRunSummary;
    /**
     * Map a source file to candidate test files (convention scope). Default
     * behavior: swap `src/` ↔ `tests/` and the extension to one of the
     * profile's test-file conventions. Returns the candidate paths sorted by
     * likelihood.
     */
    testFilesFor?(sourceFile: string, dir: string): Promise<string[]>;
    /**
     * Extract import paths from a source file (graph/impact scope). Default
     * behavior: returns `[]` — the analyzer falls back to convention scope
     * with an explicit "graph scope unavailable for {lang}" notice. Backends
     * with import-graph support (TypeScript, Python, Go in this phase set)
     * override this.
     */
    extractImports?(sourceFile: string, source: string): string[];
    /**
     * Pick the build command for this project. Default behavior consults
     * `profile.build.commands` sorted by priority + binary-on-PATH check.
     */
    selectBuildCommand?(dir: string): Promise<BuildCommandSelection | null>;
}
