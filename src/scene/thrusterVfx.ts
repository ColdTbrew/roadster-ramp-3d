import * as THREE from 'three';
import type { CarState, RostrVoxelAsset, ThrusterState } from '../types';
import {
  PLUME_DIMS,
  createPlumeGeometry,
  createPlumeMaterial,
  createRadialSpriteTexture,
  loadRostrAsset,
  type PlumeDims,
} from './voxelMeshBuilder';

/* -------------------------------------------------------------------------- */
/*  GPU particle pool (THREE.Points + soft radial sprite)                      */
/* -------------------------------------------------------------------------- */

const PARTICLE_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.05), 0.0, 480.0);
}
`;

const PARTICLE_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor, a);
  #include <colorspace_fragment>
}
`;

enum Kind {
  Lift = 0,
  Rear = 1,
  Retro = 2,
  Rcs = 3,
  Smoke = 4,
}

interface KindPalette {
  /** Linear RGB at birth / death. */
  c0: [number, number, number];
  c1: [number, number, number];
}

function lin(hex: number): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

const PALETTES: KindPalette[] = [
  { c0: lin(0xe6f6ff), c1: lin(0x4aa6ff) }, // lift: supersonic white-blue
  { c0: lin(0xf2ffff), c1: lin(0x35d0ff) }, // rear boost: cyan-white
  { c0: lin(0xffffff), c1: lin(0x9ad8ff) }, // retro: ice-blue
  { c0: lin(0xffffff), c1: lin(0x8cc8ff) }, // rcs
  { c0: lin(0xd2ecff), c1: lin(0xe8eef4) }, // smoke (core -> haze)
];
const SMOKE_WARM = lin(0xff8a6a);

class ParticlePool {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private count = 0;

  private readonly pos: Float32Array;
  private readonly sizes: Float32Array;
  private readonly alphas: Float32Array;
  private readonly colors: Float32Array;

  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size0: Float32Array;
  private readonly growth: Float32Array;
  private readonly peak: Float32Array;
  private readonly drag: Float32Array;
  private readonly kind: Uint8Array;

  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly texture: THREE.Texture;
  private readonly attrs: THREE.BufferAttribute[];
  private readonly bufSize = new THREE.Vector2();

