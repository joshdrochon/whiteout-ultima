# Render every pose action in a rigged GLB from a 3/4 view — the proof that
# skinning actually deforms instead of melting.
# usage: blender --background --python tools/blender/pose_sheet.py -- \
#          --in <rigged.glb> --out <dir> [--px 380]
import bpy, sys, os, math

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(n, d=None):
    return argv[argv.index('--' + n) + 1] if ('--' + n) in argv else d

SRC, OUT = arg('in'), arg('out')
PX = int(arg('px', 380))

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)

rig = next((o for o in bpy.context.scene.objects if o.type == 'ARMATURE'), None)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
co = [m.matrix_world @ v.co for m in meshes for v in m.data.vertices]
H = max(c.z for c in co) - min(c.z for c in co)
cx = (max(c.x for c in co) + min(c.x for c in co)) / 2
cy = (max(c.y for c in co) + min(c.y for c in co)) / 2
cz = (max(c.z for c in co) + min(c.z for c in co)) / 2

world = bpy.data.worlds.new('w'); bpy.context.scene.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (0.09, 0.10, 0.13, 1)
world.node_tree.nodes['Background'].inputs[1].default_value = 1.3
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
bpy.context.collection.objects.link(sun)
sun.data.energy = 2.2
sun.rotation_euler = (math.radians(52), 0, math.radians(40))

cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
bpy.context.collection.objects.link(cam)
bpy.context.scene.camera = cam
cam.data.lens = 55
tgt = bpy.data.objects.new('aim', None)
bpy.context.collection.objects.link(tgt)
tgt.location = (cx, cy, cz)
tc = cam.constraints.new('TRACK_TO')
tc.target = tgt; tc.track_axis = 'TRACK_NEGATIVE_Z'; tc.up_axis = 'UP_Y'

a = math.radians(35)
d = H * 1.9
cam.location = (cx + math.sin(a) * d, cy - math.cos(a) * d, cz + H * 0.12)

sc = bpy.context.scene
engines = [i.identifier for i in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
sc.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in engines else 'BLENDER_EEVEE'
sc.render.resolution_x = PX
sc.render.resolution_y = int(PX * 1.5)

os.makedirs(OUT, exist_ok=True)
acts = [a for a in bpy.data.actions]
print(f'[pose] {len(acts)} actions, rig={rig.name if rig else None}')
if rig and rig.animation_data is None:
    rig.animation_data_create()
for act in acts:
    rig.animation_data.action = act
    sc.frame_set(1)
    bpy.context.view_layer.update()
    sc.render.filepath = os.path.join(OUT, f'{act.name}.png')
    bpy.ops.render.render(write_still=True)
    print(f'[pose] rendered {act.name}')
print('[pose] done')
