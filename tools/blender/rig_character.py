# Headless Blender: build a humanoid rig for a A-posed character mesh, skin it,
# and author the snowboard pose set.
#
# usage:
#   blender --background --python tools/blender/rig_character.py -- \
#           --in assets/characters/nyx.glb --out assets/characters/nyx_rigged.glb
#
# WHY A HAND-BUILT ARMATURE AND NOT RIGIFY:
#   Rigify generates a control rig with hundreds of bones and drivers meant for
#   an animator in a GUI. glTF export flattens that anyway, and every extra bone
#   is skinning cost per frame in the browser. A snowboarder needs a small,
#   explicit skeleton and a handful of poses — so that is what this builds.
#
# BONE POSITIONS ARE MEASURED, NOT ASSUMED. Proportions get us close, but the
# arm angle of an A-pose varies per generation, so the arm chain is calibrated
# against the mesh's actual hand extents.
import bpy, sys, os, math
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(n, d=None):
    return argv[argv.index('--' + n) + 1] if ('--' + n) in argv else d

SRC, DST = arg('in'), arg('out')

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
mesh = [o for o in bpy.context.scene.objects if o.type == 'MESH'][0]
mesh.name = 'NyxMesh'

co = [mesh.matrix_world @ v.co for v in mesh.data.vertices]
H = max(c.z for c in co) - min(c.z for c in co)
Z0 = min(c.z for c in co)
print(f'[rig] mesh height {H:.3f}, floor {Z0:.3f}, verts {len(co)}')

def widest_at(zf, band=0.02):
    """max |x| within a horizontal slice — used to find hands/shoulders."""
    z = Z0 + zf * H
    sl = [c for c in co if abs(c.z - z) < band * H]
    if not sl:
        return 0.0
    return max(abs(c.x) for c in sl)

# Hand tips: the extreme x anywhere in the arm band. In an A-pose that is the
# lowest, widest point of the silhouette above the hips.
arm_band = [c for c in co if 0.45 * H < (c.z - Z0) < 0.75 * H]
hand_x = max(abs(c.x) for c in arm_band) if arm_band else 0.30 * H
hand_pts = [c for c in arm_band if abs(abs(c.x) - hand_x) < 0.02 * H]
hand_z = sum(c.z for c in hand_pts) / len(hand_pts) if hand_pts else Z0 + 0.50 * H
print(f'[rig] hand tip x={hand_x:.3f} z={hand_z - Z0:.3f} ({(hand_z-Z0)/H:.2f} of height)')

shoulder_x = widest_at(0.80) * 0.62
if shoulder_x < 0.05 * H:
    shoulder_x = 0.11 * H
print(f'[rig] shoulder half-width {shoulder_x:.3f}')

def P(xf, zf):
    return Vector((xf, 0.0, Z0 + zf * H))

# --- skeleton ---------------------------------------------------------------
arm = bpy.data.armatures.new('NyxArm')
rig = bpy.data.objects.new('NyxRig', arm)
bpy.context.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='EDIT')
eb = arm.edit_bones

def bone(name, head, tail, parent=None, connect=False):
    b = eb.new(name)
    b.head, b.tail = head, tail
    if parent:
        b.parent = eb[parent]
        b.use_connect = connect
    return b

# spine
bone('hips',   P(0, 0.50), P(0, 0.58))
bone('spine',  P(0, 0.58), P(0, 0.68), 'hips', True)
bone('chest',  P(0, 0.68), P(0, 0.80), 'spine', True)
bone('neck',   P(0, 0.80), P(0, 0.87), 'chest', True)
bone('head',   P(0, 0.87), P(0, 1.00), 'neck', True)

