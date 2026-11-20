import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ARENA_CONFIG, CameraMode, CarState } from '../types';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const LOCAL_FORWARD = new THREE.Vector3(0, 0, 1);
const LOCAL_UP = new THREE.Vector3(0, 1, 0);

/**
 * 4-mode cinematic & interactive camera rig for the SpaceX McGregor Roadster stunt:
 * 1. 'ramp'  - Iconic wide broadcast framing from +Z showing full C-ramp + landing zone,
 *              with gentle tracking pan, flip/touchdown zoom-in, and landing shake
 * 2. 'chase' - Smooth aerodynamic chase camera behind velocity/forward vector with
 *              horizon roll damping during the vertical climb & 180° barrel roll
 * 3. 'rear'  - Low dramatic close-up behind the rear diffuser, 4 bronze rocket nozzles,
 *              4 suction fans, full-width red LED bar, and active spoiler
 * 4. 'orbit' - Interactive OrbitControls tracking the car with smooth damping
 */
export class CameraRig {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly baseFov: number;

  private mode: CameraMode = 'ramp';
  private initialized = false;
  private orbitNeedsSeed = true;

  // Smoothed camera state
  private readonly smoothedPos = new THREE.Vector3(0, 10.5, 50);
  private readonly smoothedTarget = new THREE.Vector3(-1, 10.0, 0);
  private readonly smoothedUp = new THREE.Vector3(0, 1, 0);
  private readonly prevCarPos = new THREE.Vector3();
  private currentFov: number;

  // Landing shake state
  private shakeIntensity = 0;
  private shakeTime = 0;

  // Reusable scratch math objects (zero per-frame allocations)
  private readonly tmpCarPos = new THREE.Vector3();
  private readonly tmpCarVel = new THREE.Vector3();
  private readonly tmpCarQuat = new THREE.Quaternion();
  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpCarUp = new THREE.Vector3();
  private readonly tmpTrackDir = new THREE.Vector3();
  private readonly tmpDesiredPos = new THREE.Vector3();
  private readonly tmpDesiredTarget = new THREE.Vector3();
  private readonly tmpDesiredUp = new THREE.Vector3();
  private readonly tmpCarDelta = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpCamUp = new THREE.Vector3();
  private readonly tmpViewDir = new THREE.Vector3();
  private readonly tmpShakeOffset = new THREE.Vector3();
  private readonly tmpFinalPos = new THREE.Vector3();
  private readonly tmpFinalTarget = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera;
    this.baseFov = camera.fov;
    this.currentFov = camera.fov;

    this.controls = new OrbitControls(camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = true;
    this.controls.minDistance = 3.2;
    this.controls.maxDistance = 125;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.enabled = false;

    // Default iconic broadcast framing on construction
    this.camera.position.copy(this.smoothedPos);
    this.camera.up.copy(WORLD_UP);
    this.camera.lookAt(this.smoothedTarget);
  }

  public setMode(mode: CameraMode): void {
    if (this.mode === mode) return;
    this.mode = mode;

    if (mode === 'orbit') {
      this.controls.enabled = true;
      this.orbitNeedsSeed = true;
      this.camera.up.copy(WORLD_UP);
      this.smoothedUp.copy(WORLD_UP);
    } else {
      this.controls.enabled = false;
      // Start smoothly from current camera pose when leaving orbit
      this.smoothedPos.copy(this.camera.position);
    }
  }

  public getMode(): CameraMode {
    return this.mode;
  }

  public triggerLandingShake(intensity: number): void {
    if (!Number.isFinite(intensity) || intensity <= 0) return;
    this.shakeIntensity = Math.min(2.8, Math.max(this.shakeIntensity, intensity));
  }

