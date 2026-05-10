/**
 * Build a `ProjectContext` for agent prompt template substitution.
 *
 * Called from `src/index.ts:initializeOpenCodeSwarm` immediately before
 * `getAgentConfigs(...)` (Phase 4b of the language-agnostic plugin work).
 * Wrapped in `withTimeout(2000ms)` by the caller; on timeout or any
 * failure, the caller falls open to `emptyProjectContext()` per
 * Invariant 1 (plugin init bounded + fail-open).
 *
 * Imported lazily by the caller via `await import('./agents/project-context')`
 * to keep the dispatch import graph off the synchronous init prelude.
 */

import { isCommandAvailable } from '../build/discovery';
import type { LanguageBackend } from '../lang/backend';
import { detectProjectLanguages } from '../lang/detector';
import { pickBackend } from '../lang/dispatch';
import {
	bulletList,
	emptyProjectContext,
	type ProjectContext,
	UNRESOLVED,
} from './template';

/**
 * Wall-clock budget for the session-init language-backend resolution step.
 * Caller (`src/index.ts:initializeOpenCodeSwarm`) wraps `buildProjectContext`
 * in `withTimeout(LANG_BACKEND_DETECTION_TIMEOUT_MS)`. Exceeding the budget
 * fails open with `null` so the manifest still returns to the OpenCode
 * plugin host (Invariant 1).
 */
export const LANG_BACKEND_DETECTION_TIMEOUT_MS = 2_000;

const _internals: {
	pickBackend: typeof pickBackend;
	detectProjectLanguages: typeof detectProjectLanguages;
	isCommandAvailable: typeof isCommandAvailable;
} = {
	pickBackend,
	detectProjectLanguages,
	isCommandAvailable,
};
export { _internals };

/**
 * Pick the highest-priority linter whose detect file is present and whose
 * binary is on PATH. Returns the lint command as a string (e.g.
 * "biome check --write ."), or null if no linter is configured + available.
 */
function selectLintCommand(
	backend: LanguageBackend,
	directory: string,
): string | null {
	const fs = require('node:fs') as typeof import('node:fs');
	const path = require('node:path') as typeof import('node:path');
	const sorted = [...backend.lint.linters].sort(
		(a, b) => b.priority - a.priority,
	);
	for (const lint of sorted) {
		// detect can be a glob; for now just probe the literal filename.
		const detectFilePath = path.join(directory, lint.detect);
		try {
			fs.accessSync(detectFilePath);
		} catch {
			continue;
		}
		const argv = lint.cmd.split(/\s+/).filter(Boolean);
		if (argv.length === 0) continue;
		if (!_internals.isCommandAvailable(argv[0])) continue;
		return lint.cmd;
	}
	return null;
}

/**
 * Resolve the `ProjectContext` for `directory`. Uses `pickBackend` to find
 * the dominant language, then queries `backend.selectBuildCommand`,
 * `backend.selectTestFramework`, and `selectLintCommand` to populate the
 * single-value fields. Pulls per-language coder/test/reviewer constraint
 * lists from `backend.prompts`.
 *
 * Returns `null` (caller substitutes `emptyProjectContext()`) when no
 * backend is detected — the architect's existing DISCOVER mode handles
 * the resulting `unresolved` sentinel placeholders.
 */
export async function buildProjectContext(
	directory: string,
): Promise<ProjectContext | null> {
	const backend = await _internals.pickBackend(directory);
	if (!backend) return null;

	const ctx: ProjectContext = emptyProjectContext();
	ctx.PROJECT_LANGUAGE = backend.displayName;

	const buildSel = await backend.selectBuildCommand?.(directory);
	if (buildSel) {
		ctx.BUILD_CMD = buildSel.cmd.join(' ');
	}

	const testSel = await backend.selectTestFramework?.(directory);
	if (testSel) {
		ctx.TEST_CMD = testSel.cmd.join(' ');
	}

	const lintCmd = selectLintCommand(backend, directory);
	if (lintCmd) {
		ctx.LINT_CMD = lintCmd;
	}

	// Per-language prompt blocks. Bulleted, escaped for template-literal
	// safety. Defaults to empty string (not the UNRESOLVED sentinel) when
	// the profile has no constraints, so the rendered prompt has no
	// fake-bullet noise.
	if (backend.prompts.coderConstraints.length > 0) {
		ctx.CODER_CONSTRAINTS = bulletList(backend.prompts.coderConstraints);
	}
	if (
		backend.prompts.testConstraints &&
		backend.prompts.testConstraints.length > 0
	) {
		ctx.TEST_CONSTRAINTS = bulletList(backend.prompts.testConstraints);
	}
	if (backend.prompts.reviewerChecklist.length > 0) {
		ctx.REVIEWER_CHECKLIST = bulletList(backend.prompts.reviewerChecklist);
	}

	// Secondary languages: list the runner-up profile ids when more than
	// one is detected. Empty string when only the primary is present.
	const profiles = await _internals.detectProjectLanguages(directory);
	if (profiles.length > 1) {
		ctx.PROJECT_CONTEXT_SECONDARY_LANGUAGES = profiles
			.slice(1)
			.map((p) => p.id)
			.join(', ');
	}

	// PROJECT_FRAMEWORK and ENTRY_POINTS stay UNRESOLVED in this phase —
	// framework detection (React/Vue/Django/Rails/etc.) is best done in a
	// follow-up pass with src/lang/framework-detector.ts.
	void UNRESOLVED;

	return ctx;
}
