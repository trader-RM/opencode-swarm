# Plan: Fix fullAutoMode Auto-Init Bugs (Q2 + Q4)

**Repo:** `D:\AI\Plugins\Swarm`
**Primary file:** `src/state.ts` — `ensureAgentSession()`
**Mode:** Direct (edit-in-place, no branch/PR — uncommitted changes already in-flight)
**Created:** 2026-05-17

---

## Problem Summary

Two production bugs were introduced by the `fullAutoMode` auto-init change in `ensureAgentSession()`:

**Q2 — Missing durable write (BUG — MUST FIX)**
`session.fullAutoMode` is set to `true` without calling `startFullAutoRun()`. The v2 permission gate (`full-auto-permission.ts`) reads `full-auto-state.json` on every high-risk tool call and silently skips all enforcement when no entry exists for the session. Result: the reactive intercept fires but the permission gate, pause/terminate machinery, and shell-level enforcement are all dark.

**Q4 — Scope bleed (BUG — MUST FIX)**
`fullAutoMode = true` is applied to every new session, including `critic_oversight` and `critic` ephemeral sessions. The `hasActiveFullAuto(sessionId)` primary gate then returns `true` for critic sessions, leaving only the secondary agent-name filter at line 786-787 as the sole guard against recursive intercept dispatch.

---

## Steps

### Step 1 — Q4: Add agentName guard (haiku model)

**Can run:** Immediately. No dependency on Step 2.
**File:** `src/state.ts` lines 807–811

**Context brief (self-contained for a cold-start agent):**
In `ensureAgentSession()` (line 617), after a new session is created and the `if (!session)` throw guard, there is a block that auto-initializes `fullAutoMode`:
```typescript
if (swarmState.fullAutoEnabledInConfig) {
    session.fullAutoMode = true;
}
```
This block sets the flag for ALL new sessions, including `critic_oversight` and `critic` sub-agent sessions. The `agentName` parameter (line 619, `agentName?: string`) holds the raw agent name. Use `stripKnownSwarmPrefix` (already imported from `./config/schema` at line 15) to strip any swarm prefix, then only allow `'architect'` and `'unknown'` to inherit the flag.

**Task list:**
1. Read `AGENTS.md` and skim `docs/engineering-invariants.md` (required by engineering contract before any change to `src/state.ts`)
2. Load `.claude/skills/engineering-conventions/SKILL.md`
3. In `ensureAgentSession()`, change the guard from:
   ```typescript
   if (swarmState.fullAutoEnabledInConfig) {
       session.fullAutoMode = true;
   }
   ```
   to:
   ```typescript
   const strippedInitName = stripKnownSwarmPrefix(agentName ?? 'unknown');
   if (
       swarmState.fullAutoEnabledInConfig &&
       (strippedInitName === 'architect' || strippedInitName === 'unknown')
   ) {
       session.fullAutoMode = true;
   }
   ```
4. Run `bun run typecheck` — must exit 0
5. Run `bun run lint` — must exit 0

**Verification:**
- `bun run typecheck` exits 0
- `bun run lint` exits 0
- The variable name `strippedInitName` must not shadow any outer variable

**Exit criteria:** typecheck and lint pass; the guard correctly restricts auto-init to architect and unknown sessions only.

---

### Step 2 — Q2: Add durable write (sonnet model)

**Depends on:** Step 1 (both touch the same block; apply sequentially)
**Files:** `src/state.ts`, `src/index.ts`, `src/commands/close.ts`

**Context brief (self-contained for a cold-start agent):**

The `fullAutoMode` auto-init sets `session.fullAutoMode = true` but never writes to `full-auto-state.json`. The v2 permission gate in `full-auto-permission.ts` calls `loadFullAutoRunState(directory, sessionID)` on every high-risk tool call and exits early when it returns `undefined` (no entry in file).

The fix requires:
1. **Store the config shape on swarmState** — `startFullAutoRun()` in `src/full-auto/state.ts` (line 419) accepts `config: FullAutoConfigShape | undefined`. `swarmState` currently only stores `fullAutoEnabledInConfig: boolean`, not the full config. Add a `fullAutoConfig: FullAutoConfigShape | undefined` field to `swarmState` and set it in `src/index.ts` alongside `fullAutoEnabledInConfig`.