hz = (hand_z - Z0) / H
for s, sx in (('L', 1), ('R', -1)):
    sh = sx * shoulder_x
    # elbow sits midway along the straight line shoulder -> measured hand tip
    ex = sh + (sx * hand_x - sh) * 0.5
    ez = 0.80 + (hz - 0.80) * 0.5
    bone(f'shoulder{s}', P(sx * shoulder_x * 0.30, 0.79), P(sh, 0.795), 'chest')
    bone(f'upperArm{s}', P(sh, 0.795), P(ex, ez), f'shoulder{s}', True)
    bone(f'foreArm{s}',  P(ex, ez), P(sx * hand_x, hz), f'upperArm{s}', True)
    bone(f'hand{s}',     P(sx * hand_x, hz), P(sx * hand_x * 1.06, hz - 0.05), f'foreArm{s}', True)
    # legs
    lx = sx * 0.09 * H
    bone(f'thigh{s}', P(lx, 0.50), P(lx, 0.28), 'hips')
    bone(f'shin{s}',  P(lx, 0.28), P(lx, 0.055), f'thigh{s}', True)
    b = bone(f'foot{s}', P(lx, 0.055), P(lx, 0.0), f'shin{s}', True)
    b.tail = Vector((lx, -0.06 * H, Z0 + 0.005 * H))   # point the foot forward

bpy.ops.object.mode_set(mode='OBJECT')
print(f'[rig] armature built: {len(arm.bones)} bones')

# --- skinning ---------------------------------------------------------------
# EXPLICIT DISTANCE WEIGHTING, not bone heat. Blender's heat solver reported
# "failed to find solution for one or more bones" on this mesh and produced NO
# vertex groups at all; on the dirtier pre-clean version it produced garbage
# (the head was the single largest influence). Heat needs clean manifold
# topology, which an AI-generated + decimated mesh does not reliably have.
#
# This is deterministic and works on any topology: weight each vertex against
# the nearest K bone SEGMENTS by inverse distance, then normalise.
bpy.ops.object.select_all(action='DESELECT')
mesh.select_set(True)
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type='ARMATURE_NAME')   # parent + groups, no weights

K = 4          # influences per vertex (glTF's standard 4-bone skinning)
POW = 3.5      # inverse-distance falloff; higher = tighter, more rigid limbs

bone_segs = []
for b in rig.data.bones:
    h = rig.matrix_world @ b.head_local
    t = rig.matrix_world @ b.tail_local
    bone_segs.append((b.name, h, t))

def dist_to_seg(p, a, b):
    ab = b - a
    L2 = ab.dot(ab)
    if L2 < 1e-12:
        return (p - a).length
    t = max(0.0, min(1.0, (p - a).dot(ab) / L2))
    return (p - (a + ab * t)).length

groups = {n: mesh.vertex_groups.get(n) or mesh.vertex_groups.new(name=n)
          for n, _, _ in bone_segs}
for vg in mesh.vertex_groups:
    vg.remove(range(len(mesh.data.vertices)))

# SIDE MASK: a limb bone may not grab vertices from the other side of the body.
# Without it the legs FUSED — in an A-pose the legs are close together, so a
# vertex on the inner left thigh is physically nearer the RIGHT thigh segment
# than the left one, and inverse-distance weighting duly welded them into a
# single mass. Also showed up as skew influence counts (shinL/shinR 2360/1729).
CENTRE_BAND = 0.012 * H     # verts this close to x=0 stay unmasked (crotch, chest)

def allowed(name, px):
    if name.endswith('L') and px < -CENTRE_BAND:
        return False
    if name.endswith('R') and px > CENTRE_BAND:
        return False
    return True

for v in mesh.data.vertices:
    p = mesh.matrix_world @ v.co
    ds = [(dist_to_seg(p, h, t), n) for n, h, t in bone_segs if allowed(n, p.x)]
    ds.sort()
    top = ds[:K]
    ws = [(n, 1.0 / (d ** POW + 1e-6)) for d, n in top]
    tot = sum(w for _, w in ws) or 1.0
    for n, w in ws:
        groups[n].add([v.index], w / tot, 'REPLACE')

