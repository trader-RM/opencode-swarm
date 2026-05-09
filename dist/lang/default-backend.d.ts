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
import type { BuildCommandSelection, LanguageBackend, TestFrameworkSelection, TestRunSummary } from './backend';
import type { LanguageProfile } from './profiles';
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
export declare function tokenizeCommand(cmd: string): string[];
/**
 * Default selectTestFramework: highest-priority framework whose detect
 * file exists AND whose binary is on PATH. Returns null if none.
 */
export declare function defaultSelectTestFramework(profile: LanguageProfile, dir: string): Promise<TestFrameworkSelection | null>;
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
export declare function defaultBuildTestCommand(profile: LanguageProfile, framework: string, files: string[]): string[];
/**
 * Default parseTestOutput: exit-code-only. No regex, no framework-specific
 * assumptions. Backends that need pass/fail counts override.
 */
export declare function defaultParseTestOutput(stdout: string, stderr: string, exitCode: number): TestRunSummary;
/**
 * Default detectProject: any of `profile.build.detectFiles` is present in
 * `dir`. Honors simple glob patterns the same way `detectFileExists` does.
 */
export declare function defaultDetectProject(profile: LanguageProfile, dir: string): Promise<boolean>;
/**
 * Default selectBuildCommand: highest-priority command whose detectFile
 * (if specified) exists AND whose binary is on PATH. Returns null if none.
 */
export declare function defaultSelectBuildCommand(profile: LanguageProfile, dir: string): Promise<BuildCommandSelection | null>;
/**
 * Default testFilesFor: convention swap `src/<x>.<ext>` ↔ `tests/<x>.<ext>`
 * (and `tests/<x>_test.<ext>`, `tests/<x>.test.<ext>`). Returns candidates
 * sorted by likelihood. Best-effort — backends with established patterns
 * (e.g. Python's `tests/test_<x>.py`) override.
 */
export declare function defaultTestFilesFor(profile: LanguageProfile, sourceFile: string, dir: string): Promise<string[]>;
/**
 * Default extractImports: returns []. The analyzer treats this as
 * "graph scope unavailable for {lang}" and falls back to convention scope
 * with an explicit notice. Backends with parser-driven extraction
 * (TypeScript, Python, Go in the language-agnostic plan's Phase 5) override.
 */
export declare function defaultExtractImports(): string[];
/**
 * Build a backend object that delegates every hook to the registry-driven
 * defaults. Used by `pickBackend` when no language-specific override has
 * been registered. The returned object is a structural `LanguageBackend`
 * (it spreads the profile, then attaches default method bindings).
 */
export declare function defaultBackendFor(profile: LanguageProfile): LanguageBackend;
