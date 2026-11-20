import { Matrix4, Quaternion, Vector3 } from 'three';
import { ARENA_CONFIG } from '../types';
import type { CarState, ControlInput, GameMode, RampSample, StuntScore, ThrusterState } from '../types';
import { getRampLength, projectOntoRamp, sampleRamp } from './rampCurve';

const UP = new Vector3(0, 1, 0);
const FORWARD = new Vector3(0, 0, 1);
const GRAVITY = 9.81;
const LIFT = 2.4 * GRAVITY;
const SUCTION = 2.8 * GRAVITY;
const RAMP = ARENA_CONFIG.ramp;
const RAMP_LENGTH = getRampLength();
const ARC_LENGTH = RAMP.radius * RAMP.arcAngleRad;

function clamp(value: number, low = 0, high = 1): number {
  return Math.max(low, Math.min(value, high));
}

function zeroThrusters(): ThrusterState {
  return {
    liftFL: 0, liftFR: 0, liftRL: 0, liftRR: 0, rearBoost: 0, retroFront: 0,
    rcsRollL: 0, rcsRollR: 0, rcsPitchUp: 0, rcsPitchDown: 0,
    suctionPower: 0, groundEffectIntensity: 0,
  };
}

function surfaceOrientation(forward: Vector3, up: Vector3): Quaternion {
  const left = new Vector3().crossVectors(up, forward).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(left, up, forward));
}

export class RoadsterPhysics {
  private state!: CarState;
  private score!: StuntScore;
  private mode: GameMode;
  private launchedFromLip = false;

  constructor(mode: GameMode = 'demo') {
    this.mode = mode;
    this.reset();
  }

  reset(mode: GameMode = this.mode): void {
    this.mode = mode;
    this.launchedFromLip = false;
    this.state = {
      position: [...ARENA_CONFIG.spawnPosition], velocity: [0, 0, 0],
      quaternion: new Quaternion().setFromAxisAngle(UP, Math.PI / 2).toArray(),
      angularVelocity: [0, 0, 0], speedKmh: 0, altitude: 0, wheelSpin: 0, steerAngle: 0,
      suspensionOffset: 0, spoilerAngle: 0, spoilerMode: 'road', suctionDownforceKg: 0,
      copvPressure: 100, grounded: true, onRamp: false, rampS: 0, braking: false,
      thrusters: zeroThrusters(), phase: 'ready',
    };
    this.score = {
      invertedSeconds: 0, peakAltitudeM: 0, flipDegrees: 0, touchdownVerticalMs: 0,
      totalScore: 0, grade: 'D', completed: false,
    };
  }

  getState(): CarState {
    const s = this.state;
    return {
      ...s, position: [...s.position], velocity: [...s.velocity], quaternion: [...s.quaternion],
      angularVelocity: [...s.angularVelocity], thrusters: { ...s.thrusters },
    };
  }

  getScore(): StuntScore {
    return { ...this.score };
  }