2. **Write the durable record before flipping the flag** — In `ensureAgentSession()`, after the agentName guard from Step 1 passes, call `startFullAutoRun(directory, sessionId, swarmState.fullAutoConfig)` inside a try/catch. Only set `session.fullAutoMode = true` if the write succeeds. If it fails or `directory` is unavailable, skip the auto-init entirely (fail-open — session gets `fullAutoMode: false`, same as pre-fix behavior).

**Invariant:** The "durable write first, then flip the flag" discipline from `src/commands/full-auto.ts` (comments at lines 18-22) must be preserved identically here.

**Circular dependency check:** `full-auto/state.ts` does NOT import from `state.ts` — adding the import is safe.

**Task list:**
1. Read `AGENTS.md` and skim `docs/engineering-invariants.md`
2. Load `.claude/skills/engineering-conventions/SKILL.md`
3. In `src/state.ts`, add import for `startFullAutoRun` and `FullAutoConfigShape`:
   ```typescript
   import {
       type FullAutoConfigShape,
       startFullAutoRun,
   } from './full-auto/state.js';
   ```
4. Locate the `swarmState` object definition and add field:
   ```typescript
   /** Full-auto config shape stored at plugin init for auto-init durable writes */
   fullAutoConfig: undefined as FullAutoConfigShape | undefined,
   ```
   Also add the reset in `resetSwarmState()`:
   ```typescript
   swarmState.fullAutoConfig = undefined;
   ```
5. In `src/index.ts`, after the line `swarmState.fullAutoEnabledInConfig = config.full_auto?.enabled === true;`, add:
   ```typescript
   swarmState.fullAutoConfig = config.full_auto;
   ```
6. In `src/commands/close.ts`, find the block around lines 986–996 that preserves `fullAutoEnabledInConfig` across `resetSwarmState()`. Add a parallel preserve/restore for `fullAutoConfig` — the two fields share identical lifecycle (set once at plugin init, never re-populated). Without this, `/swarm close` + re-init loses the user's configured `mode`, `denials.max_consecutive`, etc., causing subsequent auto-inits to always use `'supervised'` defaults:
   ```typescript
   const preservedFullAutoConfig = swarmState.fullAutoConfig;
   // (existing code) const preservedFullAutoFlag = swarmState.fullAutoEnabledInConfig;
   // ... resetSwarmState() call ...
   // (existing code) swarmState.fullAutoEnabledInConfig = preservedFullAutoFlag;
   swarmState.fullAutoConfig = preservedFullAutoConfig;
   ```
