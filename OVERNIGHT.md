# Overnight plan (2026-08-25 → 26)

**Constraint the user must know:** workflows run inside the Claude Code session
process. Terminal closed = everything stops. `caffeinate -dims` is running so the
machine itself will not sleep.

## Order
1. **run-structure** — remediation of winner A (11/11 gates incl. RS-11) → verify
   myself → promote to `src/run/run.mjs` → the pending suite hook becomes a real gate.
2. **rails & grinds** — lane law (contract + gates + runner + MUTANTS FIRST) → gauntlet.
3. **rivals / AI racers** — same, if time and usage allow.

## Standing rules for unsupervised work
- Promote only on: every HARD gate green, `run-mutants`-style self-test still
  catching 100%, and `npm test` green. Otherwise stop and leave it.
- **Cap each lane at 3 cycles.** If it has not closed, write findings to
  `BACKLOG.md` and move on. (The run lane cost five cycles; that is the reason
  this rule exists.)
- Mutants BEFORE builders on every new lane. Non-negotiable — four vacuous gates
  were caught this way in 4.6 s after five cycles failed to find them.
- Never weaken a gate to make a candidate pass. If a gate is wrong, prove it is
  wrong with a measurement and record the correction in the commit message.

## If you wake to a mess
- `git log --oneline -20` is the narrative; every commit says what was found.
- `npm test` (19 tests) is the truth about current state.
- `BACKLOG.md` holds anything I stopped on.
