/**
 * Go backend.
 *
 * Phase 5 of language-agnostic plugin work. Overrides `extractImports`
 * with Go-specific import regexes — both single-line `import "x"` and
 * grouped `import (\n "a"\n "b"\n)` forms — so the test-impact analyzer
 * can build a graph for Go projects.
 *
 * Invariants identical to other backends — see `python.ts` and
 * `typescript.ts` for the rationale; backend-purity test enforces.
 */

import type { LanguageBackend } from '../backend';
import { LANGUAGE_REGISTRY } from '../profiles';

const PROFILE_ID = 'go';

/**
 * Go import patterns.
 *
 *   `import "foo"`                       → "foo"
 *   `import alias "foo"`                 → "foo"
 *   `import _ "foo"`                     → "foo"  (side-effect import)
 *   `import . "foo"`                     → "foo"  (dot-import; rare)
 *   `import (\n "foo"\n alias "bar"\n)`  → "foo", "bar"
 *
 * The single-line and grouped forms are extracted separately. Comments
 * inside import groups (`// blah`) are not stripped — they don't match
 * the quoted-path pattern so they're naturally excluded.
 */
const IMPORT_REGEX_SINGLE =
	/^\s*import\s+(?:[a-zA-Z_.][a-zA-Z0-9_]*\s+)?"([^"]+)"/gm;
const IMPORT_REGEX_GROUP = /^\s*import\s*\(([\s\S]*?)\)/gm;
const IMPORT_REGEX_GROUP_LINE = /(?:[a-zA-Z_.][a-zA-Z0-9_]*\s+)?"([^"]+)"/g;

function extractImports(_sourceFile: string, source: string): string[] {
	const out = new Set<string>();

	// Single-line imports.
	IMPORT_REGEX_SINGLE.lastIndex = 0;
	let m: RegExpExecArray | null = IMPORT_REGEX_SINGLE.exec(source);
	while (m !== null) {
		out.add(m[1]);
		m = IMPORT_REGEX_SINGLE.exec(source);
	}

	// Grouped imports — match the parenthesized block, then iterate
	// quoted entries inside.
	IMPORT_REGEX_GROUP.lastIndex = 0;
	m = IMPORT_REGEX_GROUP.exec(source);
	while (m !== null) {
		const block = m[1];
		IMPORT_REGEX_GROUP_LINE.lastIndex = 0;
		let inner: RegExpExecArray | null = IMPORT_REGEX_GROUP_LINE.exec(block);
		while (inner !== null) {
			out.add(inner[1]);
			inner = IMPORT_REGEX_GROUP_LINE.exec(block);
		}
		m = IMPORT_REGEX_GROUP.exec(source);
	}

	return [...out];
}

/**
 * Build the Go backend from the registered profile.
 */
export function buildGoBackend(): LanguageBackend {
	const profile = LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) {
		throw new Error(
			'buildGoBackend: go profile not in LANGUAGE_REGISTRY. ' +
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