  constructor(capacity: number, blending: THREE.Blending, renderOrder: number) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    this.colors = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.growth = new Float32Array(capacity);
    this.peak = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);

    const position = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    const aSize = new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage);
    const aAlpha = new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage);
    const aColor = new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage);
    this.attrs = [position, aSize, aAlpha, aColor];
    this.geometry.setAttribute('position', position);
    this.geometry.setAttribute('aSize', aSize);
    this.geometry.setAttribute('aAlpha', aAlpha);
    this.geometry.setAttribute('aColor', aColor);
    this.geometry.setDrawRange(0, 0);

    this.texture = createRadialSpriteTexture(128);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.texture }, uScale: { value: 600 } },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
    this.points.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getDrawingBufferSize(this.bufSize);
      const persp = camera as THREE.PerspectiveCamera;
      const tanHalf = persp.isPerspectiveCamera ? Math.tan((persp.fov * Math.PI) / 360) : 0.5;
      this.material.uniforms.uScale.value = this.bufSize.y / (2 * tanHalf);
    };
  }

  get alive(): number {
    return this.count;
  }

  spawn(
    kind: Kind,
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size: number, growth: number, peak: number, drag: number,
    preAge = 0,
  ): void {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    const i3 = i * 3;
    this.pos[i3] = x + vx * preAge;
    this.pos[i3 + 1] = y + vy * preAge;
    this.pos[i3 + 2] = z + vz * preAge;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.age[i] = preAge;
    this.life[i] = life;
    this.size0[i] = size;
    this.growth[i] = growth;
    this.peak[i] = peak;
    this.drag[i] = drag;
    this.kind[i] = kind;
  }

  private remove(i: number): void {
    const last = --this.count;
    if (i === last) return;
    const i3 = i * 3;
    const l3 = last * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[i3 + k] = this.pos[l3 + k];
      this.vel[i3 + k] = this.vel[l3 + k];
    }
    this.age[i] = this.age[last];
    this.life[i] = this.life[last];
    this.size0[i] = this.size0[last];
    this.growth[i] = this.growth[last];
    this.peak[i] = this.peak[last];
    this.drag[i] = this.drag[last];
    this.kind[i] = this.kind[last];
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.count) {
      const age = this.age[i] + dt;
      const life = this.life[i];
      if (age >= life) {
        this.remove(i);
        continue;
      }
      this.age[i] = age;
      const u = age / life;
      const i3 = i * 3;
      const kind = this.kind[i];

      const damp = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= damp;
      this.vel[i3 + 1] *= damp;
      this.vel[i3 + 2] *= damp;
      if (kind === Kind.Smoke) this.vel[i3 + 1] += 0.35 * dt; // slow billow rise

      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;

      // Tarmac: cold-gas streams hitting the ground are deflected radially outward.
      if (this.pos[i3 + 1] < 0.05) {
        this.pos[i3 + 1] = 0.05;
        if (kind !== Kind.Smoke && this.vel[i3 + 1] < 0) {
          const spread = Math.hypot(this.vel[i3], this.vel[i3 + 1], this.vel[i3 + 2]) * 0.45;
          const a = Math.random() * Math.PI * 2;
          this.vel[i3] = Math.cos(a) * spread;
          this.vel[i3 + 1] = 0.2 + Math.random() * 0.6;
          this.vel[i3 + 2] = Math.sin(a) * spread;
          this.drag[i] = Math.max(this.drag[i], 3.5);
        } else if (this.vel[i3 + 1] < 0) {
          this.vel[i3 + 1] = 0;
        }
      }

      const pal = PALETTES[kind];
      let r: number;
      let g: number;
      let b: number;
      let alpha: number;
      let size: number;
      if (kind === Kind.Smoke) {
        const mix = Math.min(Math.max(u * 2.2, 0), 1);
        const m = mix * mix * (3 - 2 * mix);
        r = pal.c0[0] + (pal.c1[0] - pal.c0[0]) * m;
        g = pal.c0[1] + (pal.c1[1] - pal.c0[1]) * m;
        b = pal.c0[2] + (pal.c1[2] - pal.c0[2]) * m;
        // Warm-red tarmac bounce on the low, aged, outer part of the cushion.
        const low = Math.min(Math.max(1 - this.pos[i3 + 1] / 1.4, 0), 1);
        const warm = low * 0.32 * Math.min(u * 3, 1);
        r += (SMOKE_WARM[0] - r) * warm;
        g += (SMOKE_WARM[1] - g) * warm;
        b += (SMOKE_WARM[2] - b) * warm;
        alpha = this.peak[i] * Math.min(u / 0.1, 1) * Math.pow(1 - u, 1.6);
        size = this.size0[i] * (1 + this.growth[i] * Math.sqrt(u));
      } else {
        const m = Math.min(u * 1.6, 1);
        r = pal.c0[0] + (pal.c1[0] - pal.c0[0]) * m;
        g = pal.c0[1] + (pal.c1[1] - pal.c0[1]) * m;
        b = pal.c0[2] + (pal.c1[2] - pal.c0[2]) * m;
        alpha = this.peak[i] * Math.min(u / 0.04, 1) * Math.pow(1 - u, 1.35);
        size = this.size0[i] * (1 + this.growth[i] * u);
      }
      this.colors[i3] = r;
      this.colors[i3 + 1] = g;
      this.colors[i3 + 2] = b;
      this.alphas[i] = alpha;
      this.sizes[i] = size;
      i++;
    }

    const n = this.count;
    this.geometry.setDrawRange(0, n);
    const strides = [3, 1, 1, 3];
    for (let a = 0; a < this.attrs.length; a++) {
      const attr = this.attrs[a];
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, Math.max(n, 1) * strides[a]);
      attr.needsUpdate = true;
    }
  }

  clear(): void {
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/*  Emitters / cone jets                                                       */
/* -------------------------------------------------------------------------- */

interface JetStyle {
  kind: Kind;
  dims: PlumeDims;
  /** Particles per second at intensity 1. */
  rate: number;
  speed: number;
  /** Cone half-angle spread (radians). */
  spread: number;
  life: [number, number];
  size: number;
  growth: number;
  alpha: number;
  drag: number;
  glow: number;
}

const STYLE_LIFT: JetStyle = {
  kind: Kind.Lift, dims: PLUME_DIMS.lift, rate: 130, speed: 15, spread: 0.07,
  life: [0.3, 0.55], size: 0.16, growth: 2.4, alpha: 0.85, drag: 0.6, glow: 0.5,
};
const STYLE_REAR: JetStyle = {
  kind: Kind.Rear, dims: PLUME_DIMS.rear, rate: 170, speed: 34, spread: 0.035,
  life: [0.35, 0.7], size: 0.14, growth: 3.0, alpha: 0.8, drag: 0.35, glow: 0.55,
};
const STYLE_RETRO: JetStyle = {
  kind: Kind.Retro, dims: PLUME_DIMS.retro, rate: 190, speed: 26, spread: 0.055,
  life: [0.3, 0.6], size: 0.2, growth: 3.4, alpha: 0.9, drag: 0.5, glow: 0.7,
};
const STYLE_RCS: JetStyle = {
  kind: Kind.Rcs, dims: PLUME_DIMS.rcs, rate: 90, speed: 13, spread: 0.1,
  life: [0.12, 0.26], size: 0.08, growth: 2.2, alpha: 0.9, drag: 1.2, glow: 0.35,
};

interface JetEmitter {
  id: string;
  style: JetStyle;
  local: THREE.Vector3;
  dir: THREE.Vector3;
  read: (t: ThrusterState) => number;
  root: THREE.Group;
  outer: THREE.Mesh;
  inner: THREE.Mesh;
  glow: THREE.Sprite;
  prev: THREE.Vector3;
  hasPrev: boolean;
  accum: number;
  phase: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const BACK = new THREE.Vector3(0, 0, -1);
const FWD = new THREE.Vector3(0, 0, 1);
const LEFT = new THREE.Vector3(1, 0, 0);
const RIGHT = new THREE.Vector3(-1, 0, 0);

/**
 * World-space cold-gas thruster VFX: shock cones, GPU particle jets, RCS puffs
 * and the billowing ground-effect nitrogen smoke cushion.
 * Add `group` directly to the scene (it lives in world space, not under the car).
 */
export class ThrusterVfx {
  readonly group = new THREE.Group();

  private readonly carFrame = new THREE.Group();
  private readonly gas = new ParticlePool(9000, THREE.AdditiveBlending, 3);
  private readonly smoke = new ParticlePool(3200, THREE.NormalBlending, 2);
  private readonly emitters: JetEmitter[] = [];
  private readonly plumeGeometry = createPlumeGeometry();
  private readonly outerMaterial = createPlumeMaterial(0x6fbaff, 0.7);
  private readonly innerMaterial = createPlumeMaterial(0xffffff, 0.95);
  private readonly glowTexture = createRadialSpriteTexture(128);
  private readonly glowMaterial = new THREE.SpriteMaterial({
    map: this.glowTexture,
    color: 0xbfe6ff,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly coolLight = new THREE.PointLight(0x9fd4ff, 0, 10, 2);
  private readonly warmLight = new THREE.PointLight(0xff5a3a, 0, 9, 2);

  private readonly liftLocal: THREE.Vector3[] = [];
  private readonly smokePrev: THREE.Vector3[] = [];
  private smokeAccum = 0;

  private readonly carPos = new THREE.Vector3();
  private readonly carQuat = new THREE.Quaternion();
  private readonly carMat = new THREE.Matrix4();
  private readonly carVel = new THREE.Vector3();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly ONE = new THREE.Vector3(1, 1, 1);

  private time = 0;
  private disposed = false;

  constructor(asset: RostrVoxelAsset = loadRostrAsset()) {
    this.group.name = 'ThrusterVfx';
    this.carFrame.name = 'ThrusterVfx:carFrame';
    this.group.add(this.smoke.points, this.gas.points, this.carFrame, this.coolLight, this.warmLight);

    const n = asset.nozzles;
    const v = (a: readonly number[]) => new THREE.Vector3(a[0], a[1], a[2]);

    this.addEmitter('liftFL', STYLE_LIFT, v(n.liftFL), DOWN, (t) => t.liftFL);
    this.addEmitter('liftFR', STYLE_LIFT, v(n.liftFR), DOWN, (t) => t.liftFR);
    this.addEmitter('liftRL', STYLE_LIFT, v(n.liftRL), DOWN, (t) => t.liftRL);
    this.addEmitter('liftRR', STYLE_LIFT, v(n.liftRR), DOWN, (t) => t.liftRR);
    this.liftLocal.push(v(n.liftFL), v(n.liftFR), v(n.liftRL), v(n.liftRR));
    for (let i = 0; i < 4; i++) this.smokePrev.push(new THREE.Vector3());

    n.rearBoost.forEach((p, i) => this.addEmitter(`rear${i}`, STYLE_REAR, v(p), BACK, (t) => t.rearBoost));
    this.addEmitter('retro', STYLE_RETRO, v(n.retroFront), FWD, (t) => t.retroFront);

    // RCS micro-bursts: couples around the perimeter anchors.
    this.addEmitter('rcsL-up', STYLE_RCS, v(n.rcsLeft), UP, (t) => t.rcsRollL);
    this.addEmitter('rcsL-dn', STYLE_RCS, v(n.rcsLeft), DOWN, (t) => t.rcsRollR);
    this.addEmitter('rcsR-dn', STYLE_RCS, v(n.rcsRight), DOWN, (t) => t.rcsRollL);
    this.addEmitter('rcsR-up', STYLE_RCS, v(n.rcsRight), UP, (t) => t.rcsRollR);
    this.addEmitter('rcsN-dn', STYLE_RCS, v(n.rcsNose), DOWN, (t) => t.rcsPitchUp);
    this.addEmitter('rcsN-up', STYLE_RCS, v(n.rcsNose), UP, (t) => t.rcsPitchDown);
    this.addEmitter('rcsT-up', STYLE_RCS, v(n.rcsTail), UP, (t) => t.rcsPitchUp);
    this.addEmitter('rcsT-dn', STYLE_RCS, v(n.rcsTail), DOWN, (t) => t.rcsPitchDown);
    // Lateral venting on the sides adds a little visual punch to roll commands.
    this.addEmitter('rcsL-out', STYLE_RCS, v(n.rcsLeft), LEFT, (t) => Math.max(t.rcsRollL, t.rcsRollR) * 0.6);
    this.addEmitter('rcsR-out', STYLE_RCS, v(n.rcsRight), RIGHT, (t) => Math.max(t.rcsRollL, t.rcsRollR) * 0.6);

    this.reset();
  }

  private addEmitter(
    id: string,
    style: JetStyle,
    local: THREE.Vector3,
    dir: THREE.Vector3,
    read: (t: ThrusterState) => number,
  ): void {
    const root = new THREE.Group();
    root.name = `jet:${id}`;
    root.position.copy(local);
    root.quaternion.setFromUnitVectors(UP, dir);
    const outer = new THREE.Mesh(this.plumeGeometry, this.outerMaterial);
    const inner = new THREE.Mesh(this.plumeGeometry, this.innerMaterial);
    const glow = new THREE.Sprite(this.glowMaterial);
    outer.frustumCulled = false;
    inner.frustumCulled = false;
    root.add(outer, inner, glow);
    root.visible = false;
    this.carFrame.add(root);
    this.emitters.push({
      id, style, local, dir: dir.clone(), read, root, outer, inner, glow,
      prev: new THREE.Vector3(), hasPrev: false, accum: 0, phase: Math.random() * 100,
    });
  }

  update(state: CarState, dtRaw: number): void {
    if (this.disposed) return;
    const dt = Math.min(Math.max(dtRaw, 0), 0.05);
    this.time += dt;

    this.carPos.fromArray(state.position);
    this.carQuat.set(state.quaternion[0], state.quaternion[1], state.quaternion[2], state.quaternion[3]);
    this.carVel.fromArray(state.velocity);
    this.carFrame.position.copy(this.carPos);
    this.carFrame.quaternion.copy(this.carQuat);
    this.carMat.compose(this.carPos, this.carQuat, this.ONE);
    const t = state.thrusters;

    let liftSum = 0;
    for (const e of this.emitters) {
      const intensity = Math.min(Math.max(e.read(t), 0), 1.25);
      const world = this.tmpPos.copy(e.local).applyMatrix4(this.carMat);
      const dirW = this.tmpDir.copy(e.dir).applyQuaternion(this.carQuat);
      if (e.id.startsWith('lift')) liftSum += intensity;

      if (!e.hasPrev) {
        e.prev.copy(world);
        e.hasPrev = true;
      }

      if (intensity > 0.02) {
        this.updateCone(e, intensity, world, dirW);
        this.emitGas(e, intensity, dt, world, dirW);
      } else {
        e.root.visible = false;
        e.accum = 0;
      }
      e.prev.copy(world);
    }

    this.emitSmoke(state, dt);
    this.updateLights(state, liftSum);

    this.gas.update(dt);
    this.smoke.update(dt);
  }

  private updateCone(e: JetEmitter, intensity: number, world: THREE.Vector3, dirW: THREE.Vector3): void {
    const { dims, glow } = e.style;
    const flicker = 1 + 0.07 * Math.sin(this.time * 71 + e.phase) + 0.05 * Math.sin(this.time * 133 + e.phase * 1.7);
    let length = (dims.baseLen + dims.gainLen * Math.min(intensity, 1)) * flicker;
    // Don't let cones poke through the tarmac.
    if (dirW.y < -0.05) length = Math.min(length, Math.max(world.y / -dirW.y, 0.08));
    const radius = dims.radius * (0.55 + 0.45 * Math.min(intensity, 1)) * (2 - flicker);
    e.root.visible = true;
    e.outer.scale.set(radius, length, radius);
    e.inner.scale.set(radius * 0.48, length * 0.7, radius * 0.48);
    const g = (0.18 + dims.radius * 4) * (0.6 + 0.8 * Math.min(intensity, 1)) * (0.8 + glow);
    e.glow.scale.set(g, g, g);
  }

  private emitGas(e: JetEmitter, intensity: number, dt: number, world: THREE.Vector3, dirW: THREE.Vector3): void {
    const s = e.style;
    e.accum += s.rate * Math.min(intensity, 1.2) * dt;
    const n = Math.floor(e.accum);
    e.accum -= n;
    if (n <= 0) return;

    // Orthonormal basis for the spread cone.
    const a = Math.abs(dirW.y) < 0.9 ? this.tmpA.set(0, 1, 0) : this.tmpA.set(1, 0, 0);
    a.cross(dirW).normalize();
    const b = this.tmpB.copy(dirW).cross(a);

    for (let k = 0; k < n; k++) {
      const u = Math.random();
      const px = e.prev.x + (world.x - e.prev.x) * u;
      const py = e.prev.y + (world.y - e.prev.y) * u;
      const pz = e.prev.z + (world.z - e.prev.z) * u;
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.sqrt(Math.random()) * s.spread;
      const ca = Math.cos(ang) * rad;
      const sa = Math.sin(ang) * rad;
      const dx = dirW.x + a.x * ca + b.x * sa;
      const dy = dirW.y + a.y * ca + b.y * sa;
      const dz = dirW.z + a.z * ca + b.z * sa;
      const inv = 1 / Math.hypot(dx, dy, dz);
      const speed = s.speed * (0.8 + Math.random() * 0.35) * (0.55 + 0.45 * Math.min(intensity, 1));
      const inherit = 0.8;
      this.gas.spawn(
        s.kind,
        px, py, pz,
        dx * inv * speed + this.carVel.x * inherit,
        dy * inv * speed + this.carVel.y * inherit,
        dz * inv * speed + this.carVel.z * inherit,
        s.life[0] + Math.random() * (s.life[1] - s.life[0]),
        s.size * (0.8 + Math.random() * 0.5),
        s.growth,
        s.alpha * (0.7 + 0.3 * Math.min(intensity, 1)),
        s.drag,
        (1 - u) * dt,
      );
    }
  }

  /** Ground-effect nitrogen vapor cushion spreading radially across the tarmac. */
  private emitSmoke(state: CarState, dt: number): void {
    const intensity = state.thrusters.groundEffectIntensity;
    const cx = this.carPos.x;
    const cz = this.carPos.z;
    for (let i = 0; i < this.liftLocal.length; i++) {
      const w = this.tmpPos.copy(this.liftLocal[i]).applyMatrix4(this.carMat);
      this.smokePrev[i].set(w.x, 0, w.z);
    }
    if (intensity <= 0.02) {
      this.smokeAccum = 0;
      return;
    }

    const k = Math.min(intensity, 1.2);
    this.smokeAccum += 150 * k * dt;
    const n = Math.floor(this.smokeAccum);
    this.smokeAccum -= n;
    for (let j = 0; j < n; j++) {
      const p = this.smokePrev[(Math.random() * this.smokePrev.length) | 0];
      const jitter = 0.35;
      const x = p.x + (Math.random() - 0.5) * jitter;
      const z = p.z + (Math.random() - 0.5) * jitter;
      let ox = x - cx;
      let oz = z - cz;
      const len = Math.hypot(ox, oz);
      if (len < 1e-3) {
        const a = Math.random() * Math.PI * 2;
        ox = Math.cos(a);
        oz = Math.sin(a);
      } else {
        ox /= len;
        oz /= len;
      }
      // Blend in some random azimuth so the cushion billows evenly.
      const a = Math.random() * Math.PI * 2;
      const rx = ox * 0.6 + Math.cos(a) * 0.4;
      const rz = oz * 0.6 + Math.sin(a) * 0.4;
      const speed = (2.5 + Math.random() * 6.5) * (0.5 + 0.5 * k);
      this.smoke.spawn(
        Kind.Smoke,
        x, 0.1 + Math.random() * 0.45, z,
        rx * speed + this.carVel.x * 0.12,
        0.25 + Math.random() * 1.0,
        rz * speed + this.carVel.z * 0.12,
        1.5 + Math.random() * 1.5,
        0.55 + Math.random() * 0.5,
        3.2 + Math.random() * 2.0,
        0.42 * (0.55 + 0.45 * k),
        1.6 + Math.random() * 0.9,
        Math.random() * dt,
      );
    }
  }

  private updateLights(state: CarState, liftSum: number): void {
    const lift = Math.min(liftSum / 4, 1);
    this.coolLight.intensity = lift * 9;
    this.coolLight.position.set(this.carPos.x, Math.max(this.carPos.y - 0.25, 0.15), this.carPos.z);
    const ge = Math.min(Math.max(state.thrusters.groundEffectIntensity, 0), 1);
    this.warmLight.intensity = ge * 8;
    this.warmLight.position.set(this.carPos.x, 0.45, this.carPos.z);
  }

  reset(): void {
    this.gas.clear();
    this.smoke.clear();
    this.smokeAccum = 0;
    this.time = 0;
    for (const e of this.emitters) {
      e.hasPrev = false;
      e.accum = 0;
      e.root.visible = false;
    }
    this.coolLight.intensity = 0;
    this.warmLight.intensity = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.gas.dispose();
    this.smoke.dispose();
    this.plumeGeometry.dispose();
    this.outerMaterial.dispose();
    this.innerMaterial.dispose();
    this.glowMaterial.dispose();
    this.glowTexture.dispose();
    this.coolLight.dispose();
    this.warmLight.dispose();
    this.emitters.length = 0;
    this.group.clear();
    this.carFrame.clear();
  }
}
