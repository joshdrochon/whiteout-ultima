# Headless turnaround render — proof that a processed asset still looks right.
# usage: blender --background --python tools/blender/turnaround.py -- \
#          --in <glb> --out <dir> [--views 4] [--px 512]
import bpy, sys, os, math

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(n, d=None):
    return argv[argv.index('--' + n) + 1] if ('--' + n) in argv else d

SRC, OUT = arg('in'), arg('out')
VIEWS, PX = int(arg('views', 4)), int(arg('px', 512))

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
zs = [(o.matrix_world @ v.co).z for o in objs for v in o.data.vertices]
xs = [(o.matrix_world @ v.co).x for o in objs for v in o.data.vertices]
ys = [(o.matrix_world @ v.co).y for o in objs for v in o.data.vertices]
h = max(zs) - min(zs)
cx, cy, cz = (max(xs)+min(xs))/2, (max(ys)+min(ys))/2, (max(zs)+min(zs))/2

# flat-ish lighting so we judge SILHOUETTE and TEXTURE, not a lighting rig
world = bpy.data.worlds.new('w'); bpy.context.scene.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (0.08, 0.09, 0.12, 1)
world.node_tree.nodes['Background'].inputs[1].default_value = 1.4
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
bpy.context.collection.objects.link(sun)
sun.data.energy = 2.0
sun.rotation_euler = (math.radians(55), 0, math.radians(35))

cam_data = bpy.data.cameras.new('cam')
cam = bpy.data.objects.new('cam', cam_data)
bpy.context.collection.objects.link(cam)
bpy.context.scene.camera = cam
cam_data.lens = 60
# Aim with a TRACK_TO constraint. Hand-rolled euler aiming rendered an empty
# frame — the constraint is both correct and readable.
target = bpy.data.objects.new('aim', None)
bpy.context.collection.objects.link(target)
target.location = (cx, cy, cz)
tc = cam.constraints.new('TRACK_TO')
tc.target = target
tc.track_axis = 'TRACK_NEGATIVE_Z'
tc.up_axis = 'UP_Y'

sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in \
    [i.identifier for i in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items] else 'BLENDER_EEVEE'
sc.render.resolution_x = PX
sc.render.resolution_y = int(PX * 1.6)
sc.render.film_transparent = False

os.makedirs(OUT, exist_ok=True)
dist = h * 1.9
for i in range(VIEWS):
    a = (i / VIEWS) * math.tau
    cam.location = (cx + math.sin(a) * dist, cy - math.cos(a) * dist, cz + h * 0.10)
    bpy.context.view_layer.update()
    sc.render.filepath = os.path.join(OUT, f'view{i}.png')
    bpy.ops.render.render(write_still=True)
    print(f'[turn] view{i} at {math.degrees(a):.0f} deg')
print('[turn] done')