  step(dt: number, input: ControlInput): CarState {
    if (!(dt > 0) || !Number.isFinite(dt)) return this.getState();
    const s = this.state;
    const pos = new Vector3(...s.position);
    const vel = new Vector3(...s.velocity);
    const q = new Quaternion(...s.quaternion);
    const spin = new Vector3(...s.angularVelocity);
    const steer = clamp(input.steer, -1, 1);
    const gas = clamp(s.copvPressure / 8);
    const lift = gas * clamp(input.hoverLift);
    const boost = input.rearBoost ? gas : 0;
    const retro = input.retroBrake ? gas : 0;
    let ramp = this.contactRamp(pos, vel);
    const nearbyRamp = input.suctionActive ? this.contactRamp(pos, vel, 0.6, true) : undefined;
    const nearSurface = nearbyRamp !== undefined;
    const suction = input.suctionActive && nearSurface && lift <= 0.02 ? 1 : 0;
    const normal = ramp ? new Vector3(...ramp.normal) : UP;
    const tangentSpeed = ramp ? vel.dot(new Vector3(...ramp.tangent)) : 0;
    const curvature = ramp && ramp.s < ARC_LENGTH ? tangentSpeed ** 2 / RAMP.radius : 0;
    const suctionAcceleration = suction * SUCTION;
    const supported = ramp && curvature + GRAVITY * normal.y + suctionAcceleration >= 0;
    const tarmac = !ramp && pos.y <= 0 && vel.y <= 0;
    const liftDirection = UP.clone().applyQuaternion(q);
    const liftsOff = LIFT * lift * liftDirection.dot(normal)
      > curvature + GRAVITY * normal.y + suctionAcceleration;

    s.grounded = Boolean((supported || tarmac) && !liftsOff);
    s.suspensionOffset *= Math.exp(-11 * dt);
    s.steerAngle += (steer * 0.42 - s.steerAngle) * (1 - Math.exp(-12 * dt));

    if (s.grounded) {
      const forward = FORWARD.clone().applyQuaternion(q).projectOnPlane(normal);
      if (forward.lengthSq() < 1e-6) forward.fromArray(ramp?.tangent ?? [1, 0, 0]);
      const steerTurn = s.phase === 'crashed' ? 0 : steer * Math.min(1.9, vel.length() * 0.18) * dt;
      forward.normalize().applyAxisAngle(normal, steerTurn);
      const side = new Vector3().crossVectors(normal, forward);
      vel.projectOnPlane(normal);
      const traction = s.phase === 'crashed' ? 0 : clamp(input.throttle) * 19 + 11 * boost;
      vel.addScaledVector(forward, traction * dt);
      vel.addScaledVector(UP.clone().projectOnPlane(normal), -GRAVITY * dt);
      vel.addScaledVector(side, -vel.dot(side) * (1 - Math.exp(-12 * dt)));
      const longitudinal = vel.dot(forward);
      const extraDrag = s.phase === 'crashed' ? 14 : 0;
      const brake = 28 * clamp(input.brake) + 20 * retro + extraDrag;
      const loss = Math.min(Math.abs(longitudinal), (0.4 + Math.abs(longitudinal) * 0.035 + brake) * dt);
      vel.addScaledVector(forward, -Math.sign(longitudinal) * loss);
      spin.set(0, 0, 0);

      let rampEntryOffset = 0;
      if (!ramp && s.phase !== 'crashed' && vel.x > 0 && pos.x <= RAMP.baseX && pos.x + vel.x * dt >= RAMP.baseX
        && Math.abs(pos.z + vel.z * dt - RAMP.baseZ) <= RAMP.width / 2) {
        ramp = sampleRamp(0);
        rampEntryOffset = pos.x - RAMP.baseX;
      }

      if (ramp) {
        const tangent = new Vector3(...ramp.tangent);
        const distance = ramp.s + vel.dot(tangent) * dt + rampEntryOffset;
        const next = sampleRamp(distance);
        const nextNormal = new Vector3(...next.normal);
        const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), next.angleRad - ramp.angleRad);
        const z = pos.z + vel.z * dt;
        pos.fromArray(next.position).setZ(z);
        vel.applyQuaternion(rotation);
        forward.applyQuaternion(rotation);
        q.copy(surfaceOrientation(forward, nextNormal));
        s.rampS = next.s;
        s.phase = nextNormal.y < 0 ? 'inverted' : 'climb';

        if (distance >= RAMP_LENGTH || distance < 0 || Math.abs(z - RAMP.baseZ) > RAMP.width / 2) {
          pos.addScaledVector(new Vector3(...next.tangent), distance - next.s);
          s.grounded = false;
          ramp = undefined;
          if (distance >= RAMP_LENGTH) {
            this.launchedFromLip = true;
            s.phase = 'launch';
          } else {
            s.phase = 'climb';
          }
        }
      } else {
        pos.addScaledVector(vel, dt).setY(0);
        if (s.phase !== 'crashed') {
          q.slerp(surfaceOrientation(forward, UP), 1 - Math.exp(-24 * dt));
          if (s.phase === 'ready' && vel.lengthSq() > 0.01) s.phase = 'approach';
        }
      }
    } else {
      const forward = FORWARD.clone().applyQuaternion(q);
      const pitch = clamp(input.pitch, -1, 1);
      const yaw = clamp(input.yaw, -1, 1);
      const roll = clamp(input.roll, -1, 1);
      const previousY = pos.y;

      if (this.launchedFromLip && (s.phase === 'inverted' || s.phase === 'climb') && s.onRamp) {
        s.phase = 'launch';
      } else if (s.phase === 'launch' && Math.abs(roll) > 0.02) {
        s.phase = 'flip';
      } else if (lift > 0.02 && s.phase !== 'crashed' && UP.clone().applyQuaternion(q).y > 0.72) {
        s.phase = 'hover';
      }

      // Angular velocity is stored in body axes. Inputs command rates with bounded acceleration.
      const target = new Vector3(-pitch * 2.5, yaw * 2.5, roll * 4.5).multiplyScalar(gas);
      if (input.flightAssist && pitch === 0 && roll === 0) {
        const horizontal = forward.clone().projectOnPlane(UP);
        if (horizontal.lengthSq() > 1e-6) {
          const correction = q.clone().invert().multiply(surfaceOrientation(horizontal.normalize(), UP));
          const sign = correction.w < 0 ? -1 : 1;
          target.x = clamp(5 * correction.x * sign, -2.5, 2.5) * gas;
          target.z = clamp(5 * correction.z * sign, -2.5, 2.5) * gas;
        }
      }
      spin.lerp(target, 1 - Math.exp(-10 * dt));
      const rate = spin.length();
      if (rate > 1e-8) {
        q.multiply(new Quaternion().setFromAxisAngle(spin.clone().divideScalar(rate), rate * dt)).normalize();
      }

      const brakingAxis = forward.clone();
      if (input.flightAssist) brakingAxis.projectOnPlane(UP).normalize();
      const retroAcceleration = Math.min(24 * retro, Math.max(0, vel.dot(brakingAxis)) / dt);
      vel.y -= GRAVITY * dt;
      vel.addScaledVector(liftDirection, LIFT * lift * dt)
        .addScaledVector(forward, 15 * boost * dt)
        .addScaledVector(brakingAxis, -retroAcceleration * dt);
      if (suction) {
        vel.addScaledVector(nearbyRamp ? new Vector3(...nearbyRamp.normal) : UP, -SUCTION * dt);
      }
      pos.addScaledVector(vel, dt);
      ramp = undefined;

      if (s.phase === 'flip') this.score.flipDegrees += Math.abs(spin.z) * dt * 180 / Math.PI;
      if (pos.y <= 0 && vel.y <= 0 && (previousY > 0 || s.phase !== 'ready')) {
        pos.y = 0;
        this.touchDown(vel, UP.clone().applyQuaternion(q).y);
        s.grounded = vel.y === 0;
      }
    }

    if (!this.score.completed && s.phase !== 'crashed') {
      if (UP.clone().applyQuaternion(q).y < -0.1) this.score.invertedSeconds += dt;
      this.score.peakAltitudeM = Math.max(this.score.peakAltitudeM, pos.y);
    }
    const liftFiring = s.grounded ? 0 : lift;
    const pitchRate = s.grounded ? 0 : spin.x / 2.5;
    const rollRate = s.grounded ? 0 : spin.z / 4.5;
    s.thrusters = {
      liftFL: liftFiring, liftFR: liftFiring, liftRL: liftFiring, liftRR: liftFiring,
      rearBoost: boost, retroFront: retro,
      rcsRollL: clamp(-rollRate), rcsRollR: clamp(rollRate),
      rcsPitchUp: clamp(-pitchRate), rcsPitchDown: clamp(pitchRate),
      suctionPower: suction, groundEffectIntensity: liftFiring * clamp(1 - pos.y / 8),
    };
    const recharge = s.grounded && !ramp ? 6 : 0;
    const gasUse = 6 * liftFiring + 8 * boost + 6 * retro + (s.grounded ? 0 : 1.8 * spin.length());
    s.copvPressure = clamp(s.copvPressure + (recharge - gasUse) * dt, 0, 100);
    s.suctionDownforceKg = suction * 4200;
    s.braking = input.brake > 0 || retro > 0;
    s.spoilerMode = s.braking ? 'airbrake' : s.grounded && (suction > 0 || vel.length() > 20) ? 'downforce' : 'road';
    const spoilerTarget = { road: 0.05, downforce: 0.24, airbrake: 0.55 }[s.spoilerMode];
    s.spoilerAngle += (spoilerTarget - s.spoilerAngle) * (1 - Math.exp(-9 * dt));
    s.wheelSpin += (s.grounded ? vel.dot(FORWARD.clone().applyQuaternion(q)) : s.speedKmh / 3.6 * 0.25) * dt / 0.31;
    s.onRamp = s.grounded && Boolean(ramp);
    s.position = pos.toArray();
    s.velocity = vel.toArray();
    s.quaternion = q.toArray();
    s.angularVelocity = spin.toArray();
    s.speedKmh = vel.length() * 3.6;
    s.altitude = Math.max(0, pos.y);
    return this.getState();
  }

  private contactRamp(pos: Vector3, vel: Vector3, clearance = 0.35, allowSeparation = false): RampSample | undefined {
    const ramp = projectOntoRamp(pos.toArray());
    if (!ramp.onRamp || ramp.signedDistance > clearance) return undefined;
    const tangent = new Vector3(...ramp.tangent);
    const overhang = pos.clone().sub(new Vector3(...ramp.position)).dot(tangent);
    if (ramp.s === 0 && (overhang < 0 || (pos.y <= 0 && vel.x <= 0))) return undefined;
    if (ramp.pastLip && ramp.s === RAMP_LENGTH && overhang >= 0) return undefined;
    if (!allowSeparation && !this.state.onRamp && ramp.signedDistance > 0.02 && vel.dot(new Vector3(...ramp.normal)) > 0) {
      return undefined;
    }
    return ramp;
  }

  private touchDown(vel: Vector3, upright: number): void {
    const s = this.state;
    const impactSpeed = -vel.y;
    s.suspensionOffset = -Math.min(0.24, 0.035 + impactSpeed * 0.02);
    if (impactSpeed < 5.5 && upright > 0.72) {
      vel.y = 0;
      if (this.launchedFromLip) {
        s.phase = 'landed';
        if (!this.score.completed) {
          const score = this.score;
          score.touchdownVerticalMs = impactSpeed;
          score.completed = true;
          score.totalScore = Math.round(
            500 + Math.min(200, score.invertedSeconds * 95) + Math.min(150, score.flipDegrees * 0.8)
            + Math.min(100, score.peakAltitudeM * 5) - impactSpeed * 32,
          );
          score.grade = score.totalScore >= 840 ? 'S' : score.totalScore >= 720 ? 'A'
            : score.totalScore >= 620 ? 'B' : score.totalScore >= 500 ? 'C' : 'D';
        }
      } else {
        s.phase = vel.lengthSq() > 0.25 ? 'approach' : 'ready';
      }
    } else if (impactSpeed > 10 && upright < -0.35) {
      vel.multiplyScalar(0.25).setY(0);
      s.phase = 'crashed';
    } else {
      vel.y = impactSpeed * 0.32;
      vel.x *= 0.73;
      vel.z *= 0.73;
    }
  }
}
