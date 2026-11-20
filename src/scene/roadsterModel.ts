import * as THREE from 'three';
import { ARENA_CONFIG } from '../types';
import type { CarState, RostrVoxelAsset, VoxelPartData } from '../types';
import {
  TAILLIGHT_BASE_INTENSITY,
  buildImpellerGeometry,
  buildVoxelPartGroup,
  createRadialSpriteTexture,
  createVoxelMaterials,
  disposeObjectGeometries,
  disposeVoxelMaterials,
  loadRostrAsset,
  type VoxelMaterials,
} from './voxelMeshBuilder';

const TAU = Math.PI * 2;
const FAN_KEYS = ['fan0', 'fan1', 'fan2', 'fan3'] as const;
const IMPELLER_RADIUS = 0.085;
/** Impeller sits just behind the shroud's rear plane so it is visible from behind. */
const IMPELLER_Z_OFFSET = -0.045;
const TAILLIGHT_BRAKE_INTENSITY = 7.0;
const SUCTION_FAN_MAX_RATE = 42; // rad/s, kept below blade-aliasing territory
const SUCTION_FAN_IDLE_RATE = 5;

function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** Articulated voxel Roadster driven by a physics `CarState`. */
export class RoadsterModel {
  readonly group = new THREE.Group();

  private readonly asset: RostrVoxelAsset;
  private readonly materials: VoxelMaterials;

  private readonly chassis: THREE.Group;
  private readonly spoiler: THREE.Group;
  private readonly wheelFL: THREE.Group;
  private readonly wheelFR: THREE.Group;
  private readonly wheelRL: THREE.Group;
  private readonly wheelRR: THREE.Group;
  private readonly fans: THREE.Group[] = [];
  private readonly impellers: THREE.Mesh[] = [];

  private readonly spoilerPivotY: number;
  private readonly fanPivotY: number[] = [];

  private readonly impellerGeometry: THREE.BufferGeometry;
  private readonly impellerMaterial: THREE.MeshStandardMaterial;

  private readonly suctionGlow: THREE.Mesh;
  private readonly suctionGlowMaterial: THREE.MeshBasicMaterial;
  private readonly suctionGlowTexture: THREE.Texture;
  private readonly suctionLight: THREE.PointLight;
  private readonly headlights: THREE.SpotLight[] = [];

  private readonly tmpLocalUp = new THREE.Vector3();

  private fanAngle = 0;
  private suction = 0;
  private taillight = TAILLIGHT_BASE_INTENSITY;
  private disposed = false;