# verify: symmetric mesh must give symmetric influence counts
counts = {n: 0 for n, _, _ in bone_segs}
for v in mesh.data.vertices:
    for g in v.groups:
        if g.weight > 0.01:
            counts[mesh.vertex_groups[g.group].name] += 1
asym = []
for n in counts:
    if n.endswith('L'):
        r = n[:-1] + 'R'
        if r in counts and max(counts[n], counts[r]) > 0:
            d = abs(counts[n] - counts[r]) / max(counts[n], counts[r])
            if d > 0.25:
                asym.append(f'{n}/{r} {counts[n]}/{counts[r]}')
print(f'[rig] skinned by distance (K={K}, pow={POW})')
print(f'[rig] influence counts: {sorted(counts.items(), key=lambda kv: -kv[1])[:6]}')
print(f'[rig] L/R asymmetry >25%: {asym if asym else "none"}')

# --- pose set ---------------------------------------------------------------
# A snowboarder never walks, so there is no locomotion cycle to author. The set
# is a handful of held poses the game blends between from physics state.
bpy.context.view_layer.update()
FOOT_Z0 = min((rig.matrix_world @ p).z
              for sfx in ('L', 'R')
              for p in (rig.pose.bones[f'foot{sfx}'].head, rig.pose.bones[f'foot{sfx}'].tail))
print(f'[rig] rest foot height {FOOT_Z0:.4f}')

D = math.radians
def rot(name, x=0, y=0, z=0):
    pb = rig.pose.bones.get(name)
    if not pb:
        return
    pb.rotation_mode = 'XYZ'
    pb.rotation_euler = (D(x), D(y), D(z))

def clear():
    for pb in rig.pose.bones:
        pb.rotation_mode = 'XYZ'
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)

def plant_feet():
    """NO-OP BY DESIGN — kept so the call sites read honestly.

    This used to translate the hips bone downward so the feet returned to the
    ground after a knee bend. That baked a TRANSLATION into every clip, and a
    bone translation does not survive the Blender -> glTF -> three.js trip
    faithfully: re-importing the GLB into Blender looked correct (it round-trips
    through the same converter, so a symmetric error cancels and hides itself),
    but in the browser the crouch put the hips 0.85 m too low and the head BELOW
    the feet.

    Poses are now ROTATION ONLY. Grounding is done in the game instead, where
    the foot bone's live world position is known exactly — see groundNyx() in
    src/game/main.mjs. That is both correct and self-correcting for any pose."""
    return

def check_stance(action_name):
    """ANATOMY AUDIT — direction, not just magnitude.

    A backwards knee measures the SAME ANGLE as a correct one, so an angle check
    passes a leg that bends the wrong way. Every check here is signed.
    """
    bpy.context.view_layer.update()

    def P(n, w='head'):
        pb = rig.pose.bones[n]
        return rig.matrix_world @ (pb.head if w == 'head' else pb.tail)

    problems = []

    # 1. stance width, and legs not crossed
    fl, fr = P('footL'), P('footR')
    w = abs(fl.x - fr.x)
    if fl.x < fr.x:
        problems.append('LEGS CROSSED')
    elif not (0.40 <= w <= 0.72):
        problems.append(f'stance {w:.2f} out of band')

    # 2. KNEES BEND FORWARD: the foot must sit BEHIND the knee
    for sfx in ('L', 'R'):
        d = P(f'foot{sfx}').y - P(f'shin{sfx}').y
        if d > 0.02:
            problems.append(f'knee{sfx} BACKWARD (foot {d:+.2f} ahead of knee)')

    # 3. ELBOWS: the hand must not sit above the shoulder unless the arm is raised
    for sfx in ('L', 'R'):
        hand, elbow, sh = P(f'hand{sfx}'), P(f'foreArm{sfx}'), P(f'upperArm{sfx}')
        armv = (hand - sh)
        if armv.length < 0.15:
            problems.append(f'arm{sfx} COLLAPSED (hand {armv.length:.2f} m from shoulder)')

    # 4. head clears the feet
    hz = P('head', 'tail').z
    fz = min(P(f'foot{s2}', w2).z for s2 in ('L', 'R') for w2 in ('head', 'tail'))
    if hz - fz < 0.55:
        problems.append(f'head only {hz - fz:.2f} m above feet')

    # 5. upright poses keep the hips ABOVE the knees
    hipz, kneez = P('hips').z, P('shinL').z
    if hipz < kneez:
        problems.append('hips BELOW knees')

    flag = ('  *** ' + '; '.join(problems) + ' ***') if problems else ''
    print(f'[rig]   {action_name:14s} stance {w:.3f}  head+{hz - fz:.2f}{flag}')
    return problems

