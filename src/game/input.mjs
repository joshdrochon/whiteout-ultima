// ===========================================================================
// INPUT ROUTING — src/game/input.mjs
//
// ONE OWNER for the question "which physics channel does the horizontal stick
// drive right now?". Before this file the answer was written out by hand in
// index.html and again in src/game/main.mjs, both of them testing `onGround`
// FIRST, while physics' own step() dispatch tests `constrained` FIRST. The two
// orderings disagree on exactly one state — a rider on a rail — and that
// disagreement is the "falls right through the rail after a few feet" defect:
//
//   MEASURED (harness/rig-rail-fallthrough.mjs, 810 attempts on the 9 real
//   course rails, real wiring, src/game/main.mjs advance() order):
//     lock with the frozen flag TRUE : 111 locks, 0 bail, median 58.20 m along
//     lock with the frozen flag FALSE: 119 locks, 118 bail, median 12.40 m
//                                      (40.7 ft), then a silent 0.56 m drop
//                                      onto the snow under the rail line.
//     The stick reached the balance channel 0 / 119 times; it was delivered as
//     `spin` 119 / 119 times. Same intent routed through this file: 0 bails.
//
// Consumers must import `applyStick` rather than re-deriving the precedence,
// so there is exactly one place this can be got wrong again — and the rig
// gates THIS file, not a copy of it.
//
// BINDINGS (reference: "On rails, your spin inputs using the directional pad
// control your flat/rail spins" — the stick balances, the pad spins):
//   ground      stick left/right -> steer   (carve)
//   constrained stick left/right -> steer   (BALANCE on the rail)
//   air         stick left/right -> spin
//   rail spin lives on its own pair of keys (see spinPad below), so PC-19 is
//   still reachable by a player now that the stick is spoken for on a rail.
// ===========================================================================

import { riderMode } from './physics.mjs';

// Which key of the physics input object the horizontal stick writes.
export function stickChannel(state) {
  return riderMode(state) === 'air' ? 'spin' : 'steer';
}

// Route the horizontal stick into `input` for the rider's CURRENT mode.
// `amount` is the signed stick, -1..+1.
export function applyStick(input, state, amount) {
  input[stickChannel(state)] = amount;
  return input;
}

// The d-pad equivalent: an explicit rail-spin request. Only meaningful while
// constrained (in the air the stick is already the spin channel), and it must
// not clobber the balance stick the same frame — physics reads input.spin and
// rails.mjs reads input.steer, so both can be live at once.
export function spinPad(input, state, amount) {
  if (amount && riderMode(state) === 'constrained') input.spin = amount;
  return input;
}
