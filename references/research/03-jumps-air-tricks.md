# SSX Tricky — Jump Arcs, Air Tricks, Combos, Uber/Boost Economy

Reference bar for judging a Three.js/JS/GLSL recreation. Facts labeled **[VERIFIED]** come
from primary guides/manual text (retrieved via Wayback Machine where GameFAQs blocks direct
fetch). Facts labeled **[ESTIMATE]** are derived targets from footage/guide descriptions;
treat them as tolerance bands, not gospel.

Primary sources used throughout:

- Uber Trick Guide (Jay Higa / The_JRage), GameFAQs — https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14818 (full text also at https://www.cheatcodes.com/guide/uber-trick-guide-ssx-tricky-ps2-22240/)
- Spins and Flips Guide (LLCoolDave), GameFAQs — https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/24198
- Strategy Guide / Master Runs (gondee, ssx4ever, DDRKirby et al.), GameFAQs — https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14936
- Showoff Guide (Wolf_Feather), GameFAQs — https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/17492
- Guide and Walkthrough (brian_sulpher), GameFAQs — https://gamefaqs.gamespot.com/gamecube/529307-ssx-tricky/faqs/22225
- SSX Tricky Xbox instruction manual (full text) — https://archive.org/stream/xboxmanual_Ssx_Tricky/Ssx_Tricky_djvu.txt
- StrategyWiki SSX (2000) controls (series-baseline mechanics) — https://strategywiki.org/wiki/SSX/Controls
- SuperCheats faster-spins technique — https://www.supercheats.com/playstation2/ssx-tricky/5164/faster-spins/

---

## 1. Jump mechanics (pre-load / crouch)

**[VERIFIED — mechanics]**

- Jump is a charge-and-release: "When held, it will crouch your rider in the ready
  position for a jump. The longer it is held, the higher the jump." (brian_sulpher guide,
  GC controls). Manual: "Press and hold ... to crouch, then release it to jump before you
  reach the end of the ramp. ... The longer you stay in the crouch position the higher you
  fly." (Xbox manual)
