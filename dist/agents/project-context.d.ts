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
import { detectProjectLanguages } from '../lang/detector';
import { pickBackend } from '../lang/dispatch';
import { type ProjectContext } from './template';
/**
 * Wall-clock budget for the session-init language-backend resolution step.
 * Caller (`src/index.ts:initializeOpenCodeSwarm`) wraps `buildProjectContext`
 * in `withTimeout(LANG_BACKEND_DETECTION_TIMEOUT_MS)`. Exceeding the budget
 * fails open with `null` so the manifest still returns to the OpenCode
 * plugin host (Invariant 1).
 */
export declare const LANG_BACKEND_DETECTION_TIMEOUT_MS = 2000;
declare const _internals: {
    pickBackend: typeof pickBackend;
    detectProjectLanguages: typeof detectProjectLanguages;
    isCommandAvailable: typeof isCommandAvailable;
};
export { _internals };
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
export declare function buildProjectContext(directory: string): Promise<ProjectContext | null>;
