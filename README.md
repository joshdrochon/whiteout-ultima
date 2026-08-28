# Whiteout Ultima

An arcade snowboarding game that runs in a browser. Three.js for rendering, raw
GLSL for the snow, hand-written physics. No engine.

**Play:** https://whiteout-ultima.pages.dev

---

## Running it locally

Node 18+ and a modern browser. That is the whole dependency list.

```bash
npm install
npm run serve          # http://localhost:8080
```

Open the URL and press a key — the soundtrack needs a real keypress before a
browser will let it start.

### Use `npm run serve`, not `python3 -m http.server`

`tools/serve.mjs` sends `no-store` on everything. The Python one lets Chrome
cache ES modules, and a query string on the HTML does **not** bust the module
URLs it imports. That has cost real debugging time twice in this project — once
reading a stale `hud.mjs` and concluding a rename had not applied, once nearly
"fixing" a terrain bug that was a cached module. A dev server that cannot serve
stale code removes the whole class of problem.

Opening `index.html` as a `file://` URL will not work: the game imports ES
modules and loads assets over HTTP.

---

## Controls

| | |
|---|---|
| `←` `→` or `A` `D` | carve — in the air this is spin, on a rail it is balance |
| `↓` or `S` | tuck |
| `SHIFT` | boost |
| `SPACE` | hold to charge, release to jump |
| `G` | nose grab (hold, airborne) |
| `1`–`6` | uber tricks (airborne) |
| `Q` `E` | rail spin |
| `R` | respawn |
| `M` | mute · `,` `.` previous / next track |
| `` ` `` | debug panel |
| `F` | pose editor (see below) |

### Pose editor

A development tool for placing things exactly. `F` freezes the game, then:

| | |
|---|---|
| click | pick the object under the cursor · `Esc` deselect |
| `V` | detach the camera · drag orbit · shift-drag pan · wheel zoom |
| `H` | centre the camera on the selection |
| `J`/`L` `I`/`K` `U`/`O` | rotate about the object's local Y / X / Z |
| arrows, `PgUp`/`PgDn` | move — arrows are the horizontal plane, PgUp/PgDn is height |
| `[` `]` | smaller / bigger step · `0` reset |
| `N` | cycle pose: neutral → carve → tuck → grab |
| `C` | copy the values, tagged with which object they belong to |

It exists because orientation could not be settled by reasoning. Several
attempts to derive the rider's facing from mesh geometry produced numbers whose
own self-checks passed and which were still visibly wrong. The person looking at
the screen can see what a measurement cannot.

---

## Tests

```bash
npm test               # the full suite, ~4 minutes
```

The game is graded by about 150 executable gates in
`references/PHYSICS_GATES.json`, across nine lanes: physics core (PC), turning
(TN), jump arcs (JA), camera (CF), snow visuals (SV), HUD (HU), run structure
(RS), rails (GR) and rivals (AI). Each gate is a measurable statement — a carve
at 25 m/s must produce a bank angle matching `atan(a_lat/g)`; a hard rival must
beat the reference player on every seed.

Individual lanes:

```bash
node harness/physics-runner.mjs --module src/physics/physics.mjs
node harness/rival-runner.mjs   --module src/rivals/rivals.mjs
node harness/shader-runner.mjs  --module src/shaders
node harness/rail-runner.mjs    --module src/rails/rails.mjs
```

### The rule that matters

**A gate is only real once you have watched it fail.** Every lane has a mutant
table — `harness/rival-mutants.mjs` and friends — that takes the honest
reference module, breaks exactly one property, and asserts the gate guarding
that property goes red. A gate no mutant can trip is decoration.

This is not theoretical. A rivals module driving one shared line at four
different throttles scored 13/13 on the AI sheet, because nothing in it could
see the property the whole lane existed to test. Another gate graded the wrong
data for days because a run cache key was missing a field.

```bash
node harness/rival-mutants.mjs     # 29 mutants, all must be caught
node harness/preflight.mjs         # attacks the LAW before a build cycle
```

`preflight.mjs` runs in about 45 seconds and checks the things underneath the
gates: that no gate depends on what ran before it, that every declared metric
actually comes back a number, that every gate has a mutant, and that the law is
even satisfiable at the bar the critic will judge against.

---

## Layout

```
src/
  physics/   the accepted physics core — deterministic, 60 Hz fixed step
  render/    terrain, props, baked vertex lighting
  shaders/   snow surface, spray, trail (raw GLSL)
  camera/    the chase rig
  rails/     grinding
  rivals/    opponent AI — emits INPUTS only, never touches physics state
  run/       start gate, clock, finish, corridor
  tricks/    scoring, ubers, the ULTIMA meter
  hud/       the overlay
  game/      the rig that wires it together (main.mjs)
harness/     one runner per lane, plus mutant tables and probes
tools/       dev server, dist build, Blender asset prep
```

`src/game/*.mjs` are **byte-identical copies** of the accepted modules, enforced
by the test suite. Edit the source in its own lane and copy across; the suite
fails if they drift.

### Conventions

1 unit = 1 metre. Rider 1.8 m, 80 kg. 60 Hz fixed timestep. +Y up.

The scene has **no lights for the terrain** — its shading is baked per-vertex
against a fixed sun, and SV-01 grades that model. Real lights exist but reach
only the character and props, because `MeshBasicMaterial` ignores them entirely.
A PBR material on the terrain renders black.

---

## Deploying

See [DEPLOY.md](DEPLOY.md). Short version:

```bash
npm run build          # writes dist/, ~20 MB, self-contained
npx wrangler pages deploy dist --project-name whiteout-ultima
```

## Asset pipeline

Character and prop models come from Tripo as ~2M-triangle GLBs and are prepped
headlessly:

```bash
blender --background --python tools/blender/prep_character.py -- \
  --in raw.glb --out assets/props/thing.glb --tris 6000 --tex 1024 --height 11
```

`--height` normalises the **bounding height**, which is wrong for anything not
standing upright — a crouched figure forced to a standing figure's height gets
scaled up. Match on surface area instead (`sqrt(areaNeutral / areaPose)`), which
does not change when a body moves. `harness/scale-probe.html` does this.