  public update(state: CarState, dt: number): void {
    const safeDt = THREE.MathUtils.clamp(Number.isFinite(dt) ? dt : 0.016, 0.001, 0.1);

    this.tmpCarPos.set(state.position[0], state.position[1], state.position[2]);
    this.tmpCarVel.set(state.velocity[0], state.velocity[1], state.velocity[2]);
    this.tmpCarQuat.set(
      state.quaternion[0],
      state.quaternion[1],
      state.quaternion[2],
      state.quaternion[3]
    );
    if (this.tmpCarQuat.lengthSq() < 1e-6) {
      this.tmpCarQuat.identity();
    } else {
      this.tmpCarQuat.normalize();
    }

    if (!this.initialized) {
      this.prevCarPos.copy(this.tmpCarPos);
    }

    // Update shake envelope
    this.shakeTime += safeDt;
    if (this.shakeIntensity > 0.001) {
      this.shakeIntensity *= Math.exp(-5.4 * safeDt);
      if (this.shakeIntensity < 0.002) {
        this.shakeIntensity = 0;
      }
    }

    if (this.mode === 'orbit') {
      this.updateOrbitMode(safeDt);
      this.prevCarPos.copy(this.tmpCarPos);
      this.initialized = true;
      return;
    }

    let desiredFov = this.baseFov;
    let posLambda = 6.5;
    let targetLambda = 8.0;
    let upLambda = 6.5;
    let shakeScale = 0.55;

    switch (this.mode) {
      case 'ramp':
        desiredFov = this.computeRampBroadcastPose(state);
        posLambda = 3.4;
        targetLambda = 4.6;
        upLambda = 8.0;
        shakeScale = 0.65;
        break;
      case 'chase':
        desiredFov = this.computeChasePose(state);
        posLambda = 6.2;
        targetLambda = 9.5;
        upLambda = 5.5;
        shakeScale = 0.42;
        break;
      case 'rear':
        desiredFov = this.computeRearDiffuserPose(state);
        posLambda = 13.5;
        targetLambda = 16.0;
        upLambda = 10.5;
        shakeScale = 0.16;
        break;
    }

    if (!this.initialized) {
      this.smoothedPos.copy(this.tmpDesiredPos);
      this.smoothedTarget.copy(this.tmpDesiredTarget);
      this.smoothedUp.copy(this.tmpDesiredUp).normalize();
      this.currentFov = desiredFov;
    } else {
      const posAlpha = 1 - Math.exp(-posLambda * safeDt);
      const targetAlpha = 1 - Math.exp(-targetLambda * safeDt);
      const upAlpha = 1 - Math.exp(-upLambda * safeDt);
      const fovAlpha = 1 - Math.exp(-3.8 * safeDt);

      this.smoothedPos.lerp(this.tmpDesiredPos, posAlpha);
      this.smoothedTarget.lerp(this.tmpDesiredTarget, targetAlpha);
      this.smoothedUp.lerp(this.tmpDesiredUp, upAlpha);
      if (this.smoothedUp.lengthSq() < 1e-6) {
        this.smoothedUp.copy(WORLD_UP);
      } else {
        this.smoothedUp.normalize();
      }
      this.currentFov = THREE.MathUtils.lerp(this.currentFov, desiredFov, fovAlpha);
    }

    // Apply smoothed FOV if changed
    if (Math.abs(this.camera.fov - this.currentFov) > 0.01) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }

    // Apply camera shake without polluting smoothedPos / smoothedTarget
    this.tmpFinalPos.copy(this.smoothedPos);
    this.tmpFinalTarget.copy(this.smoothedTarget);

    if (this.shakeIntensity > 0) {
      this.tmpViewDir.subVectors(this.tmpFinalTarget, this.tmpFinalPos).normalize();
      this.tmpRight.crossVectors(this.tmpViewDir, this.smoothedUp);
      if (this.tmpRight.lengthSq() < 1e-6) {
        this.tmpRight.set(1, 0, 0);
      } else {
        this.tmpRight.normalize();
      }
      this.tmpCamUp.crossVectors(this.tmpRight, this.tmpViewDir).normalize();

      const amp = this.shakeIntensity * shakeScale;
      const sx =
        (Math.sin(this.shakeTime * 43.0) * 0.65 + Math.cos(this.shakeTime * 71.0) * 0.35) * amp;
      const sy =
        (Math.cos(this.shakeTime * 53.0) * 0.7 + Math.sin(this.shakeTime * 89.0) * 0.3) * amp;

      this.tmpShakeOffset
        .set(0, 0, 0)
        .addScaledVector(this.tmpRight, sx)
        .addScaledVector(this.tmpCamUp, sy);

      this.tmpFinalPos.add(this.tmpShakeOffset);
      this.tmpFinalTarget.addScaledVector(this.tmpShakeOffset, 0.45);
    }

    this.camera.position.copy(this.tmpFinalPos);
    this.camera.up.copy(this.smoothedUp);
    this.camera.lookAt(this.tmpFinalTarget);

