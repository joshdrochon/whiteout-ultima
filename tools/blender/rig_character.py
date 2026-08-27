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

for v in mesh.data.vertices:
    p = mesh.matrix_world @ v.co
    ds = [(dist_to_seg(p, h, t), n) for n, h, t in bone_segs]
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

def key(action_name):
    if rig.animation_data is None:
        rig.animation_data_create()
    act = bpy.data.actions.new(action_name)
    rig.animation_data.action = act
    for pb in rig.pose.bones:
        pb.keyframe_insert('rotation_euler', frame=1)
        pb.keyframe_insert('location', frame=1)
        pb.keyframe_insert('rotation_euler', frame=2)
        pb.keyframe_insert('location', frame=2)
    act.use_fake_user = True
    return act

# BONE-LOCAL AXES: Blender runs a pose bone's local Y ALONG the bone, so a
# rotation about Y is TWIST, not swing. Swing is X and Z. The first version of
# this file used y= for arm swing and produced a mangled, twisted character.
# X = swing forward/back, Z = swing in/out (for a downward-pointing bone).

# RIDE — the base stance: knees bent, weight centred, arms out for balance.
def pose_ride(depth=1.0, lean=0.0):
    clear()
    rot('hips',  x=-12 * depth, z=lean * 7)
    rot('spine', x=-9 * depth,  z=lean * 5)
    rot('chest', x=-5 * depth,  z=lean * 4)
    rot('head',  x=7 * depth,   z=-lean * 8)
    for s, sx in (('L', 1), ('R', -1)):
        rot(f'thigh{s}', x=24 * depth)
        rot(f'shin{s}',  x=-42 * depth)
        rot(f'foot{s}',  x=18 * depth)
        # arms: swing out (z) and slightly forward (x)
        rot(f'upperArm{s}', x=-12 * depth, z=sx * 16)
        rot(f'foreArm{s}',  x=-24 * depth)

pose_ride(1.0); key('ride')
pose_ride(1.0, lean=+1.0); key('carve_left')
pose_ride(1.0, lean=-1.0); key('carve_right')
pose_ride(1.75); key('tuck')

# AIR — legs tucked up, arms wide for balance
clear()
rot('hips', x=-16); rot('spine', x=-12); rot('chest', x=-7); rot('head', x=9)
for s, sx in (('L', 1), ('R', -1)):
    rot(f'thigh{s}', x=48); rot(f'shin{s}', x=-66); rot(f'foot{s}', x=22)
    rot(f'upperArm{s}', x=-26, z=sx * 40)
    rot(f'foreArm{s}',  x=-30)
key('air')

# GRAB — fold down, lead hand reaches the board
clear()
rot('hips', x=-28); rot('spine', x=-22); rot('chest', x=-13); rot('head', x=16)
for s, sx in (('L', 1), ('R', -1)):
    rot(f'thigh{s}', x=60); rot(f'shin{s}', x=-80); rot(f'foot{s}', x=26)
rot('upperArmL', x=-58, z=30); rot('foreArmL', x=-58)
rot('upperArmR', x=-10, z=-26); rot('foreArmR', x=-18)
key('grab')

# LAND — deep compression absorbing the impact
pose_ride(2.1); key('land')

# CRASH — folded, arms thrown up, head down
clear()
rot('hips', x=-42, z=18); rot('spine', x=-30, z=13); rot('chest', x=-20, z=8)
rot('head', x=-24)
for s, sx in (('L', 1), ('R', -1)):
    rot(f'thigh{s}', x=70, z=sx * 12); rot(f'shin{s}', x=-88); rot(f'foot{s}', x=18)
    rot(f'upperArm{s}', x=-70, z=sx * 48)
    rot(f'foreArm{s}',  x=-72)
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
