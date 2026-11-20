import * as THREE from 'three';
import { ARENA_CONFIG } from '../types';

interface BeaconEntry {
  material: THREE.MeshStandardMaterial;
  phase: number;
  speed: number;
  minIntensity: number;
  maxIntensity: number;
}

/**
 * SpaceX McGregor night stunt arena environment:
 * - Deep night sky dome, crisp twinkling starfield, exponential fog, balanced night lighting
 * - Toggleable multi-layered Aurora Borealis shader ribbon
 * - Wet semi-glossy dark asphalt tarmac (180m x 110m) with dashed approach & LZ-1 landing pad markings
 * - Signature Red Horizon Light Bar on the far left/back tarmac
 * - Signature Rear Stadium Floodlight with additive volumetric cone beams
 * - Distant SpaceX-style vertical test stand, cryo propellant farm, hangar & perimeter beacons
 */
export class ArenaEnvironment {
  public readonly group: THREE.Group;

  private readonly scene?: THREE.Scene;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];

  private readonly auroraGroup: THREE.Group;
  private readonly auroraUniforms: Array<{ uTime: { value: number } }> = [];
  private starUniforms: { uTime: { value: number } } | null = null;
  private floodBeamUniforms: Array<{ uTime: { value: number } }> = [];
  private floodCoronaMaterial: THREE.ShaderMaterial | null = null;
  private readonly beacons: BeaconEntry[] = [];

  private auroraEnabled = true;

  constructor(scene?: THREE.Scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'ArenaEnvironment';

    if (scene) {
      scene.background = new THREE.Color(0x05070e);
      scene.fog = new THREE.FogExp2(0x05070e, 0.0046);
    }

    this.auroraGroup = new THREE.Group();
    this.auroraGroup.name = 'AuroraBorealis';
    this.group.add(this.auroraGroup);

    this.buildSkyDome();
    this.buildStarfield();
    this.buildAurora();
    this.buildLighting();
    this.buildTarmac();
    this.buildRedHorizonLightBar();
    this.buildRearFloodlight();
    this.buildBackgroundStructures();
    this.buildPerimeterBeacons();
  }

  public setAuroraEnabled(enabled: boolean): void {
    this.auroraEnabled = enabled;
    this.auroraGroup.visible = enabled;
  }

  public update(timeSec: number): void {
    if (this.starUniforms) {
      this.starUniforms.uTime.value = timeSec;
    }

    if (this.auroraEnabled) {
      for (const uniforms of this.auroraUniforms) {
        uniforms.uTime.value = timeSec;
      }
    }

    for (const uniforms of this.floodBeamUniforms) {
      uniforms.uTime.value = timeSec;
    }

    if (this.floodCoronaMaterial) {
      this.floodCoronaMaterial.uniforms.uTime.value = timeSec;
    }

    for (const beacon of this.beacons) {
      const pulse = 0.5 + 0.5 * Math.sin(timeSec * beacon.speed + beacon.phase);
      const sharp = Math.pow(pulse, 2.4);
      beacon.material.emissiveIntensity =
        beacon.minIntensity + sharp * (beacon.maxIntensity - beacon.minIntensity);
    }
  }

  public dispose(): void {
    this.group.traverse((obj) => {
      const maybeDisposable = obj as unknown as { dispose?: () => void };
      if (obj !== this.group && typeof maybeDisposable.dispose === 'function') {
        maybeDisposable.dispose();
      }
    });
    for (const geo of this.geometries) {
      geo.dispose();
    }
    for (const mat of this.materials) {
      mat.dispose();
    }
    for (const tex of this.textures) {
      tex.dispose();
    }
    this.geometries.length = 0;
    this.materials.length = 0;
    this.textures.length = 0;
    this.auroraUniforms.length = 0;
    this.floodBeamUniforms.length = 0;
    this.beacons.length = 0;
    if (this.scene) {
      this.scene.background = null;
      this.scene.fog = null;
    }
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

  private buildSkyDome(): void {
    const skyGeo = this.trackGeometry(new THREE.SphereGeometry(260, 32, 20));
    const skyMat = this.trackMaterial(
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uZenithColor: { value: new THREE.Color(0x03050c) },
          uHorizonColor: { value: new THREE.Color(0x0a1020) },
          uRedGlowColor: { value: new THREE.Color(0x3a0710) },
          uFloodHazeColor: { value: new THREE.Color(0x162238) },
        },
        vertexShader: /* glsl */ `
          varying vec3 vWorldDir;
          void main() {
            vec4 worldPos = modelMatrix * vec4(position, 1.0);
            vWorldDir = normalize(worldPos.xyz);
            gl_Position = projectionMatrix * viewMatrix * worldPos;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uZenithColor;
          uniform vec3 uHorizonColor;
          uniform vec3 uRedGlowColor;
          uniform vec3 uFloodHazeColor;
          varying vec3 vWorldDir;

          void main() {
            float elev = clamp(vWorldDir.y, 0.0, 1.0);
            float horizonMix = pow(1.0 - elev, 3.2);
            vec3 col = mix(uZenithColor, uHorizonColor, horizonMix);

            // Subtle atmospheric crimson bounce on the left-back horizon (-X, -Z)
            float leftBand = smoothstep(0.15, -0.75, vWorldDir.x) * smoothstep(0.35, -0.55, vWorldDir.z);
            float lowElev = exp(-elev * 9.5);
            col += uRedGlowColor * leftBand * lowElev * 0.85;

            // Subtle cool scatter behind the rear stadium floodlight (-Z)
            float rearGlow = smoothstep(0.45, -0.95, vWorldDir.z) * (1.0 - abs(vWorldDir.x) * 0.9);
            col += uFloodHazeColor * max(rearGlow, 0.0) * exp(-elev * 6.5) * 0.55;

            gl_FragColor = vec4(col, 1.0);
          }
        `,
      })
    );
    const skyMesh = new THREE.Mesh(skyGeo, skyMat);
    skyMesh.name = 'NightSkyDome';
    skyMesh.renderOrder = -10;
    this.group.add(skyMesh);
  }

  private buildStarfield(): void {
    const count = 1500;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);

    // Deterministic LCG so the night sky is crisp and consistent
    let seed = 42197;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    const starPalette = [
      new THREE.Color(0xffffff),
      new THREE.Color(0xd8e8ff),
      new THREE.Color(0xbad4ff),
      new THREE.Color(0xfff1dc),
    ];

    for (let i = 0; i < count; i++) {
      const theta = rand() * Math.PI * 2;
      // Bias slightly toward mid-to-upper sky, keeping stars above horizon
      const u = 0.06 + Math.pow(rand(), 0.72) * 0.94;
      const phi = Math.acos(u);
      const radius = 185 + rand() * 50;

      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi);
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);

      const c = starPalette[Math.floor(rand() * starPalette.length)];
      const brightness = 0.45 + Math.pow(rand(), 1.8) * 0.55;
      colors[i * 3] = c.r * brightness;
      colors[i * 3 + 1] = c.g * brightness;
      colors[i * 3 + 2] = c.b * brightness;

      sizes[i] = 1.2 + Math.pow(rand(), 3.0) * 3.1;
      phases[i] = rand() * Math.PI * 2;
    }

    const starGeo = this.trackGeometry(new THREE.BufferGeometry());
    starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starGeo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    starGeo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

    this.starUniforms = { uTime: { value: 0 } };

    const starMat = this.trackMaterial(
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
        uniforms: this.starUniforms,
        vertexShader: /* glsl */ `
          attribute vec3 aColor;
          attribute float aSize;
          attribute float aPhase;
          uniform float uTime;
          varying vec3 vColor;
          varying float vAlpha;

          void main() {
            vColor = aColor;
            float twinkle = 0.78 + 0.22 * sin(uTime * (1.2 + mod(aPhase, 1.5)) + aPhase * 3.0);
            vAlpha = twinkle;
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = aSize * (220.0 / max(-mvPosition.z, 1.0));
            gl_PointSize = clamp(gl_PointSize, 1.0, 5.5);
            gl_Position = projectionMatrix * mvPosition;
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec3 vColor;
          varying float vAlpha;

          void main() {
            vec2 p = gl_PointCoord - vec2(0.5);
            float d = length(p) * 2.0;
            if (d > 1.0) discard;
            float core = exp(-d * d * 5.2);
            gl_FragColor = vec4(vColor, core * vAlpha);
          }
        `,
      })
    );

    const stars = new THREE.Points(starGeo, starMat);
    stars.name = 'NightStarfield';
    stars.frustumCulled = false;
    this.group.add(stars);
  }

  private buildAurora(): void {
    const layers = [
      {
        zBase: -102,
        yBase: 46,
        height: 30,
        spanX: 190,
        curveDepth: 22,
        speed: 0.22,
        phase: 0.0,
        opacity: 0.34,
        colorLow: new THREE.Color(0x16f0a2),
        colorMid: new THREE.Color(0x18b4dc),
        colorHigh: new THREE.Color(0x7c3cf4),
      },
      {
        zBase: -118,
        yBase: 55,
        height: 36,
        spanX: 215,
        curveDepth: -18,
        speed: 0.16,
        phase: 2.3,
        opacity: 0.24,
        colorLow: new THREE.Color(0x19d89c),
        colorMid: new THREE.Color(0x3a7cf2),
        colorHigh: new THREE.Color(0xb838c8),
      },
    ];

    for (let idx = 0; idx < layers.length; idx++) {
      const layer = layers[idx];
      const segX = 96;
      const segY = 12;
      const geo = this.trackGeometry(new THREE.PlaneGeometry(layer.spanX, layer.height, segX, segY));
      const posAttr = geo.attributes.position as THREE.BufferAttribute;

      // Gently drape the aurora ribbon in a wide arc across the northern night sky
      for (let i = 0; i < posAttr.count; i++) {
        const x = posAttr.getX(i);
        const y = posAttr.getY(i);
        const nx = x / (layer.spanX * 0.5); // -1..1
        const archY = Math.cos(nx * Math.PI * 0.5) * 6.5;
        const waveZ =
          Math.sin(nx * Math.PI * 1.4 + layer.phase) * layer.curveDepth +
          nx * nx * 24.0;
        posAttr.setXYZ(i, x, y + layer.yBase + archY, layer.zBase + waveZ);
      }
      posAttr.needsUpdate = true;

      const timeUniform = { value: 0 };
      this.auroraUniforms.push({ uTime: timeUniform });

      const mat = this.trackMaterial(
        new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          fog: false,
          uniforms: {
            uTime: timeUniform,
            uSpeed: { value: layer.speed },
            uPhase: { value: layer.phase },
            uOpacity: { value: layer.opacity },
            uColorLow: { value: layer.colorLow },
            uColorMid: { value: layer.colorMid },
            uColorHigh: { value: layer.colorHigh },
          },
          vertexShader: /* glsl */ `
            uniform float uTime;
            uniform float uSpeed;
            uniform float uPhase;
            varying vec2 vUv;

            void main() {
              vUv = uv;
              vec3 pos = position;
              float sway = sin(uv.x * 7.5 + uTime * uSpeed + uPhase) * 3.8
                         + cos(uv.x * 13.0 - uTime * uSpeed * 0.7 + uPhase) * 1.8;
              pos.z += sway * (0.4 + uv.y * 0.6);
              pos.y += sin(uv.x * 5.0 - uTime * uSpeed * 0.55 + uPhase) * 1.6;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
            }
          `,
          fragmentShader: /* glsl */ `
            uniform float uTime;
            uniform float uSpeed;
            uniform float uPhase;
            uniform float uOpacity;
            uniform vec3 uColorLow;
            uniform vec3 uColorMid;
            uniform vec3 uColorHigh;
            varying vec2 vUv;

            void main() {
              float t = uTime * uSpeed;
              // Vertical curtain folds
              float fold1 = 0.5 + 0.5 * sin(vUv.x * 22.0 + t * 1.6 + uPhase + sin(vUv.x * 7.0 - t) * 1.8);
              float fold2 = 0.5 + 0.5 * sin(vUv.x * 41.0 - t * 2.1 + uPhase * 1.7);
              float streaks = pow(fold1, 1.7) * 0.65 + pow(fold2, 2.4) * 0.35;

              // Crisp bright lower aurora edge fading softly upward
              float bottomEdge = smoothstep(0.0, 0.22, vUv.y);
              float topFade = pow(1.0 - vUv.y, 1.65);
              float vertMask = bottomEdge * topFade;

              // Smooth horizontal edge taper
              float horizMask = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);

              vec3 col = mix(uColorLow, uColorMid, smoothstep(0.08, 0.52, vUv.y));
              col = mix(col, uColorHigh, smoothstep(0.45, 0.92, vUv.y));

              float alpha = streaks * vertMask * horizMask * uOpacity;
              gl_FragColor = vec4(col, alpha);
            }
          `,
        })
      );

      const ribbon = new THREE.Mesh(geo, mat);
      ribbon.name = `AuroraRibbon_${idx}`;
      ribbon.frustumCulled = false;
      this.auroraGroup.add(ribbon);
    }
  }

  private buildLighting(): void {
    // Soft night sky & wet tarmac ambient bounce
    const hemi = new THREE.HemisphereLight(0x365088, 0x161220, 0.72);
    this.group.add(hemi);

    // Primary crisp moonlight casting shadows across the C-ramp & tarmac
    const moon = new THREE.DirectionalLight(0xc2daff, 1.38);
    moon.position.set(-24, 52, 44);
    moon.target.position.set(2, 6, 0);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    moon.shadow.camera.near = 6;
    moon.shadow.camera.far = 140;
    moon.shadow.camera.left = -48;
    moon.shadow.camera.right = 48;
    moon.shadow.camera.top = 38;
    moon.shadow.camera.bottom = -22;
    moon.shadow.bias = -0.00045;
    moon.shadow.normalBias = 0.03;
    this.group.add(moon);
    this.group.add(moon.target);

    // Front-right rim/under-deck fill so the white voxel Roadster pops even while inverted at y=22
    const rimFill = new THREE.DirectionalLight(0x8fb8ff, 0.85);
    rimFill.position.set(18, 6, 38);
    rimFill.target.position.set(10, 16, 0);
    this.group.add(rimFill);
    this.group.add(rimFill.target);

    // Subtle upward bounce fill beneath the inverted launch lip
    const underDeckLight = new THREE.PointLight(0x7aa4e8, 34, 42, 1.5);
    underDeckLight.position.set(13, 10, 12);
    this.group.add(underDeckLight);

    // Subtle crimson spill along the C-ramp inner arc from its red LED safety rails
    const rampRedAccent = new THREE.PointLight(0xff1e2e, 18, 26, 1.7);
    rampRedAccent.position.set(18, 17, 4.5);
    this.group.add(rampRedAccent);
  }

  private buildTarmac(): void {
    const widthX = ARENA_CONFIG.tarmacHalfExtentX * 2; // 180m
    const depthZ = ARENA_CONFIG.tarmacHalfExtentZ * 2; // 110m

    const { colorTex, roughTex } = this.createTarmacTextures(widthX, depthZ);

    const tarmacGeo = this.trackGeometry(new THREE.PlaneGeometry(widthX, depthZ, 1, 1));
    tarmacGeo.rotateX(-Math.PI / 2);

    const tarmacMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        map: colorTex,
        roughnessMap: roughTex,
        bumpMap: roughTex,
        bumpScale: 0.025,
        roughness: 1.0,
        metalness: 0.16,
      })
    );

    const tarmacMesh = new THREE.Mesh(tarmacGeo, tarmacMat);
    tarmacMesh.name = 'WetAsphaltTarmac';
    tarmacMesh.position.set(0, 0, 0);
    tarmacMesh.receiveShadow = true;
    this.group.add(tarmacMesh);

    // Flush approach edge marker lights along x = -12..+12 at z = ±3.65m
    const markerGeo = this.trackGeometry(new THREE.BoxGeometry(0.28, 0.04, 0.12));
    const markerMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0xffd7a8,
        emissive: 0xffa84c,
        emissiveIntensity: 1.6,
        roughness: 0.3,
      })
    );
    for (let x = -12; x <= 12; x += 4) {
      for (const sideZ of [-3.65, 3.65]) {
        const marker = new THREE.Mesh(markerGeo, markerMat);
        marker.position.set(x, 0.02, sideZ);
        this.group.add(marker);
      }
    }

    // Landing pad perimeter marker pods around ARENA_CONFIG.landingPadX
    const padPodGeo = this.trackGeometry(new THREE.CylinderGeometry(0.14, 0.18, 0.1, 10));
    const padRingR = ARENA_CONFIG.landingPadRadius + 0.35;
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const podMat = this.trackMaterial(
        new THREE.MeshStandardMaterial({
          color: 0xff3b47,
          emissive: 0xff1a2b,
          emissiveIntensity: 2.0,
          roughness: 0.25,
        })
      );
      const pod = new THREE.Mesh(padPodGeo, podMat);
      pod.position.set(
        ARENA_CONFIG.landingPadX + Math.cos(ang) * padRingR,
        0.05,
        Math.sin(ang) * padRingR
      );
      this.group.add(pod);
      this.beacons.push({
        material: podMat,
        phase: i * 0.75,
        speed: 2.2,
        minIntensity: 0.9,
        maxIntensity: 2.6,
      });
    }
  }

  private createTarmacTextures(
    widthX: number,
    depthZ: number
  ): { colorTex: THREE.CanvasTexture; roughTex: THREE.CanvasTexture } {
    const canvasW = 2048;
    const canvasH = 1024;

    const colorCanvas = document.createElement('canvas');
    colorCanvas.width = canvasW;
    colorCanvas.height = canvasH;
    const cCtx = colorCanvas.getContext('2d');

    const roughCanvas = document.createElement('canvas');
    roughCanvas.width = canvasW;
    roughCanvas.height = canvasH;
    const rCtx = roughCanvas.getContext('2d');

    if (cCtx && rCtx) {
      // Base dark wet night asphalt
      cCtx.fillStyle = '#10141c';
      cCtx.fillRect(0, 0, canvasW, canvasH);

      // Base roughness ~0.58 (148/255)
      rCtx.fillStyle = 'rgb(148, 148, 148)';
      rCtx.fillRect(0, 0, canvasW, canvasH);

      // Deterministic PRNG for asphalt grain & damp puddles
      let seed = 918273;
      const rand = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };

      // Large organic wet sheen puddles (low roughness 35..75 -> glossy reflection!)
      for (let i = 0; i < 110; i++) {
        const px = rand() * canvasW;
        const py = rand() * canvasH;
        const rx = 40 + rand() * 170;
        const ry = 22 + rand() * 95;
        const rot = rand() * Math.PI;

        // Slightly darker wet patch in albedo
        cCtx.save();
        cCtx.translate(px, py);
        cCtx.rotate(rot);
        const cGrad = cCtx.createRadialGradient(0, 0, 2, 0, 0, rx);
        cGrad.addColorStop(0, 'rgba(6, 8, 13, 0.42)');
        cGrad.addColorStop(0.65, 'rgba(9, 12, 18, 0.22)');
        cGrad.addColorStop(1, 'rgba(16, 20, 28, 0.0)');
        cCtx.fillStyle = cGrad;
        cCtx.scale(1, ry / rx);
        cCtx.beginPath();
        cCtx.arc(0, 0, rx, 0, Math.PI * 2);
        cCtx.fill();
        cCtx.restore();

        // Low roughness wet reflection zone
        rCtx.save();
        rCtx.translate(px, py);
        rCtx.rotate(rot);
        const rGrad = rCtx.createRadialGradient(0, 0, 2, 0, 0, rx);
        const wetVal = Math.floor(32 + rand() * 38);
        rGrad.addColorStop(0, `rgba(${wetVal}, ${wetVal}, ${wetVal}, 0.85)`);
        rGrad.addColorStop(0.6, `rgba(${wetVal + 24}, ${wetVal + 24}, ${wetVal + 24}, 0.5)`);
        rGrad.addColorStop(1, 'rgba(148, 148, 148, 0.0)');
        rCtx.fillStyle = rGrad;
        rCtx.scale(1, ry / rx);
        rCtx.beginPath();
        rCtx.arc(0, 0, rx, 0, Math.PI * 2);
        rCtx.fill();
        rCtx.restore();
      }

      // Extra glossy wet reflection corridor right through the center stunt tarmac
      const wetLaneGrad = rCtx.createLinearGradient(0, canvasH * 0.34, 0, canvasH * 0.66);
      wetLaneGrad.addColorStop(0, 'rgba(148, 148, 148, 0.0)');
      wetLaneGrad.addColorStop(0.5, 'rgba(54, 54, 54, 0.55)');
      wetLaneGrad.addColorStop(1, 'rgba(148, 148, 148, 0.0)');
      rCtx.fillStyle = wetLaneGrad;
      rCtx.fillRect(canvasW * 0.18, canvasH * 0.34, canvasW * 0.55, canvasH * 0.32);

      // Fine mineral aggregate speckle
      for (let i = 0; i < 16000; i++) {
        const x = rand() * canvasW;
        const y = rand() * canvasH;
        const v = Math.floor(14 + rand() * 24);
        cCtx.fillStyle = `rgba(${v}, ${v + 3}, ${v + 7}, 0.45)`;
        cCtx.fillRect(x, y, 2, 2);

        const rv = Math.floor(110 + rand() * 85);
        rCtx.fillStyle = `rgba(${rv}, ${rv}, ${rv}, 0.25)`;
        rCtx.fillRect(x, y, 2, 2);
      }

      // World (x, z) -> canvas (u, v) helpers:
      // PlaneGeometry rotated -PI/2 around X maps:
      //   worldX = (u - 0.5) * widthX
      //   worldZ = (v - 0.5) * depthZ  (canvas top y=0 corresponds to -depthZ/2)
      const wx = (x: number): number => ((x + widthX * 0.5) / widthX) * canvasW;
      const wz = (z: number): number => ((z + depthZ * 0.5) / depthZ) * canvasH;
      const sx = (meters: number): number => (meters / widthX) * canvasW;
      const sz = (meters: number): number => (meters / depthZ) * canvasH;

      // Subtle concrete expansion grid lines across the test pad
      cCtx.strokeStyle = 'rgba(28, 34, 46, 0.55)';
      cCtx.lineWidth = 1.5;
      for (let x = -80; x <= 80; x += 10) {
        cCtx.beginPath();
        cCtx.moveTo(wx(x), 0);
        cCtx.lineTo(wx(x), canvasH);
        cCtx.stroke();
      }
      for (let z = -50; z <= 50; z += 10) {
        cCtx.beginPath();
        cCtx.moveTo(0, wz(z));
        cCtx.lineTo(canvasW, wz(z));
        cCtx.stroke();
      }

      // Subtle dark tire rubber tracks along approach
      cCtx.fillStyle = 'rgba(5, 6, 10, 0.38)';
      const trackStart = wx(-26);
      const trackLen = sx(40);
      cCtx.fillRect(trackStart, wz(-0.92) - sz(0.24), trackLen, sz(0.48));
      cCtx.fillRect(trackStart, wz(0.92) - sz(0.24), trackLen, sz(0.48));

      // Runway approach lane side boundary lines (z = ±3.2m, matching ramp width 6.4m)
      cCtx.strokeStyle = 'rgba(185, 198, 220, 0.42)';
      cCtx.lineWidth = Math.max(2, sz(0.14));
      for (const edgeZ of [-3.2, 3.2]) {
        cCtx.beginPath();
        cCtx.moveTo(wx(-34), wz(edgeZ));
        cCtx.lineTo(wx(ARENA_CONFIG.ramp.baseX), wz(edgeZ));
        cCtx.stroke();
      }

      // Crisp painted dashed runway approach centerline (x = -12 -> +14, plus fainter lead-in)
      cCtx.fillStyle = 'rgba(218, 228, 244, 0.28)';
      for (let x = -30; x < ARENA_CONFIG.ramp.approachStartX; x += 3.2) {
        cCtx.fillRect(wx(x), wz(0) - sz(0.08), sx(1.6), sz(0.16));
      }

      cCtx.fillStyle = 'rgba(235, 242, 255, 0.78)';
      for (let x = ARENA_CONFIG.ramp.approachStartX; x < ARENA_CONFIG.ramp.baseX - 0.8; x += 2.6) {
        const dashLen = Math.min(1.45, ARENA_CONFIG.ramp.baseX - 0.4 - x);
        if (dashLen > 0.2) {
          cCtx.fillRect(wx(x), wz(0) - sz(0.1), sx(dashLen), sz(0.2));
        }
      }

      // Runway entry threshold chevron bars right before C-ramp base (x ≈ 12.6)
      cCtx.fillStyle = 'rgba(230, 238, 250, 0.52)';
      for (let oz = -2.6; oz <= 2.6; oz += 0.86) {
        cCtx.fillRect(wx(12.4), wz(oz) - sz(0.14), sx(1.1), sz(0.28));
      }

      // Subtle spawn start box at ARENA_CONFIG.spawnPosition[0] (-10)
      cCtx.strokeStyle = 'rgba(235, 242, 255, 0.45)';
      cCtx.lineWidth = 2;
      cCtx.strokeRect(
        wx(ARENA_CONFIG.spawnPosition[0] - 2.6),
        wz(-1.45),
        sx(5.2),
        sz(2.9)
      );

      // SpaceX-style Landing Zone Pad around ARENA_CONFIG.landingPadX (x = -20, r = 7.5m)
      const padCx = wx(ARENA_CONFIG.landingPadX);
      const padCz = wz(0);
      const padRx = sx(ARENA_CONFIG.landingPadRadius);
      const padRz = sz(ARENA_CONFIG.landingPadRadius);

      // Subtle scorched/weathered landing concrete circle
      cCtx.save();
      cCtx.translate(padCx, padCz);
      cCtx.scale(1, padRz / padRx);

      const padFill = cCtx.createRadialGradient(0, 0, padRx * 0.1, 0, 0, padRx);
      padFill.addColorStop(0, 'rgba(32, 36, 46, 0.45)');
      padFill.addColorStop(0.75, 'rgba(22, 26, 36, 0.28)');
      padFill.addColorStop(1, 'rgba(16, 20, 28, 0.0)');
      cCtx.fillStyle = padFill;
      cCtx.beginPath();
      cCtx.arc(0, 0, padRx, 0, Math.PI * 2);
      cCtx.fill();

      // Outer dashed landing circle
      cCtx.strokeStyle = 'rgba(218, 228, 242, 0.56)';
      cCtx.lineWidth = 3.2;
      cCtx.setLineDash([14, 10]);
      cCtx.beginPath();
      cCtx.arc(0, 0, padRx, 0, Math.PI * 2);
      cCtx.stroke();

      // Inner solid red-accent target ring
      cCtx.setLineDash([]);
      cCtx.strokeStyle = 'rgba(255, 58, 72, 0.42)';
      cCtx.lineWidth = 2.4;
      cCtx.beginPath();
      cCtx.arc(0, 0, padRx * 0.58, 0, Math.PI * 2);
      cCtx.stroke();

      // Center precision crosshair ticks
      cCtx.strokeStyle = 'rgba(220, 232, 248, 0.52)';
      cCtx.lineWidth = 2.2;
      const innerTick = padRx * 0.18;
      const outerTick = padRx * 0.48;
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2;
        cCtx.beginPath();
        cCtx.moveTo(Math.cos(a) * innerTick, Math.sin(a) * innerTick);
        cCtx.lineTo(Math.cos(a) * outerTick, Math.sin(a) * outerTick);
        cCtx.stroke();
      }

      // Stylized SpaceX-inspired "X" center mark
      cCtx.strokeStyle = 'rgba(225, 235, 250, 0.36)';
      cCtx.lineWidth = 3.0;
      const xSize = padRx * 0.24;
      cCtx.beginPath();
      cCtx.moveTo(-xSize, -xSize);
      cCtx.lineTo(xSize, xSize);
      cCtx.moveTo(xSize, -xSize);
      cCtx.lineTo(-xSize, xSize);
      cCtx.stroke();

      cCtx.restore();
    }

    const colorTex = this.trackTexture(new THREE.CanvasTexture(colorCanvas));
    colorTex.colorSpace = THREE.SRGBColorSpace;
    colorTex.anisotropy = 8;

    const roughTex = this.trackTexture(new THREE.CanvasTexture(roughCanvas));
    roughTex.anisotropy = 8;

    return { colorTex, roughTex };
  }

  private buildRedHorizonLightBar(): void {
    const barGroup = new THREE.Group();
    barGroup.name = 'RedHorizonLightBar';

    const housingMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0x161922,
        roughness: 0.55,
        metalness: 0.72,
      })
    );

    const redLedMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0xff3b48,
        emissive: 0xff1122,
        emissiveIntensity: 3.6,
        roughness: 0.18,
        metalness: 0.1,
      })
    );

    // 1. Primary rear-left linear red horizon bar: x = -48..-10.5 at z = -14.2
    const rearLen = 37.5;
    const rearCenterX = -29.25;
    const rearZ = -14.2;

    const rearHousingGeo = this.trackGeometry(new THREE.BoxGeometry(rearLen, 0.28, 0.32));
    const rearHousing = new THREE.Mesh(rearHousingGeo, housingMat);
    rearHousing.position.set(rearCenterX, 0.58, rearZ);
    barGroup.add(rearHousing);

    const rearLedGeo = this.trackGeometry(new THREE.BoxGeometry(rearLen - 0.2, 0.16, 0.12));
    const rearLed = new THREE.Mesh(rearLedGeo, redLedMat);
    rearLed.position.set(rearCenterX, 0.62, rearZ + 0.14);
    barGroup.add(rearLed);

    // Low support stanchions under rear light bar
    const postGeo = this.trackGeometry(new THREE.BoxGeometry(0.14, 0.58, 0.16));
    for (let x = -47; x <= -11; x += 6) {
      const post = new THREE.Mesh(postGeo, housingMat);
      post.position.set(x, 0.29, rearZ - 0.04);
      barGroup.add(post);
    }

    // 2. Left-flank return light bar extending forward along z = -14.2..+6.0 at x = -48
    const sideLen = 20.2;
    const sideCenterZ = -4.1;
    const sideX = -48.0;

    const sideHousingGeo = this.trackGeometry(new THREE.BoxGeometry(0.32, 0.28, sideLen));
    const sideHousing = new THREE.Mesh(sideHousingGeo, housingMat);
    sideHousing.position.set(sideX, 0.58, sideCenterZ);
    barGroup.add(sideHousing);

    const sideLedGeo = this.trackGeometry(new THREE.BoxGeometry(0.12, 0.16, sideLen - 0.2));
    const sideLed = new THREE.Mesh(sideLedGeo, redLedMat);
    sideLed.position.set(sideX + 0.14, 0.62, sideCenterZ);
    barGroup.add(sideLed);

    for (let z = -13; z <= 5; z += 4.5) {
      const post = new THREE.Mesh(postGeo, housingMat);
      post.position.set(sideX - 0.04, 0.29, z);
      barGroup.add(post);
    }

    // 3. Secondary ground-level linear red wash strip closer to landing zone (z = -10.5, x = -34..-11)
    const accentLen = 23.0;
    const accentLedGeo = this.trackGeometry(new THREE.BoxGeometry(accentLen, 0.08, 0.1));
    const accentLed = new THREE.Mesh(accentLedGeo, redLedMat);
    accentLed.position.set(-22.5, 0.12, -10.5);
    barGroup.add(accentLed);

    // 4. Additive volumetric red horizon halo sheet above the linear light bar
    const haloMat = this.trackMaterial(
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uColor: { value: new THREE.Color(0xff1424) },
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
            float hx = smoothstep(0.0, 0.15, vUv.x) * smoothstep(1.0, 0.85, vUv.x);
            float vy = exp(-pow((vUv.y - 0.18) * 3.1, 2.0));
            float lowCore = exp(-pow((vUv.y - 0.12) * 9.0, 2.0)) * 0.65;
            float alpha = hx * (vy * 0.34 + lowCore) * 0.92;
            gl_FragColor = vec4(uColor, alpha);
          }
        `,
      })
    );

    const rearHaloGeo = this.trackGeometry(new THREE.PlaneGeometry(rearLen + 6.0, 6.2));
    const rearHalo = new THREE.Mesh(rearHaloGeo, haloMat);
    rearHalo.position.set(rearCenterX, 2.4, rearZ + 0.22);
    barGroup.add(rearHalo);

    const sideHaloGeo = this.trackGeometry(new THREE.PlaneGeometry(sideLen + 4.0, 5.4));
    const sideHalo = new THREE.Mesh(sideHaloGeo, haloMat);
    sideHalo.rotation.y = Math.PI / 2;
    sideHalo.position.set(sideX + 0.22, 2.1, sideCenterZ);
    barGroup.add(sideHalo);

    // 5. Dramatic crimson PointLights casting red light over the landing pad & smoke cushion
    const redLightPositions: Array<[number, number, number, number]> = [
      [-14.5, 2.1, -10.5, 62],
      [-23.0, 2.4, -7.5, 78],
      [-35.0, 2.6, -6.5, 65],
      [-21.0, 1.8, 2.5, 34],
    ];
    for (const [lx, ly, lz, intensity] of redLightPositions) {
      const pLight = new THREE.PointLight(0xff1428, intensity, 42, 1.55);
      pLight.position.set(lx, ly, lz);
      barGroup.add(pLight);
    }

    this.group.add(barGroup);
  }

  private buildRearFloodlight(): void {
    const floodGroup = new THREE.Group();
    floodGroup.name = 'RearStadiumFloodlight';

    const towerX = -4.0;
    const towerY = 1.8;
    const towerZ = -18.0;

    const steelMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0x1d222e,
        roughness: 0.48,
        metalness: 0.78,
      })
    );

    const emitterMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xf4f9ff,
        emissiveIntensity: 4.5,
        roughness: 0.1,
      })
    );

    // Pedestal base & truss stanchion supporting the floodlight bank
    const baseGeo = this.trackGeometry(new THREE.BoxGeometry(2.6, 0.35, 1.4));
    const base = new THREE.Mesh(baseGeo, steelMat);
    base.position.set(towerX, 0.175, towerZ);
    floodGroup.add(base);

    const mastGeo = this.trackGeometry(new THREE.CylinderGeometry(0.11, 0.14, 1.65, 8));
    for (const dx of [-0.9, 0.9]) {
      const mast = new THREE.Mesh(mastGeo, steelMat);
      mast.position.set(towerX + dx, 0.98, towerZ - 0.12);
      floodGroup.add(mast);
    }

    // Floodlight bank housing
    const housingGeo = this.trackGeometry(new THREE.BoxGeometry(3.2, 1.15, 0.55));
    const housing = new THREE.Mesh(housingGeo, steelMat);
    housing.position.set(towerX, towerY, towerZ);
    floodGroup.add(housing);

    // 4 blazing white stadium LED emitter modules inside the housing
    const moduleGeo = this.trackGeometry(new THREE.BoxGeometry(0.64, 0.78, 0.08));
    for (let i = 0; i < 4; i++) {
      const mx = towerX - 1.11 + i * 0.74;
      const mod = new THREE.Mesh(moduleGeo, emitterMat);
      mod.position.set(mx, towerY, towerZ + 0.28);
      floodGroup.add(mod);
    }

    // Soft additive bright corona / lens halo directly on the floodlight face
    this.floodCoronaMaterial = this.trackMaterial(
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uColor: { value: new THREE.Color(0xeef6ff) },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform vec3 uColor;
          varying vec2 vUv;
          void main() {
            vec2 p = (vUv - 0.5) * 2.0;
            float r = length(p);
            float flicker = 0.96 + 0.04 * sin(uTime * 19.0);
            float core = exp(-r * r * 14.0);
            float halo = exp(-r * 3.1) * 0.55;
            // Subtle horizontal anamorphic lens streak
            float streak = exp(-abs(p.y) * 22.0) * exp(-abs(p.x) * 1.9) * 0.42;
            float alpha = clamp((core + halo + streak) * flicker, 0.0, 1.0);
            gl_FragColor = vec4(uColor, alpha * 0.85);
          }
        `,
      })
    );

    const coronaGeo = this.trackGeometry(new THREE.PlaneGeometry(11.0, 5.5));
    const corona = new THREE.Mesh(coronaGeo, this.floodCoronaMaterial);
    corona.position.set(towerX, towerY, towerZ + 0.45);
    floodGroup.add(corona);

    // Volumetric additive cone light beams shining forward (+Z) toward the tarmac & camera
    const beamConfigs = [
      { radius: 8.8, length: 42, yaw: 0.0, pitch: -0.04, opacity: 0.16, color: 0xdcecff },
      { radius: 4.6, length: 34, yaw: -0.14, pitch: -0.02, opacity: 0.14, color: 0xf0f7ff },
      { radius: 4.8, length: 36, yaw: 0.15, pitch: -0.03, opacity: 0.14, color: 0xf0f7ff },
    ];

    for (let i = 0; i < beamConfigs.length; i++) {
      const cfg = beamConfigs[i];
      // Cone apex at local origin, expanding along +Z
      const coneGeo = this.trackGeometry(
        new THREE.ConeGeometry(cfg.radius, cfg.length, 28, 1, true)
      );
      coneGeo.translate(0, -cfg.length * 0.5, 0);
      coneGeo.rotateX(-Math.PI / 2);

      const timeUniform = { value: 0 };
      this.floodBeamUniforms.push({ uTime: timeUniform });

      const beamMat = this.trackMaterial(
        new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          uniforms: {
            uTime: timeUniform,
            uColor: { value: new THREE.Color(cfg.color) },
            uOpacity: { value: cfg.opacity },
          },
          vertexShader: /* glsl */ `
            varying vec2 vUv;
            varying vec3 vNormalView;
            varying vec3 vViewDir;

            void main() {
              vUv = uv;
              vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
              vNormalView = normalize(normalMatrix * normal);
              vViewDir = normalize(-mvPos.xyz);
              gl_Position = projectionMatrix * mvPos;
            }
          `,
          fragmentShader: /* glsl */ `
            uniform float uTime;
            uniform vec3 uColor;
            uniform float uOpacity;
            varying vec2 vUv;
            varying vec3 vNormalView;
            varying vec3 vViewDir;

            void main() {
              // vUv.y = 1 near apex (floodlight), 0 at far open mouth
              float axialFade = pow(vUv.y, 1.45) * smoothstep(0.0, 0.25, vUv.y);
              // Soft volumetric cylinder silhouette falloff
              float edgeSoft = pow(abs(dot(vNormalView, vViewDir)), 1.5);
              // Gentle atmospheric dust haze modulation
              float mist = 0.88 + 0.12 * sin(vUv.y * 14.0 - uTime * 0.9 + vUv.x * 6.2831);
              float alpha = axialFade * edgeSoft * mist * uOpacity;
              gl_FragColor = vec4(uColor, alpha);
            }
          `,
        })
      );

      const beam = new THREE.Mesh(coneGeo, beamMat);
      beam.position.set(towerX, towerY, towerZ + 0.35);
      beam.rotation.set(cfg.pitch, cfg.yaw, 0);
      floodGroup.add(beam);
    }

    // Physical SpotLight throwing crisp bright white reflection streak down the wet tarmac
    const spot = new THREE.SpotLight(0xf2f7ff, 180, 95, Math.PI * 0.28, 0.65, 1.45);
    spot.position.set(towerX, towerY + 0.9, towerZ + 0.6);
    spot.target.position.set(towerX + 1.5, 0, 14);
    floodGroup.add(spot);
    floodGroup.add(spot.target);

    // Local fill glow right in front of the floodlight
    const floodFill = new THREE.PointLight(0xeef5ff, 26, 28, 1.6);
    floodFill.position.set(towerX, towerY + 0.5, towerZ + 2.2);
    floodGroup.add(floodFill);

    this.group.add(floodGroup);
  }

  private buildBackgroundStructures(): void {
    const structGroup = new THREE.Group();
    structGroup.name = 'SpaceXTestFacilitySilhouettes';

    const darkSteelMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0x121620,
        roughness: 0.72,
        metalness: 0.45,
      })
    );

    const concreteDarkMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0x161a24,
        roughness: 0.88,
        metalness: 0.1,
      })
    );

    const tankMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0x1e2432,
        roughness: 0.52,
        metalness: 0.55,
      })
    );

    const workLightMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0xffe4b8,
        emissive: 0xffb864,
        emissiveIntensity: 1.9,
        roughness: 0.3,
      })
    );

    // 1. SpaceX McGregor Raptor Vertical Test Stand (left-rear)
    const standGroup = new THREE.Group();
    standGroup.position.set(-46, 0, -46);

    const flameBaseGeo = this.trackGeometry(new THREE.BoxGeometry(11, 5.5, 9));
    const flameBase = new THREE.Mesh(flameBaseGeo, concreteDarkMat);
    flameBase.position.set(0, 2.75, 0);
    standGroup.add(flameBase);

    const towerColGeo = this.trackGeometry(new THREE.BoxGeometry(0.55, 30, 0.55));
    const colOffsets: Array<[number, number]> = [
      [-3.4, -2.6],
      [3.4, -2.6],
      [-3.4, 2.6],
      [3.4, 2.6],
    ];
    for (const [cx, cz] of colOffsets) {
      const col = new THREE.Mesh(towerColGeo, darkSteelMat);
      col.position.set(cx, 20.5, cz);
      standGroup.add(col);
    }

    const deckGeo = this.trackGeometry(new THREE.BoxGeometry(8.2, 0.7, 6.4));
    for (const dy of [12, 20, 28, 35]) {
      const deck = new THREE.Mesh(deckGeo, darkSteelMat);
      deck.position.set(0, dy, 0);
      standGroup.add(deck);
    }

    // Cantilevered engine hoist crane jib at top of vertical stand
    const jibGeo = this.trackGeometry(new THREE.BoxGeometry(10.5, 0.9, 1.2));
    const jib = new THREE.Mesh(jibGeo, darkSteelMat);
    jib.position.set(3.2, 36.2, 0);
    standGroup.add(jib);

    // Aviation beacon atop the vertical test stand
    this.addAviationBeacon(standGroup, -3.2, 37.2, 0, 0.5, 3.1);
    this.addAviationBeacon(standGroup, 8.2, 36.9, 0, 2.1, 3.1);
    structGroup.add(standGroup);

    // 2. Propellant Cryo Farm: LOX Sphere + Vertical Methane/LOX Towers (center-back)
    const farmGroup = new THREE.Group();
    farmGroup.position.set(-20, 0, -52);

    const sphereGeo = this.trackGeometry(new THREE.SphereGeometry(4.6, 20, 14));
    const cryoSphere = new THREE.Mesh(sphereGeo, tankMat);
    cryoSphere.position.set(0, 7.2, 0);
    farmGroup.add(cryoSphere);

    const legGeo = this.trackGeometry(new THREE.CylinderGeometry(0.22, 0.28, 7.4, 8));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const leg = new THREE.Mesh(legGeo, darkSteelMat);
      leg.position.set(Math.cos(a) * 3.6, 3.6, Math.sin(a) * 3.6);
      farmGroup.add(leg);
    }

    const vTankGeo = this.trackGeometry(new THREE.CylinderGeometry(1.7, 1.7, 15.5, 14));
    const vTankCapGeo = this.trackGeometry(new THREE.SphereGeometry(1.7, 14, 8));
    for (const tx of [9.5, 14.2]) {
      const tank = new THREE.Mesh(vTankGeo, tankMat);
      tank.position.set(tx, 8.2, -1.5);
      farmGroup.add(tank);

      const cap = new THREE.Mesh(vTankCapGeo, tankMat);
      cap.position.set(tx, 15.95, -1.5);
      farmGroup.add(cap);
    }

    // Elevated propellant pipe rack bridge
    const pipeGeo = this.trackGeometry(new THREE.BoxGeometry(16, 0.5, 0.7));
    const pipe = new THREE.Mesh(pipeGeo, darkSteelMat);
    pipe.position.set(6.8, 5.2, -1.0);
    farmGroup.add(pipe);
    structGroup.add(farmGroup);

    // 3. Distant Industrial Assembly / Structural Test Hangar (right-rear)
    const hangarGroup = new THREE.Group();
    hangarGroup.position.set(48, 0, -45);

    const hangarBodyGeo = this.trackGeometry(new THREE.BoxGeometry(28, 12.5, 16));
    const hangarBody = new THREE.Mesh(hangarBodyGeo, darkSteelMat);
    hangarBody.position.set(0, 6.25, 0);
    hangarGroup.add(hangarBody);

    const roofGeo = this.trackGeometry(new THREE.BoxGeometry(29, 0.9, 17));
    const roof = new THREE.Mesh(roofGeo, concreteDarkMat);
    roof.position.set(0, 12.8, 0);
    hangarGroup.add(roof);

    // Subtle warm work-bay strip lights across the hangar facade
    const stripGeo = this.trackGeometry(new THREE.BoxGeometry(5.2, 0.24, 0.14));
    for (const bx of [-8.5, 0, 8.5]) {
      const strip = new THREE.Mesh(stripGeo, workLightMat);
      strip.position.set(bx, 9.2, 8.05);
      hangarGroup.add(strip);
    }

    this.addAviationBeacon(hangarGroup, 13.8, 13.8, 7.6, 1.4, 2.5);
    structGroup.add(hangarGroup);

    // 4. Secondary tall comms/telemetry lattice mast far right-back
    const mastX = 34;
    const mastZ = -56;
    const commMastGeo = this.trackGeometry(new THREE.CylinderGeometry(0.18, 0.65, 28, 6));
    const commMast = new THREE.Mesh(commMastGeo, darkSteelMat);
    commMast.position.set(mastX, 14, mastZ);
    structGroup.add(commMast);
    this.addAviationBeacon(structGroup, mastX, 28.4, mastZ, 3.7, 2.9);

    this.group.add(structGroup);
  }

  private buildPerimeterBeacons(): void {
    const poleGeo = this.trackGeometry(new THREE.CylinderGeometry(0.05, 0.07, 2.4, 6));
    const poleMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0x1b202b,
        roughness: 0.7,
        metalness: 0.5,
      })
    );

    const xs = [-68, -54, -36, -16, 6, 26, 46, 66];
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      const z = -34;
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(x, 1.2, z);
      this.group.add(pole);

      this.addAviationBeacon(this.group, x, 2.5, z, i * 0.9, 2.1);
    }
  }

  private addAviationBeacon(
    parent: THREE.Group,
    x: number,
    y: number,
    z: number,
    phase: number,
    speed: number
  ): void {
    const bulbGeo = this.trackGeometry(new THREE.SphereGeometry(0.24, 10, 8));
    const bulbMat = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: 0xff3c44,
        emissive: 0xff1620,
        emissiveIntensity: 2.5,
        roughness: 0.2,
      })
    );
    const bulb = new THREE.Mesh(bulbGeo, bulbMat);
    bulb.position.set(x, y, z);
    parent.add(bulb);

    this.beacons.push({
      material: bulbMat,
      phase,
      speed,
      minIntensity: 0.25,
      maxIntensity: 3.4,
    });
  }
}