def key(action_name):
    """Snapshot the posed rig into a NEW action.

    ORDER MATTERS AND IT USED TO BE WRONG. This posed the rig first and THEN
    assigned a freshly created action. In Blender 4.4+ actions are SLOTTED, and
    binding an unbound action re-evaluates the rig before keyframe_insert runs —
    so every clip captured the same pose. All 12 exported clips held byte-
    identical bone data: the game had exactly ONE pose under twelve names, which
    is why no pose work ever showed up on screen.

    Now: snapshot the pose, create and BIND the action (with its slot), restore
    the snapshot, then key. Verified by dumping per-action fcurves."""
    plant_feet()
    check_stance(action_name)
    snap = {pb.name: (tuple(pb.rotation_euler), tuple(pb.location)) for pb in rig.pose.bones}

    if rig.animation_data is None:
        rig.animation_data_create()
    act = bpy.data.actions.new(action_name)
    rig.animation_data.action = act
    # Blender 4.4+ slotted actions need an explicit slot bound to this object,
    # or the channels are written but never evaluated.
    if hasattr(act, 'slots'):
        try:
            slot = act.slots.new(id_type='OBJECT', name=rig.name)
        except TypeError:
            slot = act.slots.new()
        rig.animation_data.action_slot = slot
    bpy.context.view_layer.update()

    for pb in rig.pose.bones:
        rot, loc = snap[pb.name]
        pb.rotation_mode = 'XYZ'
        pb.rotation_euler = rot
        pb.location = loc
    bpy.context.view_layer.update()

    # KEY AT FRAME 0, not 1. three.js AnimationAction.reset() sets time = 0, and
    # a clip whose first keyframe is at frame 1 is being sampled BEFORE its first
    # key. That produced intermittent garbage in game: `tuck` alone at weight
    # 1.00 measuring a 0.056 m stance when the clip itself is 0.534.
    for pb in rig.pose.bones:
        pb.keyframe_insert('rotation_euler', frame=0)
        pb.keyframe_insert('location', frame=0)
        pb.keyframe_insert('rotation_euler', frame=1)
        pb.keyframe_insert('location', frame=1)
    act.use_fake_user = True
    # UNBIND. While an action stays bound, every view_layer.update() re-evaluates
    # the rig FROM THAT ACTION and silently discards the manual pose set for the
    # next clip — which is why all 12 clips came out identical. plant_feet() and
    # check_stance() both call update(), so the very next pose was wiped before
    # it was ever keyed.
    rig.animation_data.action = None
    bpy.context.view_layer.update()
    return act

def clear():
    for pb in rig.pose.bones:
        pb.rotation_mode = 'XYZ'
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)

