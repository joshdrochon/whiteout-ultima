# Retarget CMU mocap poses onto Nyx's rig by AIM MATCHING.
#
# usage:
#   blender --background --python tools/blender/retarget_pose.py -- \
#     --rig assets/characters/nyx_rigged.glb --bvh <dir> --out <glb> [--sheet <dir>]
#
# WHY AIM MATCHING RATHER THAN COPYING ROTATIONS:
#   The CMU skeleton and Nyx's rig have different rest poses (CMU is roughly a
#   T-pose, her mesh is an A-pose) and different bone rolls. Copying local
#   rotations between them produces garbage. What transfers cleanly is the
#   DIRECTION each bone points in world space — that *is* the pose. So for each
#   mapped pair we rotate her bone until it points where the mocap bone points.
#   Twist about the bone axis is lost, which does not matter for a rider read at
#   ~70 px on screen.
#
# WHY SKATEBOARD MOCAP FOR A SNOWBOARDER:
#   CMU subject 134 is a skateboarder, and a skateboard stance is a snowboard
#   stance: sideways on the board, knees bent, shoulders counter-rotated, arms
#   out for balance. Its "Lean Turn Left/Right" trials are carves. Everything
#   before this was me inventing joint angles and checking them by eye.
import bpy, sys, os, math
from mathutils import Vector, Quaternion

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(n, d=None):
    return argv[argv.index('--' + n) + 1] if ('--' + n) in argv else d

RIG_GLB, BVH_DIR, OUT = arg('rig'), arg('bvh'), arg('out')
SHEET = arg('sheet')

# our bone  <-  CMU joint whose direction it should copy
MAP = {
    'hips':      ('Hips', 'Spine'),
    'spine':     ('Spine', 'Spine1'),
    'chest':     ('Spine1', 'Neck'),
    'neck':      ('Neck', 'Head'),
    'head':      ('Head', None),
    'shoulderL': ('LeftShoulder', 'LeftArm'),
    'upperArmL': ('LeftArm', 'LeftForeArm'),
    'foreArmL':  ('LeftForeArm', 'LeftHand'),
    'handL':     ('LeftHand', None),
    'thighL':    ('LeftUpLeg', 'LeftLeg'),
    'shinL':     ('LeftLeg', 'LeftFoot'),
    'footL':     ('LeftFoot', 'LeftToeBase'),
    'shoulderR': ('RightShoulder', 'RightArm'),
    'upperArmR': ('RightArm', 'RightForeArm'),
    'foreArmR':  ('RightForeArm', 'RightHand'),
    'handR':     ('RightHand', None),
    'thighR':    ('RightUpLeg', 'RightLeg'),
    'shinR':     ('RightLeg', 'RightFoot'),
    'footR':     ('RightFoot', 'RightToeBase'),
}

# CMU trial -> our clip name, and the frame window to sample
CLIPS = {
    '134_02': 'ride',          # Go Forward
    '134_15': 'carve_left',    # Lean Turn Left
    '134_03': 'carve_right',   # Lean Turn Right
    '134_01': 'tuck',          # Duck Under
}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=RIG_GLB)
rig = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
rig.name = 'NyxRig'
mesh = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
# Replace ONLY the clips mocap covers. air / grab / land / crash have no CMU
# skateboard equivalent, so the hand-authored versions of those survive —
# deleting every action here silently dropped half the pose set.
_REPLACING = {'ride', 'carve_left', 'carve_right', 'tuck'}
for a in list(bpy.data.actions):
    if a.name in _REPLACING:
        bpy.data.actions.remove(a)
if rig.animation_data:
    rig.animation_data.action = None

def cmu_dir(src_arm, a_name, b_name):
    """world-space direction of a CMU bone at the current frame"""
    pb = src_arm.pose.bones.get(a_name)
    if pb is None:
        return None
    head = src_arm.matrix_world @ pb.head
    if b_name and src_arm.pose.bones.get(b_name):
        tail = src_arm.matrix_world @ src_arm.pose.bones[b_name].head
    else:
        tail = src_arm.matrix_world @ pb.tail
    d = tail - head
    return d.normalized() if d.length > 1e-6 else None

