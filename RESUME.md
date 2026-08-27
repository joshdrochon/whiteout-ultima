# Resume point — 2026-08-27, 11:10

## Paused: rivals cycle 2
Stopped mid-flight so the laptop could be closed. Completed agents replay from
cache on resume; only the agent that was running is lost.

    Workflow({
      scriptPath: "/Users/joanmiguel/.claude/projects/-Users-joanmiguel-Desktop-Developer-snowboard-gauntlet/17d1937a-bfbe-4270-ae51-384ba73ddf39/workflows/scripts/rivals-cycle2-wf_e1fd733b-d2a.js",
      resumeFromRunId: "wf_e1fd733b-d2a"
    })

Phase reached: both builders finished, measurers had just started.
Cycle 2's target is the cycle-1 gap: no rival has a line of its own.

## Decided, not yet built: rails balance model
Go to the SSX model. Our own corpus already said so and the lane ignored it —
references/research/02-turning-edge-friction.md sec 1.5:
  "To grind, just land on a rail, turn sideways to balance easier ... lock-on is
   automatic on contact, there is a light balance element handled by stance"
and the one real failure case:
  "you eventually will fall off for not turning" (curved rails)

Independent research confirms: in SSX grinding is AUTOMATICALLY BALANCED. The
balance meter you actively fight is TONY HAWK's design (Pro Skater 2 onward).
src/rails/rails.mjs implements Tony Hawk: a divergent mode
    b' = wn*(b + load + tex - steer)
that topples unless continuously corrected. It is wrong for the bar AND
unplayable on a keyboard, which gives +-1 or 0, not proportional input.

THE CHANGE:
 * straight rail  -> CONVERGENT, self-centring. The rider does not fight it.
 * curved rail    -> loaded by v^2 * k. Fail to steer and you come off.
 * skill lives in the approach, the rail spins and the exit — not survival.

GATES THAT ENCODE THE WRONG MODEL and must be REWRITTEN, not tuned:
 * GR-05  "balance drifts and bails with no input" — under SSX that is correct
          behaviour, not a defect.
 * GR-06  the authority model assumes a fight; it should measure that CURVES
          demand steering and STRAIGHTS do not.
 * GR-14  "arrival error costs time" — keep a light version; SSX rewards a clean
          landing without punishing like this.
Each needs its mutant updated too, or it is not a gate on this project.

## State
branch fix/rails-gate-law-gr11, 32 commits ahead of main, nothing merged.
npm test 25/25 (224 s — the rivals mutant table is wired in, 162 s of it).
sandbox/rivals/ is candidate scratch, untracked.

## Landed in the last day
 * rails input routing: st.onGround was unowned during a grind, so the stick
   went to `spin` instead of `steer`. 357 of 690 locks starved -> 0.
 * rivals lane law + audit: 5 escapes found and closed before any builder ran.
 * grinding scores: 3.05 s grind banks 394 pts, award "GRIND 3.0s".

## Still open
 * Rails balance model — decided above, not built.
 * She still falls off rails in play. Leading hypothesis, UNVERIFIED: the
   balance controller needs proportional input and the keyboard is bang-bang.
   The SSX change likely makes this moot.
 * No rail pose — poses are locked to the standing stance.
