import * as THREE from 'three';
import { getRampMeshProfile } from '../physics/rampCurve';
import { ARENA_CONFIG, RampConfig, RampSample } from '../types';

interface StrutSpec {
  a: THREE.Vector3;
  b: THREE.Vector3;
  thickness: number;
}

const SLAB_THICKNESS = 0.45;
const PROFILE_SEGMENTS = 72;

/**
 * Giant curved concrete & 3D steel-truss C-ramp mesh.
 *
 * Geometry is generated strictly from `getRampMeshProfile(72)` so the visual
 * driving surface matches the physics solver millimeter-for-millimeter:
 * - Smooth extruded concrete roadway slab (width = ARENA_CONFIG.ramp.width, thickness ~0.45m)
 *   with crisp white dashed centerline & concrete slab texture
 * - Glowing red LED safety side rail strips along both +Z and -Z edges (emissive 0xff1e2e)
 * - Detailed 3D steel lattice truss support tower (vertical steel columns x ≈ 24..27,
 *   horizontal cross-girders, diagonal X-bracing, cantilevered upper deck truss)
 *   anchored cleanly down to concrete footings at Y = 0
 */
export class RampMesh {
  public readonly group: THREE.Group;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly instancedMeshes: THREE.InstancedMesh[] = [];

  constructor(cfg?: RampConfig) {
    this.group = new THREE.Group();
    this.group.name = 'GiantCurvedCRamp';

    const rampCfg = cfg ?? ARENA_CONFIG.ramp;
    const samples = cfg ? getRampMeshProfile(PROFILE_SEGMENTS, cfg) : getRampMeshProfile(PROFILE_SEGMENTS);

    if (samples.length < 2) {
      return;
    }

    this.buildConcreteRoadwaySlab(samples, rampCfg.width);
    this.buildRedLedSideRails(samples, rampCfg.width);
    this.buildSteelLatticeTrussTower(samples, rampCfg);
  }

  public dispose(): void {
    for (const geo of this.geometries) {
      geo.dispose();
    }
    for (const mat of this.materials) {
      mat.dispose();
    }
    for (const tex of this.textures) {
      tex.dispose();
    }
    for (const inst of this.instancedMeshes) {
      inst.dispose();
    }
    this.geometries.length = 0;
    this.materials.length = 0;
    this.textures.length = 0;
    this.instancedMeshes.length = 0;
    this.group.clear();
  }

  private trackGeometry<T extends THREE.BufferGeometry>(geo: T): T {
    this.geometries.push(geo);
    return geo;
  }

  private trackMaterial<T extends THREE.Material>(mat: T): T {
    this.materials.push(mat);
    return mat;
  }

  private trackTexture<T extends THREE.Texture>(tex: T): T {
    this.textures.push(tex);
    return tex;
  }

  private buildConcreteRoadwaySlab(samples: RampSample[], width: number): void {
    const hw = width * 0.5;
    const n = samples.length;

    // 1. Driving surface mesh (inward face pointing along +normal)
    const drivePos: number[] = [];
    const driveNorm: number[] = [];
    const driveUv: number[] = [];
    const driveIdx: number[] = [];

    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const [px, py, pz] = s.position;
      const [nx, ny, nz] = s.normal;
      const [sx, sy, sz] = s.side;

      // Left edge (-S)
      drivePos.push(px - sx * hw, py - sy * hw, pz - sz * hw);
      driveNorm.push(nx, ny, nz);
      driveUv.push(0, s.s / 4.2);

      // Right edge (+S)
      drivePos.push(px + sx * hw, py + sy * hw, pz + sz * hw);
      driveNorm.push(nx, ny, nz);
      driveUv.push(1, s.s / 4.2);

      if (i < n - 1) {
        const a = i * 2;
        const d = a + 1;
        const b = (i + 1) * 2;
        const c = b + 1;
        // CCW winding for +N: (d - a) x (b - a) = S x T = +N
        driveIdx.push(a, d, c, a, c, b);
      }
    }

    const driveGeo = this.trackGeometry(new THREE.BufferGeometry());
    driveGeo.setAttribute('position', new THREE.Float32BufferAttribute(drivePos, 3));
    driveGeo.setAttribute('normal', new THREE.Float32BufferAttribute(driveNorm, 3));
    driveGeo.setAttribute('uv', new THREE.Float32BufferAttribute(driveUv, 2));
    driveGeo.setIndex(driveIdx);

