// Rail placements for the course.
//
// ONE SOURCE OF TRUTH. The renderer draws these points and the rails module
// captures against these points. If they were authored twice you could grind a
// rail that is not where it is drawn — the same class of bug as the terrain
// mesh/physics divergence that produced the "rides through the world" report.
//
// Placement rules (deliberate, not tuned):
//  * rails sit BESIDE the racing line, never on it, so they are a choice
//  * every rail has a straight lead-in in its own geometry, so a rider can
//    capture cleanly before any bend (GR-14 makes a sloppy arrival cost time)
//  * rail height is a fixed offset above the terrain under each point, so a
//    rail on a slope descends with it and GR-13's gravity-along-tangent applies
const RAIL_H = 0.55;          // m above the snow — hip height, clears the board

// z, lateral offset from the course centre, length, bend (m of lateral drift
// across the whole rail; 0 = straight)
const PLACEMENTS = [
  { z: 260, off: -9, len: 46, bend: 0 },
  { z: 430, off: 10, len: 38, bend: 0 },
  { z: 640, off: -11, len: 60, bend: 6 },     // gentle bend, holdable at speed
  { z: 880, off: 12, len: 44, bend: 0 },
  { z: 1120, off: -10, len: 70, bend: -9 },   // longest, bends back toward the line
  { z: 1380, off: 11, len: 40, bend: 0 },
  { z: 1610, off: -12, len: 55, bend: 7 },
  { z: 1860, off: 9, len: 48, bend: 0 },
  { z: 2100, off: -10, len: 42, bend: 0 },
];

// Build the rail polylines. `sampleHeight` and `centreX` come from the render
// lane so the rails follow the terrain and the course line.
export function buildRails(sampleHeight, centreX) {
  const rails = [];
  for (let i = 0; i < PLACEMENTS.length; i++) {
    const p = PLACEMENTS[i];
    const pts = [];
    const N = 10;
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      const z = p.z + t * p.len;
      // bend is a smooth lateral drift across the rail, not a kink
      const lateral = p.off + p.bend * (t * t * (3 - 2 * t));
      const x = centreX(z) + lateral;
      pts.push([x, sampleHeight(x, z) + RAIL_H, z]);
    }
    rails.push({ id: 'rail' + i, points: pts, width: 0.2 });
  }
  return rails;
}

export { RAIL_H, PLACEMENTS };