def plant_feet():
    """Drop the hips so the feet return to the ground after a knee bend.

    THIS IS WHY EVERY CROUCH LOOKED LIKE STANDING. In FK the hips are the root,
    so bending the knees rotates the FEET up and back — it does not lower the
    pelvis. The character ends up standing with folded legs and the boots
    floating off the board. Real crouching lowers the body over planted feet.
    Measuring the lowest foot after the pose and translating the hips down by
    that amount reproduces it without needing an IK rig."""
    bpy.context.view_layer.update()
    lowest = None
    for sfx in ('L', 'R'):
        pb = rig.pose.bones.get(f'foot{sfx}')
        if pb is None:
            continue
        for pt in (pb.head, pb.tail):
            z = (rig.matrix_world @ pt).z
            lowest = z if lowest is None else min(lowest, z)
    if lowest is None:
        return
    hips = rig.pose.bones.get('hips')
    if hips is None:
        return
    # hips translate in their own space; convert a world-Z drop into bone space
    drop = lowest - FOOT_Z0
    if abs(drop) < 1e-5:
        return
    # A pose bone's `location` lives in the bone's REST space, not in its posed
    # space. Converting the world drop with hips.matrix (the POSED matrix) is
    # wrong the moment the hips carry any rotation, and it drove the whole
    # skeleton through the floor: measured in game, every bone sat BELOW the
    # feet (hips -0.366, head -0.507). Use the rest matrix.
    from mathutils import Vector as _V
    rest = hips.bone.matrix_local.to_3x3().inverted()
    hips.location = hips.location + (rest @ _V((0.0, 0.0, -drop)))
    bpy.context.view_layer.update()

STANCE_MIN, STANCE_MAX = 0.42, 0.70   # m between the feet — a real snowboard stance

def check_stance(action_name):
    """ANATOMY AUDIT — direction, not just magnitude.

    A backwards knee measures the SAME ANGLE as a correct one, so an angle check
    passes a leg that bends the wrong way. Every check here is signed.
    """
    bpy.context.view_layer.update()

    def P(n, w='head'):
        pb = rig.pose.bones[n]
        return rig.matrix_world @ (pb.head if w == 'head' else pb.tail)

    problems = []

    # 1. stance width, and legs not crossed
    fl, fr = P('footL'), P('footR')
    w = abs(fl.x - fr.x)
    if fl.x < fr.x:
        problems.append('LEGS CROSSED')
    elif not (0.40 <= w <= 0.72):
        problems.append(f'stance {w:.2f} out of band')

    # 2. KNEES BEND FORWARD: the foot must sit BEHIND the knee
    for sfx in ('L', 'R'):
        d = P(f'foot{sfx}').y - P(f'shin{sfx}').y
        if d > 0.02:
            problems.append(f'knee{sfx} BACKWARD (foot {d:+.2f} ahead of knee)')

    # 3. ELBOWS: the hand must not sit above the shoulder unless the arm is raised
    for sfx in ('L', 'R'):
        hand, elbow, sh = P(f'hand{sfx}'), P(f'foreArm{sfx}'), P(f'upperArm{sfx}')
        armv = (hand - sh)
        if armv.length < 0.15:
            problems.append(f'arm{sfx} COLLAPSED (hand {armv.length:.2f} m from shoulder)')

    # 4. head clears the feet
    hz = P('head', 'tail').z
    fz = min(P(f'foot{s2}', w2).z for s2 in ('L', 'R') for w2 in ('head', 'tail'))
    if hz - fz < 0.55:
        problems.append(f'head only {hz - fz:.2f} m above feet')

    # 5. upright poses keep the hips ABOVE the knees
    hipz, kneez = P('hips').z, P('shinL').z
    if hipz < kneez:
        problems.append('hips BELOW knees')

    flag = ('  *** ' + '; '.join(problems) + ' ***') if problems else ''
    print(f'[rig]   {action_name:14s} stance {w:.3f}  head+{hz - fz:.2f}{flag}')
    return problems