    this.prevCarPos.copy(this.tmpCarPos);
    this.initialized = true;
  }

  public dispose(): void {
    this.controls.dispose();
  }

  private computeRampBroadcastPose(state: CarState): number {
    // Base iconic framing: (0, 10.5, 50) looking toward (-1, 10.0, 0)
    // C-ramp cleanly framed on the RIGHT, landing zone & red horizon glow on the LEFT
    const carX = this.tmpCarPos.x;
    const carY = this.tmpCarPos.y;

    const isFlipOrLanding =
      state.phase === 'flip' ||
      state.phase === 'hover' ||
      state.phase === 'landed' ||
      state.phase === 'launch';

    const zoomFactor =
      state.phase === 'hover' || state.phase === 'landed'
        ? 1.0
        : state.phase === 'flip'
          ? 0.72
          : state.phase === 'launch'
            ? 0.38
            : 0.0;

    // Gentle camera tracking pan keeping both ramp and landing zone anchored in broadcast view
    const panX = THREE.MathUtils.clamp(carX * 0.16, -4.8, 3.8);
    const panY = THREE.MathUtils.clamp((carY - 10.0) * 0.12, -1.6, 3.2);

    const camX = THREE.MathUtils.lerp(0.0, -4.2, zoomFactor) + panX * 0.45;
    const camY = THREE.MathUtils.lerp(10.5, 8.8, zoomFactor) + panY * 0.35;
    const camZ = THREE.MathUtils.lerp(50.5, 45.2, zoomFactor);

    const landingBiasX = isFlipOrLanding
      ? THREE.MathUtils.lerp(-1.0, ARENA_CONFIG.landingPadX * 0.38, zoomFactor)
      : -1.0;

    const targetX = landingBiasX + panX * 0.72;
    const targetY = THREE.MathUtils.lerp(10.0, 7.6, zoomFactor) + panY * 0.75;
    const targetZ = THREE.MathUtils.clamp(this.tmpCarPos.z * 0.25, -2.5, 2.5);

    this.tmpDesiredPos.set(camX, camY, camZ);
    this.tmpDesiredTarget.set(targetX, targetY, targetZ);
    this.tmpDesiredUp.copy(WORLD_UP);

    // Subtle telephoto zoom-in during flip & hover touchdown
    return this.baseFov - zoomFactor * 3.8;
  }

  private computeChasePose(state: CarState): number {
    this.tmpForward.copy(LOCAL_FORWARD).applyQuaternion(this.tmpCarQuat).normalize();
    this.tmpCarUp.copy(LOCAL_UP).applyQuaternion(this.tmpCarQuat).normalize();

    const speedMs = this.tmpCarVel.length();
    if (speedMs > 3.5) {
      this.tmpTrackDir
        .copy(this.tmpCarVel)
        .multiplyScalar(1 / speedMs)
        .multiplyScalar(0.55)
        .addScaledVector(this.tmpForward, 0.45);
      if (this.tmpTrackDir.lengthSq() < 1e-4) {
        this.tmpTrackDir.copy(this.tmpForward);
      } else {
        this.tmpTrackDir.normalize();
      }
    } else {
      this.tmpTrackDir.copy(this.tmpForward);
    }

    // Horizon roll damping:
    // Strongly favor world-up during approach, flip (180° barrel roll), hover, and landing
    // so the player never loses spatial orientation, while smoothly blending toward carUp
    // during near-vertical ramp climbing to avoid lookAt gimbal lock.
    const verticality = Math.abs(this.tmpTrackDir.y);
    const gimbalBlend = THREE.MathUtils.smoothstep(verticality, 0.52, 0.94);

    if (state.phase === 'flip' || state.phase === 'hover' || state.phase === 'landed') {
      // Keep horizon nearly level during barrel roll with a subtle responsive tilt hint
      this.tmpDesiredUp
        .copy(WORLD_UP)
        .multiplyScalar(0.92)
        .addScaledVector(this.tmpCarUp, 0.08 * (this.tmpCarUp.y >= 0 ? 1 : -1));
    } else if (state.onRamp && this.tmpCarUp.y < -0.35) {
      // Upside-down on the inverted deck: gently stay predominantly upright with subtle ramp feel
      this.tmpDesiredUp.copy(WORLD_UP);
    } else {
      this.tmpDesiredUp
        .copy(WORLD_UP)
        .lerp(this.tmpCarUp, 0.16 + gimbalBlend * 0.72);
    }

    if (this.tmpDesiredUp.lengthSq() < 1e-4) {
      this.tmpDesiredUp.copy(WORLD_UP);
    } else {
      this.tmpDesiredUp.normalize();
    }

    const speedFactor = THREE.MathUtils.clamp(state.speedKmh / 180, 0, 1);
    const followDist = 9.2 + speedFactor * 2.8;

    // Offset slightly inward toward open air when inverted on the ceiling slab so we never clip concrete
    const liftAxisY = state.onRamp && this.tmpCarUp.y < -0.35 ? -1.8 : 2.95;

    this.tmpDesiredPos
      .copy(this.tmpCarPos)
      .addScaledVector(this.tmpTrackDir, -followDist)
      .addScaledVector(WORLD_UP, liftAxisY);

    // Slight +Z broadcast side bias when climbing vertically so the C-ramp wall stays clear
    if (state.onRamp && verticality > 0.45) {
      this.tmpDesiredPos.z += 2.2 * verticality;
    }

    // Never clip below tarmac
    this.tmpDesiredPos.y = Math.max(1.15, this.tmpDesiredPos.y);

    this.tmpDesiredTarget
      .copy(this.tmpCarPos)
      .addScaledVector(this.tmpTrackDir, 4.2)
      .addScaledVector(WORLD_UP, state.onRamp && this.tmpCarUp.y < -0.35 ? -0.3 : 0.75);

    this.clampInsideConcaveRamp(this.tmpDesiredPos);
    this.clampInsideConcaveRamp(this.tmpDesiredTarget);

    return this.baseFov + speedFactor * 6.0;
  }

  private clampInsideConcaveRamp(p: THREE.Vector3): void {
    const ramp = ARENA_CONFIG.ramp;
    if (Math.abs(p.z - ramp.baseZ) >= ramp.width * 0.5 + 1.5) return;
    const dx = p.x - ramp.baseX;
    const dy = p.y - ramp.radius;
    let theta = Math.atan2(dx, -dy);
    if (theta < -0.2) theta += Math.PI * 2;
    if (theta < -0.1 || theta > ramp.arcAngleRad + 0.1) return;
    const maxR = ramp.radius - 2.0;
    const dist = Math.hypot(dx, dy);
    if (dist > maxR && dist > 1e-4) {
      const scale = maxR / dist;
      p.x = ramp.baseX + dx * scale;
      p.y = ramp.radius + dy * scale;
    }
  }

  private computeRearDiffuserPose(state: CarState): number {
    // Low dramatic close-up behind the rear diffuser:
    // showcases ROSTR plate, 4 bronze rocket nozzles, 4 spinning suction fans,
    // full-width red LED bar, and low active spoiler (+Z is nose forward in car-local space)
    this.tmpForward.copy(LOCAL_FORWARD).applyQuaternion(this.tmpCarQuat).normalize();
    this.tmpCarUp.copy(LOCAL_UP).applyQuaternion(this.tmpCarQuat).normalize();
    this.tmpRight.crossVectors(this.tmpCarUp, this.tmpForward).normalize(); // +X car-left

    const boostPullback = state.thrusters.rearBoost * 0.42;

    this.tmpDesiredPos
      .copy(this.tmpCarPos)
      .addScaledVector(this.tmpForward, -(4.75 + boostPullback))
      .addScaledVector(this.tmpCarUp, 0.96)
      .addScaledVector(this.tmpRight, 0.24);

    // Prevent tarmac floor clipping when upright near ground
    if (this.tmpCarPos.y < 1.8 && this.tmpCarUp.y > 0.35) {
      this.tmpDesiredPos.y = Math.max(0.52, this.tmpDesiredPos.y);
    }

    this.tmpDesiredTarget
      .copy(this.tmpCarPos)
      .addScaledVector(this.tmpForward, 0.35)
      .addScaledVector(this.tmpCarUp, 0.62);

    this.tmpDesiredUp.copy(this.tmpCarUp);

    return this.baseFov + 4.0 + boostPullback * 5.0;
  }

  private updateOrbitMode(dt: number): void {
    if (this.orbitNeedsSeed || !this.initialized) {
      this.controls.target.set(this.tmpCarPos.x, this.tmpCarPos.y + 0.65, this.tmpCarPos.z);
      // Place camera at a clean hero 3/4 inspection distance around the car if coming from far away
      if (this.camera.position.distanceTo(this.controls.target) > 32 || !this.initialized) {
        this.camera.position.set(
          this.tmpCarPos.x - 6.8,
          Math.max(2.6, this.tmpCarPos.y + 3.2),
          this.tmpCarPos.z + 9.2
        );
      }
      this.orbitNeedsSeed = false;
    } else {
      // Translate both target and camera by car displacement so user orbits smoothly around a moving car
      this.tmpCarDelta.subVectors(this.tmpCarPos, this.prevCarPos);
      this.controls.target.add(this.tmpCarDelta);
      this.camera.position.add(this.tmpCarDelta);
    }

    // Smoothly restore base FOV in orbit mode
    const fovAlpha = 1 - Math.exp(-5.0 * dt);
    this.currentFov = THREE.MathUtils.lerp(this.currentFov, this.baseFov, fovAlpha);
    if (Math.abs(this.camera.fov - this.currentFov) > 0.01) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }

    this.camera.up.copy(WORLD_UP);
    this.controls.update();
    this.smoothedPos.copy(this.camera.position);
    this.smoothedTarget.copy(this.controls.target);
  }
}
