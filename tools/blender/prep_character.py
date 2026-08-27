# Headless Blender: turn a Tripo GLB into a game-ready character.
#
# usage:
#   blender --background --python tools/blender/prep_character.py -- \
#           --in <src.glb> --out <dst.glb> [--tris 28000] [--tex 1024] [--height 1.8]
#
# WHY EACH STEP EXISTS
#  * Tripo HD returns ~1.9M tris / 55 MB. That is ~180x a sane web budget and
#    would stall the main thread on load, never mind render at 60 fps.
#  * Decimation is COLLAPSE, not un-subdivide: un-subdivide wrecks a mesh whose
#    topology it does not understand, collapse preserves silhouette far better.
#  * Normals are recomputed and smoothed AFTER decimating — a lot of apparent
#    "low poly chunkiness" is flat shading, not triangle count.
#  * The mesh is normalised to a real height and its feet put on y=0, because
#    the physics contract is 1 unit = 1 m with a 1.8 m rider, and everything
#    downstream (camera framing, board attach, HUD scale) assumes it.
import bpy, sys, os, math

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(name, default=None):
    return argv[argv.index('--' + name) + 1] if ('--' + name) in argv else default

SRC = arg('in')
DST = arg('out')
TRIS = int(arg('tris', 28000))
TEX = int(arg('tex', 1024))
HEIGHT = float(arg('height', 1.8))

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
print(f'[prep] imported {len(meshes)} mesh object(s)')

# join everything into one object so there is a single draw call
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active
obj.name = 'Nyx'

def tri_count(o):
    o.data.calc_loop_triangles()
    return len(o.data.loop_triangles)

# --- CLEAN BEFORE ANYTHING ELSE --------------------------------------------
# Tripo meshes arrive non-manifold, and collapse-decimation adds more. Bone-heat
# auto-weighting needs reasonably clean topology: at 15,804 non-manifold edges it
# produced garbage weights (the HEAD ended up the single largest influence, and
# handL got 119 verts against handR's 431 on a symmetric mesh).
def clean(tag):
    import bmesh
    bm = bmesh.new(); bm.from_mesh(obj.data)
    nm = sum(1 for e in bm.edges if not e.is_manifold)
    bm.free()
    print(f'[prep] non-manifold edges {tag}: {nm}')
    return nm

clean('before clean')
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=0.0002)
bpy.ops.mesh.delete_loose()
bpy.ops.mesh.dissolve_degenerate()
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
clean('after clean')

before = tri_count(obj)
print(f'[prep] source tris: {before}')

# --- decimate to budget -----------------------------------------------------
if before > TRIS:
    m = obj.modifiers.new('dec', 'DECIMATE')
    m.decimate_type = 'COLLAPSE'
    m.ratio = TRIS / before
    m.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=m.name)
    print(f'[prep] decimated {before} -> {tri_count(obj)} (ratio {TRIS/before:.5f})')

clean('after decimate')
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=0.0004)
bpy.ops.mesh.delete_loose()
bpy.ops.mesh.dissolve_degenerate()
bpy.ops.object.mode_set(mode='OBJECT')
clean('after post-decimate clean')

# --- normals: smooth shading, recomputed outward ----------------------------
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()
# keep hard edges where the model really is hard (belt buckles, boot soles)
if hasattr(obj.data, 'use_auto_smooth'):
    obj.data.use_auto_smooth = True
    obj.data.auto_smooth_angle = math.radians(50)

# --- scale to a real rider and stand her on y=0 -----------------------------
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
bb = [obj.matrix_world @ v.co for v in obj.data.vertices]
ys = [v.z for v in bb]        # blender is Z-up; glTF export converts to Y-up
cur_h = max(ys) - min(ys)
s = HEIGHT / cur_h
obj.scale = (s, s, s)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
bb = [obj.matrix_world @ v.co for v in obj.data.vertices]
minz = min(v.z for v in bb)
cx = (max(v.x for v in bb) + min(v.x for v in bb)) / 2
cy = (max(v.y for v in bb) + min(v.y for v in bb)) / 2
obj.location = (obj.location.x - cx, obj.location.y - cy, obj.location.z - minz)
bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
print(f'[prep] height {cur_h:.3f} -> {HEIGHT} (scale {s:.4f}), feet at z=0')

# --- textures: 4096 is absurd for a 70 px tall rider ------------------------
for img in bpy.data.images:
    if img.size[0] > TEX:
        w, h = img.size
        img.scale(TEX, TEX)
        print(f'[prep] texture {img.name}: {w}x{h} -> {TEX}x{TEX}')

# Tripo exports PBR. This scene is UNLIT (MeshBasicMaterial everywhere), so
# metallic/roughness are dead weight — flatten them so the albedo is the look.
for mat in bpy.data.materials:
    if not mat.use_nodes:
        continue
    for n in mat.node_tree.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            n.inputs['Metallic'].default_value = 0.0
            if 'Roughness' in n.inputs:
                n.inputs['Roughness'].default_value = 1.0
            if 'Specular IOR Level' in n.inputs:
                n.inputs['Specular IOR Level'].default_value = 0.0

os.makedirs(os.path.dirname(DST), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=DST,
    export_format='GLB',
    export_apply=True,
    export_image_format='JPEG',
    export_jpeg_quality=85,
    export_yup=True,
)
print(f'[prep] wrote {DST} — tris {tri_count(obj)}, {os.path.getsize(DST)/1024/1024:.2f} MB')
