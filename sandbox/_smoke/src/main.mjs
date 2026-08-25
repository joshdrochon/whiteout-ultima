import * as THREE from 'three';

export async function boot(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(canvas.width, canvas.height, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x88bbee);
  const camera = new THREE.PerspectiveCamera(60, canvas.width / canvas.height, 0.1, 1000);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200, 32, 32),
    new THREE.MeshStandardMaterial({ color: 0xeef2f7 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshStandardMaterial({ color: 0xcc3344 })
  );
  cube.position.y = 1;
  scene.add(cube);
  scene.add(new THREE.DirectionalLight(0xffffff, 2));
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));

  let elapsed = 0;
  return {
    scene, camera, renderer,
    sampleHeight: () => 0,
    update(dt) { elapsed += dt; cube.rotation.y = elapsed; },
    render() { renderer.render(scene, camera); },
    flythrough(t) {
      const a = t * Math.PI * 2;
      camera.position.set(Math.cos(a) * 15, 6 + 4 * t, Math.sin(a) * 15);
      camera.lookAt(0, 1, 0);
    },
  };
}
