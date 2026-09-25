// Minimal stand-ins used only if a real module fails to load (keeps the game bootable during development).
import * as THREE from 'three';

export class Character {
  constructor({ color }) {
    this.root = new THREE.Group();
    this.mat = new THREE.MeshStandardMaterial({ color });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.33, 0.8, 6, 12), this.mat);
    body.position.y = 0.73; body.castShadow = true;
    this.root.add(body);
    this.body = body;
  }
  setColor(c) { this.mat.color.copy(c); }
  setWeapon() {}
  update(dt, s) { this.body.scale.y = s.form === 'kid' ? 1 : 0.4; this.body.position.y = s.form === 'kid' ? 0.73 : 0.3; }
  trigger() {}
  setDance() {}
  setHurt() {}
  setVisible(v) { this.root.visible = v; }
  getMuzzle(out) { return this.root.localToWorld(out.set(0.2, 1.0, 0.5)); }
  dispose() {}
}

export class FX {
  constructor() {} setCollider() {} burst() {} drop() {} ring() {} explosion() {} splatted() {} wake() {} muzzle() {} spawnFlash() {} rain() {} update() {} clear() {}
}

export class Environment {
  constructor(renderer, scene) {
    scene.background = new THREE.Color('#9fd8f0');
    this.sun = new THREE.DirectionalLight(0xfff3e0, 2.6);
    this.sun.position.set(-30, 50, -20); this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    Object.assign(this.sun.shadow.camera, { left: -55, right: 55, top: 55, bottom: -55, near: 1, far: 160 });
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.03; this.sun.shadow.radius = 3;
    this.hemi = new THREE.HemisphereLight(0xcfeaff, 0x9a8f7a, 0.9);
    scene.add(this.sun, this.sun.target, this.hemi);
    const water = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: '#2a8fb8', roughness: 0.2 }));
    water.rotation.x = -Math.PI / 2; water.position.y = -1.6; scene.add(water);
    this.envMap = null;
  }
  update() {} setTheme() {}
}

export const audio = { init() {}, setVolumes() {}, setListener() {}, play() {}, loop() { return { set() {}, stop() {} }; }, duck() {} };
export const music = { play() {}, setIntensity() {}, stop() {} };