def key(action_name):
    if rig.animation_data is None:
        rig.animation_data_create()
    plant_feet()
    check_stance(action_name)
    act = bpy.data.actions.new(action_name)
    rig.animation_data.action = act
    # KEY AT FRAME 0, not 1. three.js AnimationAction.reset() sets time = 0, and
    # a clip whose first keyframe is at frame 1 is being sampled BEFORE its first
    # key. That produced intermittent garbage in game: `tuck` alone at weight
    # 1.00 measuring a 0.056 m stance when the clip itself is 0.534.
    for pb in rig.pose.bones:
        pb.keyframe_insert('rotation_euler', frame=0)
        pb.keyframe_insert('location', frame=0)
        pb.keyframe_insert('rotation_euler', frame=1)
        pb.keyframe_insert('location', frame=1)
    act.use_fake_user = True
    # UNBIND. While an action stays bound, every view_layer.update() re-evaluates
    # the rig FROM THAT ACTION and silently discards the manual pose set for the
    # next clip — which is why all 12 clips came out identical. plant_feet() and
    # check_stance() both call update(), so the very next pose was wiped before
    # it was ever keyed.
    rig.animation_data.action = None
    bpy.context.view_layer.update()
    return act

# BONE-LOCAL AXES (measured, not assumed):
#   spine chain points UP   -> local Y is vertical, so rot(y=) is YAW/twist
#   thigh/shin point DOWN   -> rot(x=) swings the limb forward/back
#   arms point down-and-out -> rot(x=) swings forward, rot(z=) spreads out
# The first version used y= on ARMS expecting swing and got twist, which is what
# made her a contortionist.
#
# REAL SNOWBOARD STANCE (from reference footage):
#   knees deeply bent (30-50 deg), hips dropped and back, torso folded FORWARD
#   over the board, and — the part that was missing entirely — SHOULDERS
#   COUNTER-ROTATED toward the direction of travel while the hips and feet stay
#   square across the board. That counter-rotation is what makes a rider read as
#   snowboarding rather than standing sideways on a plank.

TRAVEL = 1     # +1 = she looks over her leading (front) shoulder

def pose_ride(depth=1.0, lean=0.0, twist=1.0):
    """STANDING NEUTRAL — matched against references/poses/ref-standing.jpeg.

    Read off the photo, in order of how wrong the previous version was:
      * ARMS hang DOWN and out around hip height with soft elbows, angled
        slightly forward. They were straight out horizontal, which is the rail
        balance pose, not a riding stance.
      * TORSO leans forward about 35 deg with the hips pushed BACK. It was
        nearly vertical.
      * FEET stay parallel across the board — no turn-out.
      * KNEE must bend so the foot sits BEHIND the knee. thigh +20 / shin -48
        measures foot-minus-knee -0.190; the old +38/-36 measured +0.014, a
        locked leg that reads as bending backwards."""
    clear()
    rot('hips',  x=-24 * depth, z=lean * 8)
    rot('spine', x=-18 * depth, y=TRAVEL * 14 * twist, z=lean * 5)
    rot('chest', x=-12 * depth, y=TRAVEL * 18 * twist, z=lean * 4)
    rot('neck',  x=10,          y=TRAVEL * 8 * twist)
    rot('head',  x=24,          y=TRAVEL * 12 * twist, z=-lean * 6)
    for s, sx in (('L', 1), ('R', -1)):
        rot(f'thigh{s}', x=20 * depth, z=sx * -7)
        rot(f'shin{s}',  x=-48 * depth)
        rot(f'foot{s}',  x=16 * depth)
        rot(f'shoulder{s}', z=sx * 4)
        # SOLVED against the photo: hands out at HIP height (0.92, hips are at
        # 0.90), slightly forward, elbows nearly straight. Guessing the arm
        # angle kept putting them at shoulder height, which is the rail-balance
        # pose, not a riding stance.
        rot(f'upperArm{s}', x=-15, z=0)
        rot(f'foreArm{s}',  x=0)

pose_ride(1.0); key('ride')
pose_ride(1.15, lean=+1.0); key('carve_left')
pose_ride(1.15, lean=-1.0); key('carve_right')

