import * as THREE from 'three';
import type { GhostSnapshot, RostrVoxelAsset, StuntPhase, ThrusterState } from '../types';
import {
  PLUME_DIMS,
  buildGhostMaterials,
  buildMergedCarGeometry,
  createPlumeGeometry,
  loadRostrAsset,
  type GhostMaterials,
  type PlumeDims,
} from './voxelMeshBuilder';

/** Phases in which frozen cold-gas plume cones are drawn on a snapshot. */
const PLUME_PHASES: ReadonlySet<StuntPhase> = new Set<StuntPhase>(['inverted', 'launch', 'flip', 'hover']);
const THRUST_EPS = 0.02;
const CONES_PER_SNAPSHOT = 9; // 4 lift + 4 rear + 1 retro

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const BACK = new THREE.Vector3(0, 0, -1);
const FWD = new THREE.Vector3(0, 0, 1);
const ONE = new THREE.Vector3(1, 1, 1);

const COLOR_OLD = new THREE.Color(0x6a8fd6);
const COLOR_NEW = new THREE.Color(0xfff2dc);

interface ConeSlot {
  local: THREE.Vector3;
  quat: THREE.Quaternion;
  dims: PlumeDims;
  read: (t: ThrusterState) => number;
}

/**
 * Multi-exposure strobe composite of the stunt ("THE RAMP" photograph):
 * translucent instanced Roadster snapshots + frozen plume cones when airborne.
 */
export class GhostTrail {
  readonly group = new THREE.Group();

  private readonly carGeometry: THREE.BufferGeometry;
  private readonly plumeGeometry = createPlumeGeometry();
  private readonly materials: GhostMaterials;
  private readonly slots: ConeSlot[];

  private bodyMesh: THREE.InstancedMesh | null = null;
  private outerMesh: THREE.InstancedMesh | null = null;
  private innerMesh: THREE.InstancedMesh | null = null;
  private bodyCapacity = 0;
  private coneCapacity = 0;
  private visible = true;
  private disposed = false;

  private readonly snapMat = new THREE.Matrix4();
  private readonly coneMat = new THREE.Matrix4();
  private readonly outMat = new THREE.Matrix4();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3();
  private readonly tmpColor = new THREE.Color();

  constructor(asset: RostrVoxelAsset = loadRostrAsset()) {
    this.group.name = 'GhostTrail';
    this.carGeometry = buildMergedCarGeometry(asset, 1.7);
    this.materials = buildGhostMaterials(0.42);

    const n = asset.nozzles;
    const slot = (
      a: readonly number[],
      dir: THREE.Vector3,
      dims: PlumeDims,
      read: (t: ThrusterState) => number,
    ): ConeSlot => ({
      local: new THREE.Vector3(a[0], a[1], a[2]),
      quat: new THREE.Quaternion().setFromUnitVectors(UP, dir),
      dims,
      read,
    });
    this.slots = [
      slot(n.liftFL, DOWN, PLUME_DIMS.lift, (t) => t.liftFL),
      slot(n.liftFR, DOWN, PLUME_DIMS.lift, (t) => t.liftFR),
      slot(n.liftRL, DOWN, PLUME_DIMS.lift, (t) => t.liftRL),
      slot(n.liftRR, DOWN, PLUME_DIMS.lift, (t) => t.liftRR),
      ...n.rearBoost.slice(0, 4).map((p) => slot(p, BACK, PLUME_DIMS.rear, (t) => t.rearBoost)),
      slot(n.retroFront, FWD, PLUME_DIMS.retro, (t) => t.retroFront),
    ];
  }