def apply_pose(src_arm):
    """aim every mapped bone of `rig` at its CMU counterpart's direction"""
    bpy.context.view_layer.update()
    # parents before children, so a corrected parent does not undo the child
    order = ['hips', 'spine', 'chest', 'neck', 'head',
             'shoulderL', 'upperArmL', 'foreArmL', 'handL',
             'shoulderR', 'upperArmR', 'foreArmR', 'handR',
             'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR']
    for name in order:
        if name not in MAP:
            continue
        pb = rig.pose.bones.get(name)
        if pb is None:
            continue
        want = cmu_dir(src_arm, *MAP[name])
        if want is None:
            continue
        bpy.context.view_layer.update()
        cur_head = rig.matrix_world @ pb.head
        cur_tail = rig.matrix_world @ pb.tail
        have = (cur_tail - cur_head)
        if have.length < 1e-6:
            continue
        have.normalize()
        q_world = have.rotation_difference(want)          # world-space correction
        pb.rotation_mode = 'QUATERNION'
        # convert the world correction into the bone's own space
        m = pb.matrix.to_3x3()
        q_local = (m.inverted() @ q_world.to_matrix() @ m).to_quaternion()
        pb.rotation_quaternion = pb.rotation_quaternion @ q_local
    bpy.context.view_layer.update()

def key_action(name):
    if rig.animation_data is None:
        rig.animation_data_create()
    act = bpy.data.actions.new(name)
    rig.animation_data.action = act
    for pb in rig.pose.bones:
        pb.keyframe_insert('rotation_quaternion', frame=1)
        pb.keyframe_insert('rotation_quaternion', frame=2)
    act.use_fake_user = True
    return act

def clear_pose():
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
    bpy.context.view_layer.update()

# extra knee bend on top of the mocap pose, per clip
CROUCH = {'ride': 1.0, 'carve_left': 1.15, 'carve_right': 1.15, 'tuck': 1.9}

def add_local(name, x=0.0, y=0.0, z=0.0):
    """compose an extra local rotation onto an already-retargeted bone"""
    pb = rig.pose.bones.get(name)
    if pb is None:
        return
    pb.rotation_mode = 'QUATERNION'
    extra = (Quaternion((1, 0, 0), math.radians(x))
             @ Quaternion((0, 1, 0), math.radians(y))
             @ Quaternion((0, 0, 1), math.radians(z)))
    pb.rotation_quaternion = pb.rotation_quaternion @ extra

FRAME_PICK = int(arg('frame', 200))   # mid-trial, past the settling-in
made = []
for trial, clip_name in CLIPS.items():
    path = os.path.join(BVH_DIR, trial + '.bvh')
    if not os.path.exists(path):
        print(f'[rt] MISSING {path}')
        continue
    before = set(bpy.context.scene.objects)
    bpy.ops.import_anim.bvh(filepath=path, global_scale=0.01,
                            rotate_mode='NATIVE', update_scene_fps=False,
                            update_scene_duration=False)
    src = next(o for o in set(bpy.context.scene.objects) - before if o.type == 'ARMATURE')
    n_frames = int(src.animation_data.action.frame_range[1]) if src.animation_data else 1
    f = min(FRAME_PICK, max(1, n_frames - 1))
    bpy.context.scene.frame_set(f)
    clear_pose()
    apply_pose(src)
    # CROUCH LAYER. The mocap gives real human structure — arm hang, weight
    # shift, shoulder counter-rotation — but CMU's skateboarder spends the trial
    # STANDING and pushing, not carving. A snowboard stance is deeper. So the
    # retargeted pose is the base and a parametric crouch is added on top,
    # rather than inventing the whole pose (which is what went wrong before).
    crouch = CROUCH.get(clip_name, 1.0)
    if crouch:
        add_local('hips',  x=-10 * crouch)
        add_local('spine', x=-8 * crouch)
        add_local('chest', x=-5 * crouch)
        for sfx in ('L', 'R'):
            add_local(f'thigh{sfx}', x=26 * crouch)
            add_local(f'shin{sfx}',  x=-44 * crouch)
            add_local(f'foot{sfx}',  x=18 * crouch)
    bpy.context.view_layer.update()
    key_action(clip_name)
    made.append(f'{clip_name}<-{trial}@{f}/{n_frames}')
    bpy.data.objects.remove(src, do_unlink=True)

clear_pose()
rig.animation_data.action = None
# The BVH importer leaves its own actions (134_01 etc) in the file. They are not
# game clips and would ship as dead weight in the GLB.
for a in list(bpy.data.actions):
    if a.name.split('.')[0] in CLIPS:
        bpy.data.actions.remove(a)
print('[rt] retargeted: ' + ', '.join(made))
print('[rt] clips out: ' + ', '.join(sorted(a.name for a in bpy.data.actions)))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_apply=False,
                          export_image_format='JPEG', export_jpeg_quality=85,
                          export_yup=True, export_animations=True,
                          export_nla_strips=False, export_anim_single_armature=True,
                          export_skins=True)
print(f'[rt] wrote {OUT} — {os.path.getsize(OUT)/1024/1024:.2f} MB')
