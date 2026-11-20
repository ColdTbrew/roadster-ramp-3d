import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import rostrVoxelData from '../assets/rostrVoxelData.json';
import type { RostrVoxelAsset, VoxelMaterialTag, VoxelPartData } from '../types';

/* -------------------------------------------------------------------------- */
/*  Asset loading                                                              */
/* -------------------------------------------------------------------------- */

/** Typed accessor for the bundled ROSTR voxel asset (no copy, shared reference). */
export function loadRostrAsset(): RostrVoxelAsset {
  return rostrVoxelData as unknown as RostrVoxelAsset;
}

/* -------------------------------------------------------------------------- */
/*  Materials                                                                  */
/* -------------------------------------------------------------------------- */

export const VOXEL_MATERIAL_TAGS: readonly VoxelMaterialTag[] = [0, 1, 2, 3, 4, 5];

/** Tags that are opaque lit bodywork and therefore cast/receive shadows. */
const SHADOWED_TAGS: ReadonlySet<VoxelMaterialTag> = new Set<VoxelMaterialTag>([0, 1, 2]);

/** Tags with emissive materials (colors are boosted in ghost geometry). */
const EMISSIVE_TAGS: ReadonlySet<VoxelMaterialTag> = new Set<VoxelMaterialTag>([3, 4, 5]);

export type VoxelMaterials = Record<VoxelMaterialTag, THREE.MeshStandardMaterial>;

export const TAILLIGHT_BASE_INTENSITY = 2.5;

export function createVoxelMaterials(): VoxelMaterials {
  return {
    0: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.12 }),
    1: new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.08,
      metalness: 0.15,
      clearcoat: 1.0,
      clearcoatRoughness: 0.06,
      reflectivity: 0.9,
    }),
    2: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.25, metalness: 0.85 }),
    3: new THREE.MeshStandardMaterial({
      vertexColors: true,
      emissive: 0xeef6ff,
      emissiveIntensity: 2.2,
      roughness: 0.1,
    }),
    4: new THREE.MeshStandardMaterial({
      vertexColors: true,
      emissive: 0xff1e32,
      emissiveIntensity: TAILLIGHT_BASE_INTENSITY,
      roughness: 0.1,
    }),
    5: new THREE.MeshStandardMaterial({
      vertexColors: true,
      emissive: 0xff8c1a,
      emissiveIntensity: 1.8,
      roughness: 0.15,
    }),
  };
}

export function disposeVoxelMaterials(materials: VoxelMaterials): void {
  for (const tag of VOXEL_MATERIAL_TAGS) materials[tag].dispose();
}

/* -------------------------------------------------------------------------- */
/*  Voxel -> merged BufferGeometry                                            */
/* -------------------------------------------------------------------------- */

interface FaceDef {
  /** Neighbor offset in half-voxel units (x2 per voxel step). */
  readonly step: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
  /** Four corners in unit-cube space (-0.5..0.5), CCW seen from outside. */
  readonly corners: readonly (readonly [number, number, number])[];
}

const FACES: readonly FaceDef[] = [
  {
    step: [2, 0, 0],
    normal: [1, 0, 0],
    corners: [[0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5]],
  },
  {
    step: [-2, 0, 0],
    normal: [-1, 0, 0],
    corners: [[-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, -0.5]],
  },
  {
    step: [0, 2, 0],
    normal: [0, 1, 0],
    corners: [[-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]],
  },
  {
    step: [0, -2, 0],
    normal: [0, -1, 0],
    corners: [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5]],
  },
  {
    step: [0, 0, 2],
    normal: [0, 0, 1],
    corners: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]],
  },
  {
    step: [0, 0, -2],
    normal: [0, 0, -1],
    corners: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]],
  },
];

const KEY_BIAS = 4096;
const KEY_SPAN = 8192;

function packKey(ix: number, iy: number, iz: number): number {
  return ((ix + KEY_BIAS) * KEY_SPAN + (iy + KEY_BIAS)) * KEY_SPAN + (iz + KEY_BIAS);
}