  constructor(asset: RostrVoxelAsset = loadRostrAsset()) {
    this.asset = asset;
    this.group.name = 'RoadsterModel';
    this.materials = createVoxelMaterials();

    const { parts, palette, voxelSize } = asset;
    const build = (name: string, part: VoxelPartData) =>
      buildVoxelPartGroup(name, part, palette, voxelSize, this.materials);

    this.chassis = build('chassis', parts.chassis);
    this.spoiler = build('spoiler', parts.spoiler);
    this.wheelFL = build('wheelFL', parts.wheelFL);
    this.wheelFR = build('wheelFR', parts.wheelFR);
    this.wheelRL = build('wheelRL', parts.wheelRL);
    this.wheelRR = build('wheelRR', parts.wheelRR);
    for (const w of [this.wheelFL, this.wheelFR, this.wheelRL, this.wheelRR]) w.rotation.order = 'YXZ';
    this.spoilerPivotY = parts.spoiler.pivot[1];
    this.group.add(this.chassis, this.spoiler, this.wheelFL, this.wheelFR, this.wheelRL, this.wheelRR);

    // Rear suction fans + visible turbine impellers.
    this.impellerGeometry = buildImpellerGeometry(IMPELLER_RADIUS, 5);
    this.impellerMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.3,
      metalness: 0.85,
      emissive: 0x2ab4ff,
      emissiveIntensity: 0.1,
      side: THREE.DoubleSide,
    });
    for (const key of FAN_KEYS) {
      const part = parts[key];
      const fan = buildVoxelPartGroup(key, part, palette, voxelSize, this.materials);
      const impeller = new THREE.Mesh(this.impellerGeometry, this.impellerMaterial);
      impeller.name = `${key}:impeller`;
      impeller.position.z = IMPELLER_Z_OFFSET;
      impeller.castShadow = false;
      fan.add(impeller);
      this.fans.push(fan);
      this.impellers.push(impeller);
      this.fanPivotY.push(part.pivot[1]);
      this.group.add(fan);
    }

    // Cyan-blue underbody suction glow (ring-textured plane + light).
    this.suctionGlowTexture = createRadialSpriteTexture(256, [
      [0, 'rgba(70,180,255,0.04)'],
      [0.55, 'rgba(80,190,255,0.18)'],
      [0.82, 'rgba(150,225,255,0.75)'],
      [0.93, 'rgba(110,205,255,0.35)'],
      [1, 'rgba(60,160,255,0)'],
    ]);
    this.suctionGlowMaterial = new THREE.MeshBasicMaterial({
      map: this.suctionGlowTexture,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: false,
    });
    const { width, length } = asset.dimensions;
    this.suctionGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      this.suctionGlowMaterial,
    );
    this.suctionGlow.name = 'suctionGlow';
    this.suctionGlow.position.y = 0.012;
    this.suctionGlow.scale.set(width * 1.05, 1, length * 0.9);
    this.suctionGlow.renderOrder = 2;
    this.suctionGlow.visible = false;
    this.group.add(this.suctionGlow);

    this.suctionLight = new THREE.PointLight(0x3aa8ff, 0, 3.6, 2);
    this.suctionLight.position.set(0, 0.06, 0);
    this.group.add(this.suctionLight);

    this.buildHeadlights(parts.chassis);
  }

  /** Warm-white spot accents placed at the front LED bar (tag 3) extents. */
  private buildHeadlights(chassis: VoxelPartData): void {
    const v = chassis.voxels;
    let minX = Infinity;
    let maxX = -Infinity;
    let y = 0;
    let z = -Infinity;
    let n = 0;
    for (let i = 0; i < v.length; i += 5) {
      if (v[i + 4] !== 3 || v[i + 2] < 0) continue;
      minX = Math.min(minX, v[i]);
      maxX = Math.max(maxX, v[i]);
      z = Math.max(z, v[i + 2]);
      y += v[i + 1];
      n++;
    }
    if (n === 0) return;
    y /= n;
    const spread = (maxX - minX) * 0.38;
    for (const side of [-1, 1]) {
      const spot = new THREE.SpotLight(0xfff1dc, 9, 18, 0.5, 0.85, 2);
      spot.position.set(side * spread, y, z + 0.04);
      spot.target.position.set(side * spread * 0.8, y - 0.35, z + 9);
      spot.castShadow = false;
      this.chassis.add(spot, spot.target);
      this.headlights.push(spot);
    }
  }

  getAsset(): RostrVoxelAsset {
    return this.asset;
  }

  update(state: CarState, dt: number): void {
    if (this.disposed) return;
    const step = Math.min(Math.max(dt, 0), 0.1);
    const { thrusters } = state;

    // Root transform (+ chord sagitta lift on curved ramp so wheels ride cleanly on top).
    this.group.position.set(state.position[0], state.position[1], state.position[2]);
    this.group.quaternion.set(state.quaternion[0], state.quaternion[1], state.quaternion[2], state.quaternion[3]);
    const arcLength = ARENA_CONFIG.ramp.radius * ARENA_CONFIG.ramp.arcAngleRad;
    if (state.onRamp && state.rampS < arcLength) {
      const rampIn = Math.min(1, state.rampS / 1.4);
      const rampOut = Math.min(1, (arcLength - state.rampS) / 1.4);
      const sag = ((1.29 * 1.29) / (2 * ARENA_CONFIG.ramp.radius)) * Math.min(rampIn, rampOut);
      this.tmpLocalUp.set(0, 1, 0).applyQuaternion(this.group.quaternion);
      this.group.position.addScaledVector(this.tmpLocalUp, sag);
    }

    // Suspension: body floats, wheels stay grounded.
    const lift = state.suspensionOffset;
    this.chassis.position.y = lift;
    this.spoiler.position.y = this.spoilerPivotY + lift;
    for (let i = 0; i < this.fans.length; i++) this.fans[i].position.y = this.fanPivotY[i] + lift;

    // Wheels: front steer (yaw) + roll (spin about X).
    this.wheelFL.rotation.set(state.wheelSpin, state.steerAngle, 0);
    this.wheelFR.rotation.set(state.wheelSpin, state.steerAngle, 0);
    this.wheelRL.rotation.set(state.wheelSpin, 0, 0);
    this.wheelRR.rotation.set(state.wheelSpin, 0, 0);

    // Spoiler pitch: positive rotation.x raises the trailing edge (-Z side) upward for downforce/airbrake.
    this.spoiler.rotation.x = state.spoilerAngle;

    // Taillight boost under braking.
    this.taillight = damp(
      this.taillight,
      state.braking ? TAILLIGHT_BRAKE_INTENSITY : TAILLIGHT_BASE_INTENSITY,
      state.braking ? 24 : 8,
      step,
    );
    this.materials[4].emissiveIntensity = this.taillight;

    // Suction turbines + underbody glow.
    const targetSuction = Math.min(Math.max(thrusters.suctionPower, 0), 1);
    this.suction = damp(this.suction, targetSuction, 7, step);
    const s = this.suction;
    this.fanAngle = (this.fanAngle + step * (SUCTION_FAN_IDLE_RATE + (SUCTION_FAN_MAX_RATE - SUCTION_FAN_IDLE_RATE) * s)) % TAU;
    for (let i = 0; i < this.impellers.length; i++) {
      this.impellers[i].rotation.z = i % 2 === 0 ? this.fanAngle : -this.fanAngle;
    }
    this.impellerMaterial.emissiveIntensity = 0.1 + s * 1.4;

    const glowVisible = s > 0.01;
    this.suctionGlow.visible = glowVisible;
    this.suctionGlowMaterial.opacity = s * 0.6;
    const pulse = 1 + 0.025 * Math.sin(performance.now() * 0.012);
    this.suctionGlow.scale.set(this.asset.dimensions.width * (0.9 + 0.2 * s) * pulse, 1, this.asset.dimensions.length * (0.82 + 0.1 * s) * pulse);
    this.suctionLight.intensity = s * 5.5;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    disposeObjectGeometries(this.group);
    this.impellerGeometry.dispose();
    this.impellerMaterial.dispose();
    this.suctionGlowMaterial.dispose();
    this.suctionGlowTexture.dispose();
    disposeVoxelMaterials(this.materials);
    for (const light of this.headlights) light.dispose();
    this.suctionLight.dispose();
    this.group.clear();
  }
}