    const { roadColorTex, roadRoughTex } = this.createRoadwayTextures();
    const driveMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        map: roadColorTex,
        roughnessMap: roadRoughTex,
        bumpMap: roadRoughTex,
        bumpScale: 0.02,
        roughness: 0.92,
        metalness: 0.08,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
    );

    const driveMesh = new THREE.Mesh(driveGeo, driveMat);
    driveMesh.name = 'RampDrivingSurface';
    driveMesh.castShadow = true;
    driveMesh.receiveShadow = true;
    this.group.add(driveMesh);

    // 2. Structural concrete shell: back face (-N), +Z side wall, -Z side wall, start & lip caps
    const shellPos: number[] = [];
    const shellNorm: number[] = [];
    const shellUv: number[] = [];
    const shellIdx: number[] = [];

    const pushQuad = (
      v0: THREE.Vector3,
      v1: THREE.Vector3,
      v2: THREE.Vector3,
      v3: THREE.Vector3,
      n0: THREE.Vector3,
      n1: THREE.Vector3,
      n2: THREE.Vector3,
      n3: THREE.Vector3,
      uv0: [number, number],
      uv1: [number, number],
      uv2: [number, number],
      uv3: [number, number]
    ): void => {
      const base = shellPos.length / 3;
      shellPos.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z, v3.x, v3.y, v3.z);
      shellNorm.push(n0.x, n0.y, n0.z, n1.x, n1.y, n1.z, n2.x, n2.y, n2.z, n3.x, n3.y, n3.z);
      shellUv.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1], uv3[0], uv3[1]);
      shellIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    const dl: THREE.Vector3[] = [];
    const dr: THREE.Vector3[] = [];
    const bl: THREE.Vector3[] = [];
    const br: THREE.Vector3[] = [];
    const norms: THREE.Vector3[] = [];
    const sides: THREE.Vector3[] = [];
    const tangs: THREE.Vector3[] = [];

    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const p = new THREE.Vector3(...s.position);
      const nv = new THREE.Vector3(...s.normal);
      const sv = new THREE.Vector3(...s.side);
      const tv = new THREE.Vector3(...s.tangent);
      norms.push(nv);
      sides.push(sv);
      tangs.push(tv);

      const dLeft = p.clone().addScaledVector(sv, -hw);
      const dRight = p.clone().addScaledVector(sv, hw);
      dl.push(dLeft);
      dr.push(dRight);
      bl.push(dLeft.clone().addScaledVector(nv, -SLAB_THICKNESS));
      br.push(dRight.clone().addScaledVector(nv, -SLAB_THICKNESS));
    }

    for (let i = 0; i < n - 1; i++) {
      const vA = samples[i].s / 3.5;
      const vB = samples[i + 1].s / 3.5;

      // Back face (outward normal = -N): (bl[i], bl[i+1], br[i+1], br[i])
      const negN0 = norms[i].clone().negate();
      const negN1 = norms[i + 1].clone().negate();
      pushQuad(
        bl[i],
        bl[i + 1],
        br[i + 1],
        br[i],
        negN0,
        negN1,
        negN1,
        negN0,
        [0, vA],
        [0, vB],
        [1, vB],
        [1, vA]
      );

      // +S side wall (normal = +S): (dr[i], br[i], br[i+1], dr[i+1])
      pushQuad(
        dr[i],
        br[i],
        br[i + 1],
        dr[i + 1],
        sides[i],
        sides[i],
        sides[i + 1],
        sides[i + 1],
        [0, vA],
        [1, vA],
        [1, vB],
        [0, vB]
      );

      // -S side wall (normal = -S): (dl[i], dl[i+1], bl[i+1], bl[i])
      const negS0 = sides[i].clone().negate();
      const negS1 = sides[i + 1].clone().negate();
      pushQuad(
        dl[i],
        dl[i + 1],
        bl[i + 1],
        bl[i],
        negS0,
        negS1,
        negS1,
        negS0,
        [0, vA],
        [0, vB],
        [1, vB],
        [1, vA]
      );
    }

    // Start cap (normal = -T0)
    const startNorm = tangs[0].clone().negate();
    pushQuad(
      dl[0],
      bl[0],
      br[0],
      dr[0],
      startNorm,
      startNorm,
      startNorm,
      startNorm,
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0]
    );

    // Overhanging launch lip end cap (normal = +T_last)
    const last = n - 1;
    const endNorm = tangs[last].clone();
    pushQuad(
      dl[last],
      dr[last],
      br[last],
      bl[last],
      endNorm,
      endNorm,
      endNorm,
      endNorm,
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1]
    );

    const shellGeo = this.trackGeometry(new THREE.BufferGeometry());
    shellGeo.setAttribute('position', new THREE.Float32BufferAttribute(shellPos, 3));
    shellGeo.setAttribute('normal', new THREE.Float32BufferAttribute(shellNorm, 3));
    shellGeo.setAttribute('uv', new THREE.Float32BufferAttribute(shellUv, 2));
    shellGeo.setIndex(shellIdx);

    const concreteSideTex = this.createConcreteFormworkTexture();
    const shellMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        map: concreteSideTex,
        color: 0x8e95a2,
        roughness: 0.84,
        metalness: 0.12,
      })
    );

    const shellMesh = new THREE.Mesh(shellGeo, shellMat);
    shellMesh.name = 'RampConcreteShell';
    shellMesh.castShadow = true;
    shellMesh.receiveShadow = true;
    this.group.add(shellMesh);
  }

  private buildRedLedSideRails(samples: RampSample[], width: number): void {
    const hw = width * 0.5;

    const railHousingMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0x1a1e28,
        roughness: 0.42,
        metalness: 0.78,
      })
    );

    const redLedMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0xff4654,
        emissive: 0xff1e2e,
        emissiveIntensity: 3.4,
        roughness: 0.16,
        metalness: 0.08,
      })
    );

    // Extrude raised steel curb housing + continuous glowing red LED strip on both +Z and -Z sides
    for (const sideSign of [-1, 1]) {
      // Steel curb lip along inner edge of deck border
      const curbGeo = this.extrudeProfileRect(
        samples,
        sideSign * (hw + 0.05),
        sideSign * (hw + 0.21),
        -SLAB_THICKNESS * 0.55,
        0.16
      );
      const curbMesh = new THREE.Mesh(curbGeo, railHousingMat);
      curbMesh.name = sideSign > 0 ? 'RampSideRailPlusZ' : 'RampSideRailMinusZ';
      curbMesh.castShadow = true;
      curbMesh.receiveShadow = true;
      this.group.add(curbMesh);

      // Glowing red LED safety strip mounted proudly along top & outer face of the curb
      const ledGeo = this.extrudeProfileRect(
        samples,
        sideSign * (hw + 0.06),
        sideSign * (hw + 0.25),
        0.04,
        0.21
      );
      const ledMesh = new THREE.Mesh(ledGeo, redLedMat);
      ledMesh.name = sideSign > 0 ? 'RampRedLedPlusZ' : 'RampRedLedMinusZ';
      this.group.add(ledMesh);

      // Second sleek red LED trace along the outer back rim so the entire C-silhouette glows vividly
      const outerRimGeo = this.extrudeProfileRect(
        samples,
        sideSign * (hw + 0.01),
        sideSign * (hw + 0.12),
        -SLAB_THICKNESS - 0.02,
        -SLAB_THICKNESS + 0.11
      );
      const outerRimMesh = new THREE.Mesh(outerRimGeo, redLedMat);
      this.group.add(outerRimMesh);
    }

    // Razor-sharp red LED accent bar spanning across the cantilevered launch lip nose
    const tip = samples[samples.length - 1];
    const tipPos = new THREE.Vector3(...tip.position);
    const tipN = new THREE.Vector3(...tip.normal);
    const tipT = new THREE.Vector3(...tip.tangent);
    const tipS = new THREE.Vector3(...tip.side);

    const lipBarGeo = this.trackGeometry(new THREE.BoxGeometry(0.14, 0.16, width + 0.42));
    const lipBar = new THREE.Mesh(lipBarGeo, redLedMat);
    const lipCenter = tipPos
      .clone()
      .addScaledVector(tipN, -SLAB_THICKNESS * 0.45)
      .addScaledVector(tipT, 0.05);
    lipBar.position.copy(lipCenter);

    const basis = new THREE.Matrix4().makeBasis(tipT, tipN, tipS);
    lipBar.quaternion.setFromRotationMatrix(basis);
    lipBar.name = 'RampLaunchLipRedBar';
    this.group.add(lipBar);

    // Subtle additive crimson halo ribbon along the +Z camera-facing red LED edge
    const glowPos: number[] = [];
    const glowUv: number[] = [];
    const glowIdx: number[] = [];
    const glowHalfH = 0.55;

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const p = new THREE.Vector3(...s.position);
      const nv = new THREE.Vector3(...s.normal);
      const sv = new THREE.Vector3(...s.side);

      const center = p
        .clone()
        .addScaledVector(sv, hw + 0.27)
        .addScaledVector(nv, 0.12);
      const inner = center.clone().addScaledVector(nv, glowHalfH);
      const outer = center.clone().addScaledVector(nv, -glowHalfH);

      glowPos.push(inner.x, inner.y, inner.z, outer.x, outer.y, outer.z);
      glowUv.push(0, i / (samples.length - 1), 1, i / (samples.length - 1));

      if (i < samples.length - 1) {
        const a = i * 2;
        glowIdx.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
    }

    const glowGeo = this.trackGeometry(new THREE.BufferGeometry());
    glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(glowPos, 3));
    glowGeo.setAttribute('uv', new THREE.Float32BufferAttribute(glowUv, 2));
    glowGeo.setIndex(glowIdx);

    const glowMat = this.trackMaterial(
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uColor: { value: new THREE.Color(0xff1e2e) },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          varying vec2 vUv;
          void main() {
            float d = abs(vUv.x - 0.5) * 2.0;
            float falloff = exp(-d * d * 4.8);
            gl_FragColor = vec4(uColor, falloff * 0.34);
          }
        `,
      })
    );

    const glowMesh = new THREE.Mesh(glowGeo, glowMat);
    glowMesh.name = 'RampRedEdgeGlow';
    this.group.add(glowMesh);
  }

  /**
   * Extrudes a closed rectangular cross-section along `samples` defined by
   * transverse offsets `[sMin, sMax]` along `side` and normal offsets `[nMin, nMax]` along `normal`.
   */
  private extrudeProfileRect(
    samples: RampSample[],
    sA: number,
    sB: number,
    nMin: number,
    nMax: number
  ): THREE.BufferGeometry {
    const sMin = Math.min(sA, sB);
    const sMax = Math.max(sA, sB);
    const n = samples.length;

    const positions: number[] = [];
    const indices: number[] = [];

    // 4 corners per ring: 0=(sMin,nMax), 1=(sMax,nMax), 2=(sMax,nMin), 3=(sMin,nMin)
    for (let i = 0; i < n; i++) {
      const smp = samples[i];
      const [px, py, pz] = smp.position;
      const [nx, ny, nz] = smp.normal;
      const [sx, sy, sz] = smp.side;

      const corners: Array<[number, number]> = [
        [sMin, nMax],
        [sMax, nMax],
        [sMax, nMin],
        [sMin, nMin],
      ];

      for (const [so, no] of corners) {
        positions.push(
          px + sx * so + nx * no,
          py + sy * so + ny * no,
          pz + sz * so + nz * no
        );
      }
    }

    for (let i = 0; i < n - 1; i++) {
      const r0 = i * 4;
      const r1 = (i + 1) * 4;
      // Top (+N): 0 -> 1 -> 1' -> 0'
      indices.push(r0 + 0, r0 + 1, r1 + 1, r0 + 0, r1 + 1, r1 + 0);
      // +S face: 1 -> 2 -> 2' -> 1'
      indices.push(r0 + 1, r0 + 2, r1 + 2, r0 + 1, r1 + 2, r1 + 1);
      // Bottom (-N): 2 -> 3 -> 3' -> 2'
      indices.push(r0 + 2, r0 + 3, r1 + 3, r0 + 2, r1 + 3, r1 + 2);
      // -S face: 3 -> 0 -> 0' -> 3'
      indices.push(r0 + 3, r0 + 0, r1 + 0, r0 + 3, r1 + 0, r1 + 3);
    }

    // Start cap & end cap
    indices.push(0, 3, 2, 0, 2, 1);
    const last = (n - 1) * 4;
    indices.push(last + 0, last + 1, last + 2, last + 0, last + 2, last + 3);

    const geo = this.trackGeometry(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  private buildSteelLatticeTrussTower(samples: RampSample[], cfg: RampConfig): void {
    const primaryStruts: StrutSpec[] = [];
    const bracingStruts: StrutSpec[] = [];

    // Compute exact geometric bounds from RampSample[] back-face points
    const backPoints: THREE.Vector3[] = samples.map((s) =>
      new THREE.Vector3(...s.position).addScaledVector(
        new THREE.Vector3(...s.normal),
        -SLAB_THICKNESS
      )
    );

    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxXIndex = 0;
    for (let i = 0; i < backPoints.length; i++) {
      if (backPoints[i].x > maxX) {
        maxX = backPoints[i].x;
        maxXIndex = i;
      }
      if (backPoints[i].y > maxY) {
        maxY = backPoints[i].y;
      }
    }

    const baseZ = cfg.baseZ;
    const trussHalfZ = cfg.width * 0.5 - 0.28; // Aligns cleanly beneath the concrete deck edges
    const zPlanes = [baseZ - trussHalfZ, baseZ + trussHalfZ];

    // Main vertical tower column X stations (x ≈ 24..27.3 for default 14 + 11 radius ramp)
    const colFrontX = maxX - 1.05; // Forward belly/pier columns (≈ 24.4)
    const colSpineX = maxX + 0.35; // Full-height spine column directly behind vertical curve (≈ 25.8)
    const colRearX = maxX + 2.15; // Full-height rear counterweight column (≈ 27.6)

    // Top chord height above the inverted arch crest
    const towerTopY = maxY + 2.55;
    const bayCount = 7;
    const bayYs: number[] = [];
    for (let b = 0; b <= bayCount; b++) {
      bayYs.push((b / bayCount) * towerTopY);
    }

    // 1. Main full-height vertical steel tower columns (spine + rear on both ±Z planes)
    for (const z of zPlanes) {
      primaryStruts.push({
        a: new THREE.Vector3(colSpineX, 0.35, z),
        b: new THREE.Vector3(colSpineX, towerTopY, z),
        thickness: 0.34,
      });
      primaryStruts.push({
        a: new THREE.Vector3(colRearX, 0.35, z),
        b: new THREE.Vector3(colRearX, towerTopY, z),
        thickness: 0.34,
      });

      // Bay horizontal longitudinal girders & X-bracing in X-Y plane
      for (let b = 0; b < bayCount; b++) {
        const y0 = bayYs[b];
        const y1 = bayYs[b + 1];

        // Horizontal girder at top of bay
        primaryStruts.push({
          a: new THREE.Vector3(colSpineX, y1, z),
          b: new THREE.Vector3(colRearX, y1, z),
          thickness: 0.22,
        });

        // Diagonal X-bracing inside each vertical tower bay
        bracingStruts.push({
          a: new THREE.Vector3(colSpineX, Math.max(0.45, y0), z),
          b: new THREE.Vector3(colRearX, y1, z),
          thickness: 0.13,
        });
        bracingStruts.push({
          a: new THREE.Vector3(colRearX, Math.max(0.45, y0), z),
          b: new THREE.Vector3(colSpineX, y1, z),
          thickness: 0.13,
        });
      }
    }

    // 2. Transverse horizontal cross-girders & rear-face Z-Y diagonal X-bracing between -Z and +Z
    const zMin = zPlanes[0];
    const zMax = zPlanes[1];
    for (let b = 0; b < bayCount; b++) {
      const y0 = Math.max(0.5, bayYs[b]);
      const y1 = bayYs[b + 1];

      // Horizontal transverse girders at both spine & rear columns
      primaryStruts.push({
        a: new THREE.Vector3(colSpineX, y1, zMin),
        b: new THREE.Vector3(colSpineX, y1, zMax),
        thickness: 0.22,
      });
      primaryStruts.push({
        a: new THREE.Vector3(colRearX, y1, zMin),
        b: new THREE.Vector3(colRearX, y1, zMax),
        thickness: 0.22,
      });

      // Diagonal X-bracing on the rear tower face (colRearX)
      bracingStruts.push({
        a: new THREE.Vector3(colRearX, y0, zMin),
        b: new THREE.Vector3(colRearX, y1, zMax),
        thickness: 0.13,
      });
      bracingStruts.push({
        a: new THREE.Vector3(colRearX, y0, zMax),
        b: new THREE.Vector3(colRearX, y1, zMin),
        thickness: 0.13,
      });

      // Diagonal X-bracing on the spine plane (colSpineX)
      bracingStruts.push({
        a: new THREE.Vector3(colSpineX, y0, zMin),
        b: new THREE.Vector3(colSpineX, y1, zMax),
        thickness: 0.11,
      });
      bracingStruts.push({
        a: new THREE.Vector3(colSpineX, y0, zMax),
        b: new THREE.Vector3(colSpineX, y1, zMin),
        thickness: 0.11,
      });
    }

    // 3. Lower curve support piers & cradle struts (anchoring lower belly to ground & spine)
    const lowerPierSamples: number[] = [];
    for (let i = 4; i <= maxXIndex; i += 4) {
      if (backPoints[i].y > 0.65) {
        lowerPierSamples.push(i);
      }
    }
    if (!lowerPierSamples.includes(maxXIndex)) {
      lowerPierSamples.push(maxXIndex);
    }

    const footingXs = new Set<number>([colSpineX, colRearX]);

    for (let k = 0; k < lowerPierSamples.length; k++) {
      const idx = lowerPierSamples[k];
      const bp = backPoints[idx];
      const isUnderBelly = bp.x <= colFrontX + 0.25 && bp.y < maxY * 0.45;

      // Tie back-face cradle nodes directly to the spine column
      for (const z of zPlanes) {
        const node = new THREE.Vector3(bp.x, bp.y, z);
        // Horizontal tie to spine column
        primaryStruts.push({
          a: node,
          b: new THREE.Vector3(colSpineX, bp.y, z),
          thickness: 0.2,
        });

        // Vertical column straight down to concrete footing at Y=0 under the lower curve
        if (isUnderBelly && k % 2 === 1) {
          primaryStruts.push({
            a: new THREE.Vector3(bp.x, 0.35, z),
            b: node,
            thickness: 0.26,
          });
          footingXs.add(bp.x);

          // Diagonal brace from base of vertical pier back to spine column
          bracingStruts.push({
            a: new THREE.Vector3(bp.x, 0.45, z),
            b: new THREE.Vector3(colSpineX, bp.y, z),
            thickness: 0.14,
          });
          bracingStruts.push({
            a: node,
            b: new THREE.Vector3(colSpineX, Math.max(0.45, bp.y - 3.2), z),
            thickness: 0.14,
          });
        } else {
          // Raker diagonal strut down to spine column
          bracingStruts.push({
            a: node,
            b: new THREE.Vector3(colSpineX, Math.max(0.5, bp.y - 3.6), z),
            thickness: 0.15,
          });
        }
      }

      // Transverse beam under the concrete deck connecting -Z and +Z cradle points
      primaryStruts.push({
        a: new THREE.Vector3(bp.x, bp.y, zMin),
        b: new THREE.Vector3(bp.x, bp.y, zMax),
        thickness: 0.2,
      });
    }

    // Add explicit vertical front support column at x ≈ colFrontX (≈ 24.4) from ground up to lower curve back
    const frontSampleIdx = this.findClosestSampleByX(backPoints, 0, maxXIndex, colFrontX);
    if (frontSampleIdx > 0 && backPoints[frontSampleIdx].y > 1.0) {
      const fp = backPoints[frontSampleIdx];
      footingXs.add(fp.x);
      for (const z of zPlanes) {
        primaryStruts.push({
          a: new THREE.Vector3(fp.x, 0.35, z),
          b: new THREE.Vector3(fp.x, fp.y, z),
          thickness: 0.28,
        });
        bracingStruts.push({
          a: new THREE.Vector3(fp.x, 0.5, z),
          b: new THREE.Vector3(colSpineX, fp.y, z),
          thickness: 0.14,
        });
        bracingStruts.push({
          a: new THREE.Vector3(fp.x, fp.y, z),
          b: new THREE.Vector3(colSpineX, 0.5, z),
          thickness: 0.14,
        });
      }
      // Transverse X-brace under the front pier bay
      bracingStruts.push({
        a: new THREE.Vector3(fp.x, 0.5, zMin),
        b: new THREE.Vector3(fp.x, fp.y, zMax),
        thickness: 0.12,
      });
      bracingStruts.push({
        a: new THREE.Vector3(fp.x, 0.5, zMax),
        b: new THREE.Vector3(fp.x, fp.y, zMin),
        thickness: 0.12,
      });
    }

    // 4. Upper shoulder & cantilevered inverted launch deck overhead Warren/Pratt truss!
    // Collect evenly spaced nodes along the upper curve & overhang (from maxXIndex to the launch lip)
    const upperNodes: THREE.Vector3[] = [];
    const upperStep = Math.max(2, Math.floor((samples.length - 1 - maxXIndex) / 10));
    for (let i = maxXIndex; i < samples.length; i += upperStep) {
      upperNodes.push(backPoints[i]);
    }
    const lipBack = backPoints[samples.length - 1];
    if (upperNodes[upperNodes.length - 1].distanceTo(lipBack) > 0.4) {
      upperNodes.push(lipBack);
    }

    // Separate shoulder nodes (curving up from belly to crest) vs overhang deck nodes (past crest)
    let crestIdx = 0;
    for (let i = 0; i < upperNodes.length; i++) {
      if (upperNodes[i].y > upperNodes[crestIdx].y) {
        crestIdx = i;
      }
    }

    // Tie shoulder nodes back to the vertical tower spine column
    for (let i = 1; i <= crestIdx; i++) {
      const bp = upperNodes[i];
      for (const z of zPlanes) {
        const node = new THREE.Vector3(bp.x, bp.y, z);
        primaryStruts.push({
          a: node,
          b: new THREE.Vector3(colSpineX, Math.min(towerTopY, bp.y), z),
          thickness: 0.21,
        });
        bracingStruts.push({
          a: node,
          b: new THREE.Vector3(colSpineX, Math.max(bayYs[2], bp.y - 3.5), z),
          thickness: 0.15,
        });
      }
      primaryStruts.push({
        a: new THREE.Vector3(bp.x, bp.y, zMin),
        b: new THREE.Vector3(bp.x, bp.y, zMax),
        thickness: 0.2,
      });
    }

    // Overhead cantilevered tension truss along the top of the inverted deck out to the launch lip
    const overhangLower: THREE.Vector3[] = [];
    const overhangUpper: THREE.Vector3[] = [];

    // Anchor node at top of spine column
    overhangLower.push(new THREE.Vector3(colSpineX, maxY, 0));
    overhangUpper.push(new THREE.Vector3(colSpineX, towerTopY, 0));

    const deckSpanX = Math.max(1.0, colSpineX - lipBack.x);
    for (let i = crestIdx; i < upperNodes.length; i++) {
      const bp = upperNodes[i];
      const frac = THREE.MathUtils.clamp((colSpineX - bp.x) / deckSpanX, 0, 1);
      // Taper depth gracefully from ~2.55m at the main tower down to ~0.72m at the cantilevered lip
      const trussDepth = THREE.MathUtils.lerp(2.55, 0.72, Math.pow(frac, 0.85));
      overhangLower.push(new THREE.Vector3(bp.x, bp.y, 0));
      overhangUpper.push(new THREE.Vector3(bp.x, bp.y + trussDepth, 0));
    }

    // Connect overhead truss top chord back to the rear counterweight column for full cantilever balance
    for (const z of zPlanes) {
      primaryStruts.push({
        a: new THREE.Vector3(colRearX, towerTopY, z),
        b: new THREE.Vector3(overhangUpper[0].x, overhangUpper[0].y, z),
        thickness: 0.28,
      });
      // Heavy diagonal tension backstay from rear column mid-upper down to lower spine
      primaryStruts.push({
        a: new THREE.Vector3(colRearX, towerTopY, z),
        b: new THREE.Vector3(colSpineX, maxY - 2.6, z),
        thickness: 0.22,
      });

      for (let i = 0; i < overhangLower.length; i++) {
        const lo = new THREE.Vector3(overhangLower[i].x, overhangLower[i].y, z);
        const hi = new THREE.Vector3(overhangUpper[i].x, overhangUpper[i].y, z);

        // Vertical web post
        primaryStruts.push({ a: lo, b: hi, thickness: 0.2 });

        if (i < overhangLower.length - 1) {
          const loNext = new THREE.Vector3(overhangLower[i + 1].x, overhangLower[i + 1].y, z);
          const hiNext = new THREE.Vector3(overhangUpper[i + 1].x, overhangUpper[i + 1].y, z);

          // Upper tension chord & lower compression chord
          primaryStruts.push({ a: hi, b: hiNext, thickness: 0.26 });
          primaryStruts.push({ a: lo, b: loNext, thickness: 0.22 });

          // Pratt/X diagonal web bracing inside the cantilevered overhead truss
          bracingStruts.push({ a: lo, b: hiNext, thickness: 0.14 });
          bracingStruts.push({ a: hi, b: loNext, thickness: 0.14 });
        }
      }
    }

    // Transverse top-chord cross-girders & roof wind X-bracing across the overhanging deck
    for (let i = 0; i < overhangUpper.length; i++) {
      const hi = overhangUpper[i];
      const lo = overhangLower[i];

      primaryStruts.push({
        a: new THREE.Vector3(hi.x, hi.y, zMin),
        b: new THREE.Vector3(hi.x, hi.y, zMax),
        thickness: 0.19,
      });
      primaryStruts.push({
        a: new THREE.Vector3(lo.x, lo.y, zMin),
        b: new THREE.Vector3(lo.x, lo.y, zMax),
        thickness: 0.2,
      });

      if (i < overhangUpper.length - 1) {
        const hiNext = overhangUpper[i + 1];
        bracingStruts.push({
          a: new THREE.Vector3(hi.x, hi.y, zMin),
          b: new THREE.Vector3(hiNext.x, hiNext.y, zMax),
          thickness: 0.11,
        });
        bracingStruts.push({
          a: new THREE.Vector3(hi.x, hi.y, zMax),
          b: new THREE.Vector3(hiNext.x, hiNext.y, zMin),
          thickness: 0.11,
        });
      }
    }

    // Build instanced meshes for primary steel girders and secondary bracing struts
    const primaryMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0x2a3140,
        roughness: 0.44,
        metalness: 0.74,
      })
    );
    const bracingMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0x202633,
        roughness: 0.5,
        metalness: 0.68,
      })
    );

    this.addInstancedStruts(primaryStruts, primaryMat, 'RampTrussPrimaryGirders');
    this.addInstancedStruts(bracingStruts, bracingMat, 'RampTrussDiagonalBracing');

    // 5. Heavy Concrete Footings & Steel Baseplates anchored at Y = 0
    this.buildConcreteFootings(Array.from(footingXs), zPlanes, samples[0].position[0], colRearX);

    // 6. Subtle red aviation obstruction beacons atop the rear corners of the steel truss tower
    const beaconGeo = this.trackGeometry(new THREE.SphereGeometry(0.18, 10, 8));
    const beaconMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0xff3b47,
        emissive: 0xff1a2b,
        emissiveIntensity: 3.2,
        roughness: 0.2,
      })
    );
    for (const z of zPlanes) {
      const beacon = new THREE.Mesh(beaconGeo, beaconMat);
      beacon.position.set(colRearX, towerTopY + 0.32, z);
      this.group.add(beacon);
    }
  }

  private buildConcreteFootings(
    footingXs: number[],
    zPlanes: number[],
    rampStartX: number,
    colRearX: number
  ): void {
    const footingMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0x454c5a,
        roughness: 0.88,
        metalness: 0.08,
      })
    );

    const basePlateMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0x1b202b,
        roughness: 0.48,
        metalness: 0.8,
      })
    );

    const plinthGeo = this.trackGeometry(new THREE.BoxGeometry(1.45, 0.42, 1.45));
    const plateGeo = this.trackGeometry(new THREE.BoxGeometry(0.88, 0.1, 0.88));

    for (const fx of footingXs) {
      for (const fz of zPlanes) {
        const plinth = new THREE.Mesh(plinthGeo, footingMat);
        plinth.position.set(fx, 0.21, fz);
        plinth.castShadow = true;
        plinth.receiveShadow = true;
        this.group.add(plinth);

        const plate = new THREE.Mesh(plateGeo, basePlateMat);
        plate.position.set(fx, 0.46, fz);
        this.group.add(plate);
      }
    }

    // Continuous concrete foundation mat tying the tower legs together at Y = 0
    const matStart = Math.min(rampStartX + 4.0, Math.min(...footingXs) - 1.0);
    const matEnd = colRearX + 1.4;
    const matLen = Math.max(2.0, matEnd - matStart);
    const matWidth = Math.abs(zPlanes[1] - zPlanes[0]) + 2.4;

    const slabMatGeo = this.trackGeometry(new THREE.BoxGeometry(matLen, 0.18, matWidth));
    const slabMatMesh = new THREE.Mesh(slabMatGeo, footingMat);
    slabMatMesh.position.set((matStart + matEnd) * 0.5, 0.09, (zPlanes[0] + zPlanes[1]) * 0.5);
    slabMatMesh.receiveShadow = true;
    this.group.add(slabMatMesh);
  }

  private addInstancedStruts(
    struts: StrutSpec[],
    material: THREE.Material,
    name: string
  ): void {
    if (struts.length === 0) return;

    const unitGeo = this.trackGeometry(new THREE.BoxGeometry(1, 1, 1));
    const inst = new THREE.InstancedMesh(unitGeo, material, struts.length);
    inst.name = name;
    inst.castShadow = true;
    inst.receiveShadow = true;

    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const mat4 = new THREE.Matrix4();

    for (let i = 0; i < struts.length; i++) {
      const s = struts[i];
      dir.subVectors(s.b, s.a);
      const len = dir.length();
      if (len < 1e-4) {
        scale.set(0, 0, 0);
        mat4.compose(s.a, quat.identity(), scale);
        inst.setMatrixAt(i, mat4);
        continue;
      }

      mid.addVectors(s.a, s.b).multiplyScalar(0.5);
      dir.multiplyScalar(1 / len);
      quat.setFromUnitVectors(up, dir);
      scale.set(s.thickness, len, s.thickness);
      mat4.compose(mid, quat, scale);
      inst.setMatrixAt(i, mat4);
    }

    inst.instanceMatrix.needsUpdate = true;
    this.instancedMeshes.push(inst);
    this.group.add(inst);
  }

  private findClosestSampleByX(
    points: THREE.Vector3[],
    startIdx: number,
    endIdx: number,
    targetX: number
  ): number {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = startIdx; i <= endIdx; i++) {
      const d = Math.abs(points[i].x - targetX);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  private createRoadwayTextures(): {
    roadColorTex: THREE.CanvasTexture;
    roadRoughTex: THREE.CanvasTexture;
  } {
    const w = 512;
    const h = 512;

    const colorCanvas = document.createElement('canvas');
    colorCanvas.width = w;
    colorCanvas.height = h;
    const cCtx = colorCanvas.getContext('2d');

    const roughCanvas = document.createElement('canvas');
    roughCanvas.width = w;
    roughCanvas.height = h;
    const rCtx = roughCanvas.getContext('2d');

    if (cCtx && rCtx) {
      // Weathered poured concrete roadway deck
      cCtx.fillStyle = '#4e5460';
      cCtx.fillRect(0, 0, w, h);

      rCtx.fillStyle = 'rgb(205, 205, 205)';
      rCtx.fillRect(0, 0, w, h);

      let seed = 73319;
      const rand = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };

      // Subtle concrete grain & trowel variation
      for (let i = 0; i < 6500; i++) {
        const x = rand() * w;
        const y = rand() * h;
        const v = Math.floor(62 + rand() * 34);
        cCtx.fillStyle = `rgba(${v}, ${v + 4}, ${v + 10}, 0.35)`;
        cCtx.fillRect(x, y, 2, 3);

        const rv = Math.floor(170 + rand() * 68);
        rCtx.fillStyle = `rgba(${rv}, ${rv}, ${rv}, 0.35)`;
        rCtx.fillRect(x, y, 2, 3);
      }

      // Poured concrete expansion panel joints across the ramp width
      cCtx.fillStyle = 'rgba(26, 30, 38, 0.55)';
      cCtx.fillRect(0, 0, w, 4);
      cCtx.fillRect(0, h * 0.5, w, 3);

      // Dark tire rubber wear lanes along left & right wheel tracks
      const tireGradL = cCtx.createLinearGradient(w * 0.26, 0, w * 0.42, 0);
      tireGradL.addColorStop(0, 'rgba(18, 20, 26, 0)');
      tireGradL.addColorStop(0.5, 'rgba(18, 20, 26, 0.34)');
      tireGradL.addColorStop(1, 'rgba(18, 20, 26, 0)');
      cCtx.fillStyle = tireGradL;
      cCtx.fillRect(w * 0.26, 0, w * 0.16, h);

      const tireGradR = cCtx.createLinearGradient(w * 0.58, 0, w * 0.74, 0);
      tireGradR.addColorStop(0, 'rgba(18, 20, 26, 0)');
      tireGradR.addColorStop(0.5, 'rgba(18, 20, 26, 0.34)');
      tireGradR.addColorStop(1, 'rgba(18, 20, 26, 0)');
      cCtx.fillStyle = tireGradR;
      cCtx.fillRect(w * 0.58, 0, w * 0.16, h);

      // Tire lanes slightly glossier in roughness map
      rCtx.fillStyle = 'rgba(145, 145, 145, 0.4)';
      rCtx.fillRect(w * 0.3, 0, w * 0.08, h);
      rCtx.fillRect(w * 0.62, 0, w * 0.08, h);

      // Crisp white continuous side shoulder stripes
      cCtx.fillStyle = 'rgba(232, 238, 248, 0.86)';
      cCtx.fillRect(w * 0.055, 0, w * 0.022, h);
      cCtx.fillRect(w * 0.923, 0, w * 0.022, h);

      // Crisp white dashed centerline markings
      cCtx.fillStyle = 'rgba(244, 248, 255, 0.92)';
      cCtx.fillRect(w * 0.486, h * 0.08, w * 0.028, h * 0.36);
      cCtx.fillRect(w * 0.486, h * 0.58, w * 0.028, h * 0.36);
    }

    const roadColorTex = this.trackTexture(new THREE.CanvasTexture(colorCanvas));
    roadColorTex.colorSpace = THREE.SRGBColorSpace;
    roadColorTex.wrapS = THREE.ClampToEdgeWrapping;
    roadColorTex.wrapT = THREE.RepeatWrapping;
    roadColorTex.anisotropy = 8;

    const roadRoughTex = this.trackTexture(new THREE.CanvasTexture(roughCanvas));
    roadRoughTex.wrapS = THREE.ClampToEdgeWrapping;
    roadRoughTex.wrapT = THREE.RepeatWrapping;
    roadRoughTex.anisotropy = 8;

    return { roadColorTex, roadRoughTex };
  }

  private createConcreteFormworkTexture(): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    if (ctx) {
      ctx.fillStyle = '#6d7482';
      ctx.fillRect(0, 0, size, size);

      let seed = 104729;
      const rand = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };

      for (let i = 0; i < 2400; i++) {
        const v = Math.floor(88 + rand() * 36);
        ctx.fillStyle = `rgba(${v}, ${v + 4}, ${v + 10}, 0.32)`;
        ctx.fillRect(rand() * size, rand() * size, 2, 2);
      }

      // Industrial formwork seam lines & tie holes
      ctx.strokeStyle = 'rgba(34, 38, 48, 0.45)';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, size - 2, size - 2);
      ctx.beginPath();
      ctx.moveTo(0, size * 0.5);
      ctx.lineTo(size, size * 0.5);
      ctx.stroke();

      ctx.fillStyle = 'rgba(30, 34, 42, 0.55)';
      for (const y of [size * 0.25, size * 0.75]) {
        for (const x of [size * 0.25, size * 0.75]) {
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    const tex = this.trackTexture(new THREE.CanvasTexture(canvas));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  }
}