/** Deterministic 0..1 hash used for a very subtle per-voxel brightness variation. */
function hash3(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

interface TagBuffers {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
}

export interface BuildPartOptions {
  /** Added to every vertex (e.g. a part pivot, to bake a part into car space). */
  offset?: readonly [number, number, number];
  /** Multiplies vertex colors of emissive tags 3/4/5 (ghost geometry). */
  emissiveBoost?: number;
}

/**
 * Converts a flat voxel list into one static BufferGeometry per material tag.
 * Only faces not hidden by a neighboring voxel of the same part are emitted.
 * Positions are relative to the part's own origin (voxel offsets), plus `offset`.
 */
export function buildVoxelPartGeometries(
  part: VoxelPartData,
  palette: readonly string[],
  voxelSize: number,
  options: BuildPartOptions = {},
): Map<VoxelMaterialTag, THREE.BufferGeometry> {
  const { voxels } = part;
  const count = Math.floor(voxels.length / 5);
  const inv = 2 / voxelSize;
  const off = options.offset ?? [0, 0, 0];
  const boost = options.emissiveBoost ?? 1;

  const paletteColors = palette.map((hex) => new THREE.Color(hex));
  const fallback = new THREE.Color(0xffffff);

  const occupied = new Set<number>();
  for (let i = 0; i < count; i++) {
    const o = i * 5;
    occupied.add(
      packKey(Math.round(voxels[o] * inv), Math.round(voxels[o + 1] * inv), Math.round(voxels[o + 2] * inv)),
    );
  }

  const buffers = new Map<VoxelMaterialTag, TagBuffers>();

  for (let i = 0; i < count; i++) {
    const o = i * 5;
    const x = voxels[o];
    const y = voxels[o + 1];
    const z = voxels[o + 2];
    const tag = voxels[o + 4] as VoxelMaterialTag;
    const ix = Math.round(x * inv);
    const iy = Math.round(y * inv);
    const iz = Math.round(z * inv);

    let buf = buffers.get(tag);
    if (!buf) {
      buf = { positions: [], normals: [], colors: [], indices: [] };
      buffers.set(tag, buf);
    }

    const base = paletteColors[voxels[o + 3]] ?? fallback;
    let shade = 1;
    if (tag === 0 || tag === 2) shade = 0.965 + hash3(ix, iy, iz) * 0.07;
    else if (EMISSIVE_TAGS.has(tag)) shade = boost;
    const r = base.r * shade;
    const g = base.g * shade;
    const b = base.b * shade;

    for (const face of FACES) {
      if (occupied.has(packKey(ix + face.step[0], iy + face.step[1], iz + face.step[2]))) continue;
      const vi = buf.positions.length / 3;
      for (const c of face.corners) {
        buf.positions.push(
          x + c[0] * voxelSize + off[0],
          y + c[1] * voxelSize + off[1],
          z + c[2] * voxelSize + off[2],
        );
        buf.normals.push(face.normal[0], face.normal[1], face.normal[2]);
        buf.colors.push(r, g, b);
      }
      buf.indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
    }
  }

  const result = new Map<VoxelMaterialTag, THREE.BufferGeometry>();
  for (const [tag, buf] of buffers) {
    if (buf.indices.length === 0) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(buf.normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(buf.colors, 3));
    geo.setIndex(
      buf.positions.length / 3 > 65535
        ? new THREE.Uint32BufferAttribute(buf.indices, 1)
        : new THREE.Uint16BufferAttribute(buf.indices, 1),
    );
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    result.set(tag, geo);
  }
  return result;
}

/**
 * Builds a Group (positioned at the part pivot) containing one merged static mesh
 * per material tag used by the part. Voxel offsets are relative to the pivot.
 */
export function buildVoxelPartGroup(
  name: string,
  part: VoxelPartData,
  palette: readonly string[],
  voxelSize: number,
  materials: VoxelMaterials,
): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  group.position.fromArray(part.pivot);
  const geometries = buildVoxelPartGeometries(part, palette, voxelSize);
  for (const [tag, geometry] of geometries) {
    const mesh = new THREE.Mesh(geometry, materials[tag]);
    mesh.name = `${name}:tag${tag}`;
    const shadowed = SHADOWED_TAGS.has(tag);
    mesh.castShadow = shadowed;
    mesh.receiveShadow = shadowed;
    group.add(mesh);
  }
  return group;
}

/** Disposes geometries of all meshes below `root` (materials are NOT touched). */
export function disposeObjectGeometries(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose();
  });
}

/* -------------------------------------------------------------------------- */
/*  Ghost / strobe helpers                                                     */
/* -------------------------------------------------------------------------- */

const STATIC_PARTS = [
  'chassis',
  'spoiler',
  'wheelFL',
  'wheelFR',
  'wheelRL',
  'wheelRR',
] as const;

/**
 * One merged, vertex-colored geometry of the whole static car (chassis, spoiler,
 * wheels at rest), baked into car space. Ideal for instanced ghost snapshots.
 */
export function buildMergedCarGeometry(asset: RostrVoxelAsset, emissiveBoost = 1.6): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [];
  for (const key of STATIC_PARTS) {
    const part = asset.parts[key];
    const geos = buildVoxelPartGeometries(part, asset.palette, asset.voxelSize, {
      offset: part.pivot,
      emissiveBoost,
    });
    for (const geo of geos.values()) pieces.push(geo);
  }
  const merged = mergeGeometries(pieces, false);
  for (const p of pieces) p.dispose();
  if (!merged) throw new Error('buildMergedCarGeometry: nothing to merge');
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

export interface GhostMaterials {
  body: THREE.MeshBasicMaterial;
  plumeOuter: THREE.MeshBasicMaterial;
  plumeInner: THREE.MeshBasicMaterial;
  dispose(): void;
}