7. In `ensureAgentSession()`, replace the auto-init block (after Step 1's agentName guard) with the durable-write-first pattern. Use `directory && directory.trim().length > 0` (not just `&& directory`) to guard against whitespace-only paths that are truthy but would cause `startFullAutoRun` to write `.swarm` in CWD:
   ```typescript
   const strippedInitName = stripKnownSwarmPrefix(agentName ?? 'unknown');
   if (
       swarmState.fullAutoEnabledInConfig &&
       (strippedInitName === 'architect' || strippedInitName === 'unknown') &&
       directory &&
       directory.trim().length > 0
   ) {
       try {
           startFullAutoRun(directory, sessionId, swarmState.fullAutoConfig);
           session.fullAutoMode = true;
       } catch (err) {
           logger.warn('[auto-init] durable full-auto write failed — skipping flag set', {
               sessionId,
               err: err instanceof Error ? err.message : String(err),
           });
           // fullAutoMode stays false — fail-open
       }
   }
   ```
8. Run `bun run typecheck` — must exit 0
9. Run `bun run lint` — must exit 0

**Verification:**
- `bun run typecheck` exits 0
- `bun run lint` exits 0
- `swarmState.fullAutoConfig` is typed as `FullAutoConfigShape | undefined`
- The flag is only set AFTER `startFullAutoRun()` returns without throwing

**Exit criteria:** typecheck and lint pass; durable write happens before flag is set; write failure results in `fullAutoMode: false` (fail-open); `close.ts` preserve/restore is present for `fullAutoConfig`.

---

### Step 2.5 — Regression tests (sonnet model, parallel with Step 3 feasibility)

**Depends on:** Step 2 complete
**File:** `src/state.fullauto-autoinit.test.ts` (new file)
**Load skill:** `.claude/skills/writing-tests/SKILL.md` before writing

**Task list:**
1. Read `AGENTS.md` and load `.claude/skills/writing-tests/SKILL.md`
2. Write a Bun/Vitest test file covering:
   - (a) **Durable record created**: `ensureAgentSession()` with `agentName='architect'`, valid directory, `fullAutoEnabledInConfig=true` → `full-auto-state.json` entry exists with `status: 'running'` and `session.fullAutoMode === true`
   - (b) **Critic skipped**: `agentName='critic_oversight'` → `session.fullAutoMode === false`, no durable record written
   - (c) **Directory guard**: no `directory` arg → `session.fullAutoMode === false`, no file write
   - (d) **Write failure fail-open**: mock `startFullAutoRun` to throw → `session.fullAutoMode === false`
   - (e) **close.ts preserve**: after `resetSwarmState()` + restore, `swarmState.fullAutoConfig` equals pre-reset value
3. Run `bun test src/state.fullauto-autoinit.test.ts` — all tests must pass

**Exit criteria:** All 5 regression tests pass; no mock leakage across test cases (use `afterEach` restore pattern per writing-tests skill).

---

### Step 3 — Full build + adversarial re-review (opus model)

**Depends on:** Steps 1 and 2 complete
**Files:** Read-only review of `src/state.ts`, `src/commands/full-auto.ts`, `src/full-auto/state.ts`, `src/hooks/full-auto-permission.ts`, `src/hooks/full-auto-intercept.ts`

**Task list:**
1. Run `bun run typecheck` in `D:\AI\Plugins\Swarm` — must exit 0 before build
2. Run `bun run build` — must succeed
3. Adversarially review the combined changes from Steps 1, 2, and 2.5:
   - **Q2 check:** Does `startFullAutoRun()` get called before `session.fullAutoMode = true`? Is the try/catch fail-open (flag stays false on error)?
   - **Q4 check:** Does `stripKnownSwarmPrefix` correctly strip swarm prefixes? Does `'critic_oversight'` and `'critic'` correctly fail the guard?
   - **Directory guard:** Is `directory && directory.trim().length > 0` present (not just `&& directory`)?
   - **close.ts check:** Is `fullAutoConfig` preserved and restored across `resetSwarmState()` in `src/commands/close.ts`?
   - **Import check:** Does adding `import { startFullAutoRun }` from `./full-auto/state.js` introduce any circular dependency or `bun:` import violation (AGENTS.md Invariant 2)?
   - **Reset check:** Is `swarmState.fullAutoConfig = undefined` in `resetSwarmState()` present?
   - **Config timing (Q5):** Is there still a window where `fullAutoConfig` is unset when the first session is created?
   - **Tests:** Do all 5 regression tests pass?
4. Report verdict: APPROVE / APPROVE_WITH_NOTES / REJECT with specific evidence for each check

**Exit criteria:** Build succeeds; adversarial review returns APPROVE or APPROVE_WITH_NOTES with no MUST-FIX findings.

---

## Dependency Graph

```
Step 1 (Q4 guard) → Step 2 (Q2 durable write) → Step 2.5 (regression tests) → Step 3 (build + review)
```

Steps 1 and 2 must be sequential (same block, same function). Step 2.5 and Step 3 both depend on Step 2 and can be composed sequentially in the same agent run.

## Rollback

If Step 2 fails typecheck or the adversarial review returns REJECT:
- Revert to the Step-1-only state: the agentName guard prevents scope bleed (Q4 fixed), and `fullAutoMode` auto-init is suppressed for all sessions where directory is unavailable or the write fails (fail-open).
- This is safer than the pre-fix state (no Q4 bug) but still has Q2 (no durable write for successful auto-inits).

## Invariant Audit (per AGENTS.md)

| Invariant | How verified |
|-----------|-------------|
| 1. Init is bounded, fail-open | `startFullAutoRun` wrapped in try/catch; flag only set on success; no unbounded IO added to init path |
| 2. Runtime portability | Import from `./full-auto/state.js` — no `bun:` imports; checked for circular dependency |
| 3. Subprocess safety | No subprocess changes |
| 4. Test mock isolation | No test changes in Steps 1-2; Step 3 reviewer checks for any leakage |