  setSnapshots(snapshots: GhostSnapshot[]): void {
    if (this.disposed) return;
    const snaps = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
    const count = snaps.length;
    if (count === 0) {
      this.clear();
      return;
    }
    this.ensureBodyCapacity(count);
    this.ensureConeCapacity(count * CONES_PER_SNAPSHOT);

    const body = this.bodyMesh!;
    const outer = this.outerMesh!;
    const inner = this.innerMesh!;
    let cones = 0;

    for (let i = 0; i < count; i++) {
      const s = snaps[i];
      const f = count > 1 ? i / (count - 1) : 1;
      this.tmpPos.fromArray(s.position);
      this.tmpQuat.set(s.quaternion[0], s.quaternion[1], s.quaternion[2], s.quaternion[3]);
      this.snapMat.compose(this.tmpPos, this.tmpQuat, ONE);
      body.setMatrixAt(i, this.snapMat);
      this.tmpColor.copy(COLOR_OLD).lerp(COLOR_NEW, f).multiplyScalar(0.7 + 0.3 * f);
      body.setColorAt(i, this.tmpColor);

      if (!PLUME_PHASES.has(s.phase)) continue;
      for (const slot of this.slots) {
        const intensity = slot.read(s.thrusters);
        if (intensity <= THRUST_EPS) continue;
        const k = Math.min(intensity, 1);
        const length = slot.dims.baseLen + slot.dims.gainLen * k;
        const radius = slot.dims.radius * (0.55 + 0.45 * k);
        this.tmpScale.set(radius, length, radius);
        this.coneMat.compose(slot.local, slot.quat, this.tmpScale);
        this.outMat.multiplyMatrices(this.snapMat, this.coneMat);
        outer.setMatrixAt(cones, this.outMat);
        this.tmpScale.set(radius * 0.48, length * 0.7, radius * 0.48);
        this.coneMat.compose(slot.local, slot.quat, this.tmpScale);
        this.outMat.multiplyMatrices(this.snapMat, this.coneMat);
        inner.setMatrixAt(cones, this.outMat);
        cones++;
      }
    }

    body.count = count;
    outer.count = cones;
    inner.count = cones;
    body.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    outer.instanceMatrix.needsUpdate = true;
    inner.instanceMatrix.needsUpdate = true;
    outer.visible = cones > 0;
    inner.visible = cones > 0;
    body.visible = true;
    this.group.visible = this.visible;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.group.visible = visible;
  }

  clear(): void {
    for (const mesh of [this.bodyMesh, this.outerMesh, this.innerMesh]) {
      if (!mesh) continue;
      mesh.count = 0;
      mesh.visible = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.disposeMeshes();
    this.carGeometry.dispose();
    this.plumeGeometry.dispose();
    this.materials.dispose();
    this.group.clear();
  }

  private ensureBodyCapacity(needed: number): void {
    if (this.bodyMesh && this.bodyCapacity >= needed) return;
    if (this.bodyMesh) {
      this.group.remove(this.bodyMesh);
      this.bodyMesh.dispose();
    }
    this.bodyCapacity = Math.max(needed, Math.ceil(this.bodyCapacity * 1.5), 32);
    const mesh = new THREE.InstancedMesh(this.carGeometry, this.materials.body, this.bodyCapacity);
    mesh.name = 'ghostBodies';
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    this.group.add(mesh);
    this.bodyMesh = mesh;
  }

  private ensureConeCapacity(needed: number): void {
    if (this.outerMesh && this.innerMesh && this.coneCapacity >= needed) return;
    for (const m of [this.outerMesh, this.innerMesh]) {
      if (!m) continue;
      this.group.remove(m);
      m.dispose();
    }
    this.coneCapacity = Math.max(needed, Math.ceil(this.coneCapacity * 1.5), 64);
    const make = (name: string, mat: THREE.Material): THREE.InstancedMesh => {
      const mesh = new THREE.InstancedMesh(this.plumeGeometry, mat, this.coneCapacity);
      mesh.name = name;
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      this.group.add(mesh);
      return mesh;
    };
    this.outerMesh = make('ghostPlumeOuter', this.materials.plumeOuter);
    this.innerMesh = make('ghostPlumeInner', this.materials.plumeInner);
  }

  private disposeMeshes(): void {
    for (const m of [this.bodyMesh, this.outerMesh, this.innerMesh]) {
      if (!m) continue;
      this.group.remove(m);
      m.dispose();
    }
    this.bodyMesh = null;
    this.outerMesh = null;
    this.innerMesh = null;
  }
}