export function buildGhostMaterials(opacity = 0.42): GhostMaterials {
  const body = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const plumeOuter = createPlumeMaterial(0x6fbaff, opacity * 1.3);
  const plumeInner = createPlumeMaterial(0xffffff, opacity * 1.7);
  return {
    body,
    plumeOuter,
    plumeInner,
    dispose() {
      body.dispose();
      plumeOuter.dispose();
      plumeInner.dispose();
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Shared plume (cold-gas shock cone) geometry & dimensions                  */
/* -------------------------------------------------------------------------- */

export interface PlumeDims {
  /** Max base radius (m) at full intensity. */
  radius: number;
  /** Cone length at intensity 0+ (m). */
  baseLen: number;
  /** Extra cone length gained at intensity 1 (m). */
  gainLen: number;
}

export const PLUME_DIMS = {
  lift: { radius: 0.085, baseLen: 0.55, gainLen: 0.95 },
  rear: { radius: 0.075, baseLen: 1.2, gainLen: 2.6 },
  retro: { radius: 0.095, baseLen: 0.9, gainLen: 2.1 },
  rcs: { radius: 0.05, baseLen: 0.25, gainLen: 0.4 },
} as const satisfies Record<string, PlumeDims>;

/**
 * Unit plume: base at y=0 (radius ~0.7..1), tip at y=1, +Y is the exhaust direction.
 * Vertex RGBA (alpha fades toward the tip), meant for additive MeshBasicMaterial.
 */
export function createPlumeGeometry(radialSegments = 20): THREE.BufferGeometry {
  const profile: THREE.Vector2[] = [];
  const rings = 12;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const bulge = 0.72 + 0.28 * Math.sin(Math.min(t * 2.6, 1) * Math.PI * 0.5);
    profile.push(new THREE.Vector2(Math.pow(1 - t, 0.9) * bulge, t));
  }
  const geo = new THREE.LatheGeometry(profile, radialSegments);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(Math.max(pos.getY(i), 0), 1);
    const alpha = Math.pow(1 - t, 0.85);
    colors[i * 4] = 1 - t * 0.25;
    colors[i * 4 + 1] = 1 - t * 0.08;
    colors[i * 4 + 2] = 1;
    colors[i * 4 + 3] = Math.max(alpha, 0);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  geo.computeBoundingSphere();
  return geo;
}

export function createPlumeMaterial(color: THREE.ColorRepresentation, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    vertexColors: true,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

/* -------------------------------------------------------------------------- */
/*  Procedural textures                                                        */
/* -------------------------------------------------------------------------- */

export type GradientStops = readonly (readonly [number, string])[];

/**
 * Soft radial sprite texture. Uses a 2D canvas when available, with a
 * DataTexture fallback (white, smooth alpha falloff) for non-DOM environments.
 */
export function createRadialSpriteTexture(size = 128, stops?: GradientStops): THREE.Texture {
  const gradient: GradientStops =
    stops ??
    [
      [0, 'rgba(255,255,255,1)'],
      [0.25, 'rgba(255,255,255,0.75)'],
      [0.6, 'rgba(255,255,255,0.22)'],
      [1, 'rgba(255,255,255,0)'],
    ];

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      for (const [offset, color] of gradient) g.addColorStop(offset, color);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      return tex;
    }
  }

  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5) * 2;
      const a = Math.max(0, 1 - d);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(255 * a * a * (3 - 2 * a));
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

/* -------------------------------------------------------------------------- */
/*  Suction turbine impeller geometry                                          */
/* -------------------------------------------------------------------------- */

function paint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/**
 * 5-blade turbine disc facing -Z (rear), spinning about local +Z.
 * Vertex-colored; use with a metallic MeshStandardMaterial({ vertexColors: true }).
 */
export function buildImpellerGeometry(radius: number, blades = 5): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  parts.push(paint(new THREE.CylinderGeometry(radius * 0.96, radius * 0.96, 0.008, 28).rotateX(Math.PI / 2), 0x1b1e26));
  parts.push(paint(new THREE.TorusGeometry(radius, radius * 0.07, 8, 28), 0xb8864b));
  parts.push(
    paint(new THREE.CylinderGeometry(radius * 0.2, radius * 0.24, 0.026, 14).rotateX(Math.PI / 2).translate(0, 0, -0.012), 0xd5dcea),
  );

  for (let i = 0; i < blades; i++) {
    const blade = new THREE.BoxGeometry(radius * 0.78, radius * 0.2, 0.01);
    blade.rotateX(0.55);
    blade.translate(radius * 0.5, 0, -0.011);
    blade.rotateZ((i / blades) * Math.PI * 2);
    parts.push(paint(blade, 0xc6cfdf));
  }

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('buildImpellerGeometry: merge failed');
  merged.computeBoundingSphere();
  return merged;
}
