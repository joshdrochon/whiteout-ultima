# Nyx pose sheet — the reference bar for character animation

`nyx-pose-sheet.png` is 20 authored poses of our own character. It is the
reference bar for the animation lane in exactly the way `REFERENCE_BAR.md` is
for physics: poses are judged AGAINST it, blind, not against my judgement.

Why this matters: five hand-authored passes and one mocap retarget all went in
without a target to compare to. Rendering a pose only ever told me "that is
wrong", never "here is right". This sheet is the "here is right".

## The 20 poses, and what each one serves

| # | Sheet pose | Game state | Have it? |
|---|---|---|---|
| 1 | Idle stance | menu / pre-run, board held | no |
| 2 | Ready stance | run start, before the gate | no |
| 3 | Pushing off | run start impulse | no |
| 4 | Riding forward | `ride` — the base stance | yes (mocap) |
| 5 | Carving left | `carve_left` | yes (mocap) |
| 6 | Carving right | `carve_right` | yes (mocap) |
| 7 | Crouching | `tuck` / charge | yes (mocap) |
| 8 | Braking | hard decel — no game state yet | no |
| 9 | Jump takeoff | the pop frame | no |
| 10 | Airborne straight | `air` | yes (authored) |
| 11 | Spin setup | prewind, pre-takeoff | no |
| 12 | Spin midair | spinning in air | no |
| 13 | Grab — method | `grab` variant | partial |
| 14 | Grab — indy | `grab` variant | partial |
| 15 | **Rail grind** | rails lane — constrained state | **no** |
| 16 | Landing | `land` | yes (authored) |
| 17 | Celebrating | run finish / results screen | no |
| 18 | Turning backward | riding switch (fakie) | no |
| 19 | Wipeout / recovery | `crash` | yes (authored) |
| 20 | Trick finish | uber completion flourish | no |

**8 of 20 covered.** The gaps that matter most for what already exists in the
game: RAIL GRIND (the rails lane is wired and has no pose for it), JUMP TAKEOFF,
SPIN MIDAIR, and the two distinct GRABS.

## What the sheet can and cannot give

It CANNOT give numeric joint angles — it is 2D art, and no automated step turns
a painting into bone rotations reliably.

What it CAN do, which is what actually stalled before:
1. be the target a pose render is compared against, side by side
2. define the pose SET, so the gaps are visible instead of assumed
3. serve as the blind reference bar for a critic judging poses

## How poses get judged

`tools/blender/compare_pose.py` renders a rig pose from a camera matched to the
sheet's 3/4 view at the same framing, so a render and a sheet tile can be put
next to each other honestly. The critic sees both without labels and says which
is which, and what is wrong with ours. Same loop as every other lane.