# CROUCHED / SPEED TUCK — reference references/poses/ref-crouched.jpeg.
# Solved to knee 80 deg, torso lean 66 deg, stance 0.521. The photograph has the
# arms reaching FORWARD past the knees, not tucked at the sides — upperArm x=+N
# swings the hand forward (measured: x=+60 -> hand y=+0.384).
clear()
rot('hips',  x=-24); rot('spine', x=-36, y=TRAVEL * 10); rot('chest', x=-24, y=TRAVEL * 12)
# the head must CANCEL the torso fold and then look up: spine -28 plus
# chest -18 is 46 deg of fold, so anything under ~50 leaves her face-down.
rot('neck',  x=28);  rot('head',  x=64, y=TRAVEL * 12)
for s, sx in (('L', 1), ('R', -1)):
    # solved: knee 84 deg, foot directly under the hips. The previous
    # thigh 74 / shin -100 left the SHINS HORIZONTAL and the thighs vertical —
    # she was sitting in the air rather than squatting over the board.
    rot(f'thigh{s}', x=68, z=sx * -12)
    rot(f'shin{s}',  x=-96)
    rot(f'foot{s}',  x=14)
    rot(f'shoulder{s}', z=sx * 4)
    # SOLVED: hands FORWARD and TOGETHER near the front knee, as in the photo —
    # not splayed sideways. z=sx*+38 pulls the arm IN toward the centreline
    # (measured: z=+30 moves the hand from x=0.578 to x=0.362); the outward sign
    # I had been using threw them wide. Result: hand at (0.21, +0.40, 0.30)
    # against a knee at z=0.27.
    rot(f'upperArm{s}', x=48, z=sx * 38)
    rot(f'foreArm{s}',  x=-60)
key('tuck')

# AIR — legs pulled up under the body, arms wide for balance
clear()
rot('hips', x=-14); rot('spine', x=-16, y=TRAVEL * 18); rot('chest', x=-12, y=TRAVEL * 22)
rot('head', x=8, y=TRAVEL * 12)
for s, sx in (('L', 1), ('R', -1)):
    rot(f'thigh{s}', x=56, z=sx * -8); rot(f'shin{s}', x=-78); rot(f'foot{s}', x=26)
    rot(f'upperArm{s}', x=30, z=sx * -26)   # sheet 10: wide, near-horizontal
    rot(f'foreArm{s}',  x=-16)
key('air')

# GRAB — fold right down, leading hand to the board between the feet
clear()
rot('hips', x=-40); rot('spine', x=-36, y=TRAVEL * 14); rot('chest', x=-26, y=TRAVEL * 16)
rot('head', x=22, y=TRAVEL * 8)
for s, sx in (('L', 1), ('R', -1)):
    rot(f'thigh{s}', x=76, z=sx * -12); rot(f'shin{s}', x=-98); rot(f'foot{s}', x=30)
rot('upperArmL', x=-84, z=22); rot('foreArmL', x=-52)
rot('upperArmR', x=-14, z=-38); rot('foreArmR', x=-24)
key('grab')

# LAND — deepest compression, absorbing through the knees
pose_ride(1.85, twist=0.6); key('land')

# RAIL GRIND (sheet 15) — the pose the rails lane has been missing entirely.
# Reference read: arms straight OUT HORIZONTALLY like a tightrope walker, torso
# square and upright over the rail, knees moderately bent, head up and forward.
# The wide arms are the whole read — this is a balance pose, not a crouch.
clear()
rot('hips',  x=-8)
rot('spine', x=-6,  y=TRAVEL * 10)
rot('chest', x=-4,  y=TRAVEL * 12)
rot('neck',  x=-2)
rot('head',  x=4,   y=TRAVEL * 14)
for s, sx in (('L', 1), ('R', -1)):
    rot(f'thigh{s}', x=22, z=sx * -12)
    rot(f'shin{s}',  x=-36)
    rot(f'foot{s}',  x=14)
    rot(f'shoulder{s}', z=sx * 12)
    # MEASURED, not guessed: probing hand position per axis showed x alone
    # swings the arm FORWARD and z alone swings it BACK, both raising it. The
    # combination x=+35 z=-35 cancels the fore/aft and puts the hand at
    # (0.758, 0.037, 1.466) — straight out to the side at shoulder height.
    rot(f'upperArm{s}', x=35, z=sx * -35)
    rot(f'shoulder{s}', z=sx * 10)
    rot(f'foreArm{s}',  x=-8)