- While crouched you cannot steer (series baseline, StrategyWiki SSX/Controls: "When
  holding down you cannot steer"). Crouching also makes you go faster on the ground
  (StrategyWiki: "hold to crouch and go faster").
- "Boost-jump" is a standard high-level technique: hold boost through the lip and jump at
  the very last moment off the ramp edge for max air (Wolf_Feather: "At the last possible
  millisecond, boost-jump off the cliff"; gondee: "prewind and hold boost, then jump as
  you go off the sides").
- Jumping at the very end/top of the ramp matters — releasing early wastes the lip
  (multiple master-run notes: "jump off the very end", "jumping just as you get to the
  very top of the jump").

**[ESTIMATE — numbers for implementation]**

- Charge time to full pre-load: ~0.5–1.0 s of held crouch; longer holds clamp at max.
- Pop (jump impulse) range: uncharged tap ≈ 40–50% of fully charged pop.
- Fully charged flat-ground pop: ~1.0–1.2 s of airtime on flat (rider clears ~1.5–2 m);
  ramp/cliff airtime is dominated by geometry + horizontal speed, not the pop.
- Jump horizontal distance scales linearly with ground speed at takeoff (velocity is
  preserved into the air); boost before the lip visibly lengthens the arc — treat air
  trajectory as ballistic with takeoff velocity = ground velocity + pop along ramp normal.

## 2. Hang time feel

No first-party numbers exist; targets are derived from what guides say fits into a jump.

**[VERIFIED — qualitative anchors]**

- A quick (difficulty ~1.0–1.5) uber can be started and finished on an ordinary
  ramp/embankment jump; guides call these "quick Ubers" and routinely fit **two** of them
  on a boosted ramp or halfpipe-wall jump (gondee Elysium master run; ElysiumKaori run).
- Character/signature ubers "take longer to execute than most general Ubers" (Uber Trick
  Guide) and one fits per large jump; the biggest cliff jumps fit **two character ubers
  plus "a quick grab or a few spins"** (Wolf_Feather, Garibaldi cliff), or **three quick
  ubers** (ElysiumKaori step 14: "3 ubers through it for 250K").
- Ubers cannot be interrupted; their animation must finish before landing or you crash
  (Uber Trick Guide).

**[ESTIMATE — target durations]**

- Quick uber animation: ~1.0–1.3 s. Character uber animation: ~2.0–2.5 s.
- Therefore: ordinary ramp jump ≈ 1.2–1.8 s air; boosted big ramp ≈ 2.5–3.5 s; monster
  cliff/vent jumps ≈ 4–5.5 s (2 char ubers ≈ 4.5 s + grab margin).
- A recreation should make "big air" land in the 3–5 s band and normal trick air in the
  1.5–2.5 s band.

## 3. Air control: spins and flips

**[VERIFIED — mechanics]**

- Pre-wind: "When a player is crouched to jump, hold a direction to pre-wind the jump to
  cause your boarder to spin/flip that way. **The longer you pre-wind, the faster your
  boarder will spin/flip around.**" (brian_sulpher, GC controls)
- Faster-spin release trick: hold jump + direction, release jump just before the lip while
  keeping direction held → faster spin (SuperCheats).
- In-air stick continues/steers rotation; releasing rotation input lets the rider
  auto-level to prepare landing. Left stick also fine-tunes attitude to the landing slope
  (Wolf_Feather: "use the L3 stick to fine-tune the character's position in relation to
  the slope of the ground").
- Recognized rotation is quantized in 180° increments, 180→1800 for spins; flips in 360°
  units up to triple (1080°). Spins and flips combine freely (e.g. Ligament 900 = 1080°
  front flip + 900° right spin). **Cap: more than 1800° spin or ≥4 flips displays the
  trick as "???"** (LLCoolDave Spins and Flips Guide).
- Max combined rotation observed with maxed stats on big Elysium drops: triple flip
  (1080°) simultaneous with up to 1800° spin (LLCoolDave tested all listed combos there).
- "Trick boost" pickup (series baseline, SSX 1): "makes you spin and flip faster for one
  trick" (StrategyWiki). Trick stat raises rotation speed; guides tell low-stat players to
  use trick boosts to complete hard rotations (gondee trick-book tips).

**[ESTIMATE — rates]**

- Max spin rate (full pre-wind, high Trick stat): 1800° over a ~3.0–3.5 s big-air jump ≈
  **520–600 °/s**. The canonical feel check: a 900 completes in ~1.5 s ≈ **600 °/s**.
- No-pre-wind stick-only spin: roughly half — **250–350 °/s**.
- Flip rate: 1080° flip alongside a 1800° spin on the same ~3.2 s air ≈ **310–360 °/s**
  max; single stylish flips read at ~250–300 °/s.
- Rotation ramps up over the first ~0.2 s and stops within ~0.1–0.2 s of releasing input
  (rotation is animation-driven and snappy, not momentum-conserving).

## 4. Landing rules (clean vs crash)

**[VERIFIED — crash conditions]** (Uber Trick Guide "you will lose ability to do Ubers
immediately if you..." list + landing section; Xbox manual)

1. Uber animation not finished at touchdown → crash.
2. Landing while still holding a grab → crash (grabs must be released "to prepare for
   landing" — manual).
3. Landing mid-way through a *large* rotation → crash; **"you can botch up small
   rotations as long as you don't grab"** — small under-rotations auto-correct without a
   fall (Uber Trick Guide, note under item 5).
4. Falling off a cliff / into water → crash + uber-ready lost; out-of-bounds resets after
   a fall timeout (~30–60 s in glitch-shortcut descriptions, gondee).
5. Landing sideways-but-close snaps to regular or fakie/switch stance; alpine boards
   cannot ride switch, so a backwards landing on alpine forces a slow turn-around
   (StrategyWiki alpine note; brian_sulpher Brodi bio: alpine "does not allow" switch).
6. Crashing into obstacles or being shoved knocks you down and drains meter but does NOT
   remove earned TRICKY letters/uber-ready status (Uber Trick Guide).
7. Trick points bank **only on successful landing**; multiplier stars "only multiply the
   trick/Ubertrick value upon a successful landing" (Wolf_Feather). No points for tricks
   ending beyond the finish line (Wolf_Feather).

**[ESTIMATE — alignment tolerance]**

- Yaw: within ±45° of straight (regular or fakie) snaps clean; between ~45° and ~90°
  wobbly-but-saved; beyond ~90° of an incomplete commanded spin → crash.
- Pitch/flip: incomplete flip beyond ~30–45° from board-down → faceplant/scorpion.
- Auto-level assist engages when rotation input is released, at roughly the rider's
  auto-level rate (~180–270 °/s), which is what makes "release early, land clean" the
  core skill loop.

## 5. Trick scoring

**[VERIFIED]**

- Trick families: grabs (shoulder-button combos, 15 combinations per character), tweaks
  (boost button during a grab — modifies the grab; "Tweaking does not give you any more
  points than an ordinary grab" in SSX 1 baseline, but in Tricky tweaks add difficulty/
  points per the manual: "You receive higher points as the difficulty level rises"),
  spins/flips in 180°/360° steps, rail grinds, and uber tricks.
- Grab score accrues with hold time — PD's "cheap trick" exploit works precisely because
  "the score continues to rack up, even though you've let go of the grab ... a few
  hundred if not a thousand extra points on each jump" (gondee guide) → a held grab is
  worth on the order of **hundreds of points per second** of hold.
- **Repetition penalty: "each repetition cuts the total points for the trick or Ubertrick
  by half of what was awarded when it was previously performed"** (Wolf_Feather). Manual:
  "If you keep trying the same trick, the Trick Points for that trick decrease." Varying
  spin direction/amount counts as a different trick for this rule.
- Flips are worth more than equivalent spins (multiple guides' tips sections).
- Uber base values (performed immediately on jump, no spins/flips/grabs added — Uber
  Trick Guide, PS2, values reproduced in full below): min **13,210** (Benihana/Blender),
  max **22,580** (Pommel Me, SuperMan BarSpin).

Full uber table **[VERIFIED]** (points; guide's derived 1–10 "difficulty" ≈ animation
length rank; F/B/A = freestyle/BX/alpine board; * = character-specific):

| Uber | Pts | Diff | | Uber | Pts | Diff |
|---|---|---|---|---|---|---|
| Benihana (B) | 13210 | 1.0 | | FrogHop (B) | 16140 | 3.8 |
| Blender (B) | 13210 | 1.0 | | StuntMan (A) | 16140 | 3.8 |
| Airwalk (A) | 13390 | 1.2 | | The Rake (B) | 16140 | 3.8 |
| CliffHanger (F) | 13390 | 1.2 | | Torpedo (B) | 16510 | 4.2 |
| Cordova (A) | 13390 | 1.2 | | BodyBoard (F) | 16870 | 4.5 |
| Dervish (A) | 13390 | 1.2 | | GutBuster (F) | 17240 | 4.9 |
| Hart Attack (A) | 13390 | 1.2 | | Near Miss (B) | 17240 | 4.9 |
| Heel Clicker (F) | 13390 | 1.2 | | Hang 10 Backflip (A)* | 17290 | 4.9 |
| LazyBoy (A) | 13390 | 1.2 | | Pirouette Grind (F)* | 17290 | 4.9 |
| Madonna (A) | 13390 | 1.2 | | Aerial Spock 540 (A)* | 17900 | 5.5 |
| Mulisha (A) | 13390 | 1.2 | | Proper Propellor (F) | 19260 | 6.8 |
| Nac Nac (B) | 13390 | 1.2 | | Magician (F) | 19990 | 7.5 |
| Nothing (B) | 13390 | 1.2 | | Guillotine (B)* | 20750 | 8.2 |
| Sad Sack (F) | 13390 | 1.2 | | Walking The Dog (F)* | 20960 | 8.4 |
| SuperMan (F) | 13390 | 1.2 | | Worm (F)* | 21360 | 8.8 |
| Indian (B) | 13760 | 1.5 | | Headspin2Poseur (F)* | 21770 | 9.2 |
| Judo (B) | 13760 | 1.5 | | Soul Grind (F)* | 21770 | 9.2 |
| Paddle Wheel (F) | 13760 | 1.5 | | Bronco Buster (B)* | 22380 | 9.8 |
| Scooter (F) | 13760 | 1.5 | | La La La Lock Step (B)* | 22380 | 9.8 |
| Coffin Roll (A) | 13940 | 1.7 | | Pommel Me (B)* | 22580 | 10.0 |
| Footloose (B) | 13940 | 1.7 | | SuperMan BarSpin (B)* | 22580 | 10.0 |
| Iron Cross (A) | 14120 | 1.9 | | | | |
| Can Can (F) | 14310 | 2.1 | | | | |
| Hand in Hand (F) | 14310 | 2.1 | | | | |
| Bar Hop (B) | 14490 | 2.2 | | | | |
| Triple H (A) | 15220 | 2.9 | | | | |
| FloorBoard (A) | 15410 | 3.1 | | | | |

- "Generally, the longer it takes to do an Uber, the more difficult it is, and the more
  points it gives." Point values and execution time are **independent of character/board
  stats** (Uber Trick Guide).
- Ubers are board-type-locked (each trick only exists on one board type) and
  character-specific ubers need the character's preferred board (Uber Trick Guide).

**[ESTIMATE — base non-uber values]**

- Exact per-180° spin values were not recoverable from surviving sources. Working
  targets consistent with master-run tallies ("a few hundred ... extra points" per grab;
  100K from 3 quick-uber jumps): simple grab ≈ 500–1,500 + accrual while held; each 180°
  of spin ≈ 100–300; each flip ≈ 300–600; values scale up with combined trick names
  (Misty/Rodeo composites worth more than parts). Non-uber airs are worth on the order of
  1,000–8,000 vs 13,000–22,600 for ubers — ubers should dominate scoring ~3–10×.

## 6. Combos and multipliers

**[VERIFIED]**

- All tricks performed within one air sum, and the sum banks on landing. Master-run
  arithmetic confirms multipliers apply to the whole jump's trick total:
  - 2 character ubers (≈20,960 × 2) through a 3x flake ≈ "about 130K" (gondee) —
    20,960×2×3 = 125,760. ✓
  - 3 quick ubers (≈16,000 × 3) through a 5x red flake = "250K" (ElysiumKaori). ✓
  - Character uber + Hand in Hand through red 5x = "BIG points - 250K" (gondee) —
    (22,000+14,310+spins/grabs)×5 ≈ 200–250K. ✓
- Showoff multiplier pickups (floating stars/snowflakes): **yellow = 2x, orange = 3x,
  red = 5x**. If several are hit in one jump, **only the highest-value one counts**, and
  the multiplier is credited **only on a successful landing** (Wolf_Feather).
- Doing two ubers in one jump credits two TRICKY letters — each individual completed
  uber counts (Uber Trick Guide).
- Cross-jump "combo chains" (SSX 3-style ride-outs) do **not** exist in Tricky; the
  anti-repetition halving rule plus per-jump multiplier pickups are the whole combo
  economy. Knockdown shoves are part of scoring/economy play (full meter on a landed
  shove — brian_sulpher, Uber Trick Guide).

## 7. Boost / adrenaline economy

**[VERIFIED]**

- Landing tricks fills the adrenaline (boost/"Tricky") meter; failing a trick, hitting
  obstacles, pressing Select, or falling drains it (Uber Trick Guide). Manual adds decay:
  "Adrenaline decreases over time and when you fall. The longer you ride without jumping,
  the more your Adrenaline Meter decreases."
- **A landed shove/knockdown of an opponent instantly fills the meter to full** (Uber
  Trick Guide; brian_sulpher C-stick note).
- Full meter → uber-ready state (rotating red disc). Uber-ready persists "for a while"
  and is maintained by landing more tricks; it is lost by: too long without tricks, too
  long without doing an uber, failing an uber, falling out of any grab trick, falling out
  of a high-rotation jump, cliff/water fall, or pressing Select (Uber Trick Guide, 7-item
  list). Obstacle collisions/shoves do NOT remove uber-ready (only meter).
- **TRICKY status: 6 individually landed ubers light the six letters → unlimited boost +
  unlimited ubers for the rest of the run; cannot be lost; does not carry to the next
  heat** (Uber Trick Guide).
- Spending: hold boost button to accelerate. Tap-boosting exploit: tapping instead of
  holding makes the boost last "almost three times as long" at near-top speed (gondee).
- Repeating the same trick reduces the boost gained as well as the points (StrategyWiki
  series baseline: "the trick points and boost you get decrease").
- Speed-boost pickup gives full-strength boost for ~5 s (StrategyWiki, SSX 1 baseline).

**[VERIFIED anchor for fill rate]** "Generally, three of these [misty/rodeo flip tricks
off a plateau lip] are required to completely fill the Trick Meter, thus enabling
Ubertricks" (Wolf_Feather, Garibaldi).

**[ESTIMATE — fill amounts per trick tier]**

- Mid-tier flip/spin trick (Misty/Rodeo class, ~2–4K pts): ~33% of meter each.
- Simple grab or small spin: ~10–15%.
- Big combined air (flip+spin+grab): ~40–60%.
- Landed uber: refills to full / keeps disc lit (guides treat every landed uber as
  maintaining uber-ready).
- Fall penalty: lose ~25–50% of meter; wipeout during uber also clears uber-ready.
- Idle decay: slow (~2–5%/s when riding flat without jumping).

## 8. Worked feel targets for a recreation

| Quantity | Target | Basis |
|---|---|---|
| Normal ramp airtime | 1.2–2.5 s | fits 1–2 quick ubers [EST] |
| Big/cliff airtime | 3–5.5 s | fits 2 char ubers + grab / 3 quick ubers [VERIF anchor, EST seconds] |
| Max spin rate (prewound) | ~550–600 °/s | 1800° in a big air; 900 in ~1.5 s [EST] |
| Stick-only spin rate | ~250–350 °/s | ~half of prewound [EST] |
| Max flip rate | ~310–360 °/s | 1080° flip within big air [EST] |
| Rotation cap | 1800° spin, 1080° flip ("???" beyond) | LLCoolDave [VERIF] |
| Quick uber duration | ~1.0–1.3 s | 2 per ramp jump [EST] |
| Char uber duration | ~2.0–2.5 s | 2 per monster jump [EST] |
| Uber base score range | 13,210–22,580 | Uber Trick Guide [VERIF] |
| Star multipliers | 2x/3x/5x, highest only, on clean landing | Wolf_Feather [VERIF] |
| Repetition penalty | ×0.5 of previous award per repeat | Wolf_Feather + manual [VERIF] |
| Meter fill | ~3 mid-tier tricks empty→full | Wolf_Feather [VERIF] |
| TRICKY | 6 landed ubers → infinite boost, permanent for run | Uber Trick Guide [VERIF] |
| Knockdown | instant full meter | Uber Trick Guide [VERIF] |

---

## Testable assertions

Jump / pre-load:
- Holding jump crouches the rider; jump height increases monotonically with hold duration up to a clamp (~1 s [EST]); a tap-jump yields visibly less air (≤~50% of full pop [EST]).
- While crouched, steering input is ignored (or heavily damped) and ground speed increases slightly.
- Takeoff preserves horizontal velocity: doubling approach speed ≈ doubles jump length at equal pop; boosting into a lip measurably extends the arc.
- Air trajectory is ballistic (constant gravity, no mid-air thrust except vents/pickups).

Hang time:
- A standard trick ramp at cruise speed yields 1.2–2.5 s airtime; the level's largest jump yields 3–5.5 s [EST bands].

Rotation:
- Pre-winding (direction held during crouch) yields a faster spin than the same input applied only after takeoff; longer pre-wind → faster spin.
- Max prewound spin rate ≈ 550–600 °/s; a 900 completes in ≈ 1.5 s [EST].
- Flip rate ≈ 300–360 °/s max; a single front/back flip completes in ≈ 1.0–1.2 s [EST].
- Spins and flips can run simultaneously on independent axes.
- Displayed rotation quantizes to 180° steps; spins above 1800° or flips ≥ 4 report "???" (still scoreable as unknown trick).
- Releasing rotation input auto-levels the rider toward a landing pose within ~0.2 s response.

Landing:
- Landing with a grab still held → crash, always.
- Landing before an uber animation completes → crash, always.
- Under-rotation of a small spin (≤~90° remaining [EST]) without a grab → clean, auto-snapped landing; large incomplete rotation → crash.
- Landing within ±45° [EST] of backwards → fakie/switch stance, not a crash (except alpine boards, which must turn around and lose speed).
- Trick points and any star multiplier are awarded only on clean landing; a crash voids the jump's pending score.
- Tricks ending past the finish line score zero.

Scoring / combos:
- Every uber has a fixed base value in [13,210 .. 22,580]; values match the table above; base value is stat-independent.
- All tricks within one air sum; the sum is multiplied by the highest single star collected that jump (yellow 2x / orange 3x / red 5x).
- Repeating an identical trick awards half of its previous award (successive halving); changing spin direction/degree resets it as a new trick.
- Grab score accrues continuously while held (hundreds of points per second scale [EST]).
- Flips score more than equal-degree spins.

Boost economy:
- Meter fills only on landed tricks; ~3 mid-tier flip tricks fill empty→full; repeated identical tricks fill less each time.
- Meter drains: over time (faster when not jumping), on falls, on obstacle hits; a landed opponent knockdown fills it instantly to full.
- Full meter enables ubers (visible indicator); the 7 listed loss conditions clear uber-readiness; obstacle hits do not.
- Each individually landed uber lights one of 6 TRICKY letters (two ubers in one jump = two letters); at 6, boost is infinite and uber-readiness permanent for the rest of the run, immune to all loss conditions, reset between events.
- Holding boost consumes meter for top speed; tap-boosting stretches consumption ~3× at near-top speed (if reproducing the exploit).
