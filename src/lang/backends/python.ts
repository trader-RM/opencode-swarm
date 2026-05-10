/**
 * Python backend.
 *
 * Phase 5 of language-agnostic plugin work. Overrides `extractImports`
 * with Python-specific import regexes (`import x`, `from x import y`)
 * so the test-impact analyzer can build a graph for Python projects.
 * Other hooks (selectTestFramework, selectBuildCommand, parseTestOutput,
 * testFilesFor) inherit the registry-driven defaults.
 *
 * Invariants (same as typescript.ts):
 *   - No subprocess calls; defers binary checks to `isCommandAvailable`.
 *   - No `bun:` imports, no `Bun.*` calls.
 *   - Backend-purity test in `tests/unit/lang/backend-purity.test.ts`
 *     enforces both at PR time.
 */

import type { LanguageBackend } from '../backend';
import { LANGUAGE_REGISTRY } from '../profiles';

const PROFILE_ID = 'python';

/**
 * Python import patterns.
 *
 *   `import foo`              → "foo"
 *   `import foo.bar`          → "foo.bar"
 *   `import foo as f`         → "foo"
 *   `import foo, bar`         → "foo", "bar" (rare, but valid)
 *   `from foo import x`       → "foo"
 *   `from foo.bar import x`   → "foo.bar"
 *   `from . import x`         → "." (relative; resolveRelativeImport handles)
 *   `from .foo import x`      → ".foo"
 *
 * Multi-line `from x import (\n  a,\n  b\n)` is captured (we only need
 * the module name from the `from` clause). Conditional/lazy imports
 * inside `if TYPE_CHECKING:` or `try: ... except ImportError:` are
 * captured as if they were unconditional — same fidelity the TypeScript
 * backend offers for `if (cond) require(...)`.
 */
const IMPORT_REGEX_FROM = /^\s*from\s+([\w.]+)\s+import\s+/gm;
const IMPORT_REGEX_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;

function extractImports(_sourceFile: string, source: string): string[] {
	const out = new Set<string>();

	IMPORT_REGEX_FROM.lastIndex = 0;
	let m: RegExpExecArray | null = IMPORT_REGEX_FROM.exec(source);
	while (m !== null) {
		out.add(m[1]);
		m = IMPORT_REGEX_FROM.exec(source);
	}

	IMPORT_REGEX_IMPORT.lastIndex = 0;
	m = IMPORT_REGEX_IMPORT.exec(source);
	while (m !== null) {
		// `import foo, bar` → split on commas, drop `as alias` segments.
		const modules = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]);
		for (const mod of modules) {
			if (mod.length > 0) out.add(mod);
		}
		m = IMPORT_REGEX_IMPORT.exec(source);
	}

	return [...out];
}

/**
 * Build the Python backend from the registered profile.
 */
export function buildPythonBackend(): LanguageBackend {
	const profile = LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) {
		throw new Error(
			'buildPythonBackend: python profile not in LANGUAGE_REGISTRY. ' +
				'profiles.ts must be imported before this backend.',
		);
	}
	return {
		...profile,
		extractImports,
	};
}

export const _internals: {
	extractImports: typeof extractImports;
} = { extractImports };
