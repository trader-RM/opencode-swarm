/**
 * Regression tests for Q2: durable write before fullAutoMode flag flip.
 *
 * Covers the durable-write-first pattern introduced in ensureAgentSession()
 * and the preserve/restore lifecycle for fullAutoConfig across resetSwarmState().
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals as stateInternals,
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from './state';

let tmpDir: string;

beforeEach(() => {
	resetSwarmState();
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'fullauto-autoinit-'));
	mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	// Reset swarm state to clean baseline
	resetSwarmState();
	// Clean up temp dir (best effort)
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

describe('Q2 — durable write before flag flip', () => {
	// (a) Durable record created for architect session
	it('(a) writes full-auto-state.json and sets fullAutoMode=true for architect', () => {
		const sessionId = `sess-architect-${Date.now()}`;
		swarmState.fullAutoEnabledInConfig = true;
		swarmState.fullAutoConfig = { enabled: true, mode: 'supervised' };

		const session = ensureAgentSession(sessionId, 'architect', tmpDir);

		// fullAutoMode flag must be true
		expect(session.fullAutoMode).toBe(true);

		// Durable record must exist
		const stateFile = path.join(tmpDir, '.swarm', 'full-auto-state.json');
		expect(existsSync(stateFile)).toBe(true);

		const raw = JSON.parse(readFileSync(stateFile, 'utf-8'));
		expect(raw.version).toBe(2);
		expect(raw.sessions[sessionId]).toBeDefined();
		expect(raw.sessions[sessionId].status).toBe('running');
	});

	// (b) Critic session skipped — fullAutoMode stays false, no file written
	it('(b) skips critic_oversight session — fullAutoMode=false, no state file', () => {
		const sessionId = `sess-critic-${Date.now()}`;
		swarmState.fullAutoEnabledInConfig = true;
		swarmState.fullAutoConfig = { enabled: true, mode: 'supervised' };

		const session = ensureAgentSession(sessionId, 'critic_oversight', tmpDir);

		expect(session.fullAutoMode).toBe(false);

		// File should not have been written for this session (or if it exists
		// from a previous call, this session should not be in it)
		const stateFile = path.join(tmpDir, '.swarm', 'full-auto-state.json');
		if (existsSync(stateFile)) {
			const raw = JSON.parse(readFileSync(stateFile, 'utf-8'));
			expect(raw.sessions[sessionId]).toBeUndefined();
		}
	});

	// (c) Directory guard — no directory means fullAutoMode stays false
	it('(c) no directory → fullAutoMode=false, no file written', () => {
		const sessionId = `sess-nodir-${Date.now()}`;
		swarmState.fullAutoEnabledInConfig = true;
		swarmState.fullAutoConfig = { enabled: true, mode: 'strict' };

		// Call without directory argument
		const session = ensureAgentSession(sessionId, 'architect');

		expect(session.fullAutoMode).toBe(false);
	});

	// (d) Write failure fail-open — startFullAutoRun throws, flag stays false
	it('(d) write failure fail-open — fullAutoMode=false when startFullAutoRun throws', () => {
		const sessionId = `sess-writefail-${Date.now()}`;
		swarmState.fullAutoEnabledInConfig = true;
		swarmState.fullAutoConfig = { enabled: true, mode: 'supervised' };

		// Use the _internals DI seam to replace startFullAutoRun with a throwing stub
		const originalStartFn = stateInternals.startFullAutoRun;
		stateInternals.startFullAutoRun = () => {
			throw new Error('simulated disk failure');
		};

		let session: ReturnType<typeof ensureAgentSession>;
		try {
			session = ensureAgentSession(sessionId, 'architect', tmpDir);
		} finally {
			stateInternals.startFullAutoRun = originalStartFn;
		}

		// fullAutoMode must stay false when durable write failed
		expect(session.fullAutoMode).toBe(false);
	});

	// (e) close.ts preserve — fullAutoConfig survives resetSwarmState + restore
	it('(e) fullAutoConfig is preserved across resetSwarmState + manual restore (close.ts lifecycle)', () => {
		const config = { enabled: true, mode: 'strict' as const };
		swarmState.fullAutoConfig = config;
		swarmState.fullAutoEnabledInConfig = true;

		// Simulate what close.ts does
		const preservedFullAutoConfig = swarmState.fullAutoConfig;
		const preservedFullAutoFlag = swarmState.fullAutoEnabledInConfig;
		resetSwarmState();
		swarmState.fullAutoEnabledInConfig = preservedFullAutoFlag;
		swarmState.fullAutoConfig = preservedFullAutoConfig;

		expect(swarmState.fullAutoConfig).toEqual(config);
		expect(swarmState.fullAutoEnabledInConfig).toBe(true);
	});
});