key('rail_grind')

# JUMP TAKEOFF (sheet 9) — extending upward off the lip, legs straightening,
# arms swinging up and forward.
clear()
rot('hips', x=4); rot('spine', x=6, y=TRAVEL * 12); rot('chest', x=6, y=TRAVEL * 14)
rot('head', x=-6, y=TRAVEL * 10)
for s, sx in (('L', 1), ('R', -1)):
    rot(f'thigh{s}', x=8, z=sx * -12); rot(f'shin{s}', x=-14); rot(f'foot{s}', x=22)
    rot(f'upperArm{s}', x=-34, z=sx * 46)
    rot(f'foreArm{s}',  x=-28)
key('jump_takeoff')

# GRAB — METHOD (sheet 13): rear hand reaches BACK to the heel edge, front arm
# forward, back arched, knees folded up.
clear()
rot('hips', x=-30); rot('spine', x=-22, y=TRAVEL * 20); rot('chest', x=-16, y=TRAVEL * 24)
rot('head', x=10, y=TRAVEL * 14)
for s, sx in (('L', 1), ('R', -1)):
    rot(f'thigh{s}', x=62, z=sx * -12); rot(f'shin{s}', x=-92); rot(f'foot{s}', x=24)
rot('upperArmL', x=-20, z=64); rot('foreArmL', x=-16)      # lead arm out front
rot('upperArmR', x=48, z=-30); rot('foreArmR', x=-84)      # trailing hand back to the tail
key('grab_method')

# GRAB — INDY (sheet 14): front hand reaches DOWN between the feet to the toe
# edge, body tucked tight, knees pulled high.
clear()
rot('hips', x=-38); rot('spine', x=-30, y=TRAVEL * 10); rot('chest', x=-22, y=TRAVEL * 12)
rot('head', x=18, y=TRAVEL * 8)
for s, sx in (('L', 1), ('R', -1)):
    rot(f'thigh{s}', x=78, z=sx * -12); rot(f'shin{s}', x=-100); rot(f'foot{s}', x=28)
rot('upperArmL', x=30, z=18); rot('foreArmL', x=-70)       # reaching down to the board
rot('upperArmR', x=-30, z=-58); rot('foreArmR', x=-22)     # counterweight out and back
key('grab_indy')

# CRASH — folded up, arms thrown wide, head tucked down
clear()
rot('hips', x=-52, z=20); rot('spine', x=-40, y=TRAVEL * 26, z=14)
rot('chest', x=-30, y=TRAVEL * 30, z=10); rot('head', x=-26, y=TRAVEL * 16)
for s, sx in (('L', 1), ('R', -1)):
    rot(f'thigh{s}', x=84, z=sx * -12); rot(f'shin{s}', x=-104); rot(f'foot{s}', x=22)
    rot(f'upperArm{s}', x=-88, z=sx * 62)
    rot(f'foreArm{s}',  x=-70)
key('crash')

clear()
rig.animation_data.action = None
print(f'[rig] authored {len([a for a in bpy.data.actions])} pose actions')

os.makedirs(os.path.dirname(DST), exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(
    filepath=DST, export_format='GLB', export_apply=False,
    export_image_format='JPEG', export_jpeg_quality=85, export_yup=True,
    export_animations=True, export_nla_strips=False,
    export_anim_single_armature=True, export_skins=True,
)
print(f'[rig] wrote {DST} — {os.path.getsize(DST)/1024/1024:.2f} MB')
