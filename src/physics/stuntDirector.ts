import { Quaternion, Vector3 } from 'three';
import { ARENA_CONFIG } from '../types';
import type { CarState, ControlInput, GhostSnapshot } from '../types';
import { getRampLength } from './rampCurve';

const RAMP_LENGTH = getRampLength();

export class StuntDirector {
  private elapsed = 0;
  private milestones = new Set<string>();
  private snapshots: GhostSnapshot[] = [];
  private rollComplete = false;
  private finished = false;

  reset(): void {
    this.elapsed = 0;
    this.milestones.clear();
    this.snapshots = [];
    this.rollComplete = false;
    this.finished = false;
  }

  getInput(state: CarState, dt: number): ControlInput {
    this.recordMilestone(state);
    this.elapsed += dt;
    const input: ControlInput = {
      throttle: 0, brake: 0, steer: 0, pitch: 0, roll: 0, yaw: 0, hoverLift: 0,
      rearBoost: false, retroBrake: false, suctionActive: false, flightAssist: true,
    };

    switch (state.phase) {
      case 'ready':
      case 'approach':
      case 'climb':
      case 'inverted': {
        const progress = state.rampS;
        const targetKmh = 100 - 34 * Math.min(1, Math.max(0, (progress - 8) / 12));
        const speedError = (targetKmh - state.speedKmh) / 3.6;
        input.throttle = Math.min(1, Math.max(0, speedError * 0.45));
        input.brake = Math.min(1, Math.max(0, -speedError * 0.22));
        input.suctionActive = true;
        return input;
      }
      case 'landed':
      case 'crashed':
        this.finished = true;
        input.brake = 1;
        return input;
      case 'launch':
      case 'flip':
      case 'hover':
        break;
    }

    const orientation = new Quaternion(...state.quaternion);
    const upright = new Vector3(0, 1, 0).applyQuaternion(orientation).y;
    if (!this.rollComplete && state.phase !== 'hover') {
      this.rollComplete = state.phase === 'flip' && upright > 0.97;
      if (!this.rollComplete) {
        input.roll = upright > 0.5 ? 0.55 : 1;
        return input;
      }
    }

    // Close the remaining pad distance, then shed speed before the final descent.
    const distance = state.position[0] - ARENA_CONFIG.landingPadX;
    const targetSpeed = Math.min(18, Math.max(0, 1.4 * distance));
    const forwardSpeed = -state.velocity[0];
    input.retroBrake = forwardSpeed > targetSpeed + 0.2;
    input.rearBoost = forwardSpeed < targetSpeed - 0.6 && distance > 1;
    const targetDescent = -Math.min(3.8, 1.25 + state.altitude * 0.75);
    const verticalAcceleration = 9.81 + 3.4 * (targetDescent - state.velocity[1]);
    input.hoverLift = Math.max(0, Math.min(1, verticalAcceleration / (2.4 * 9.81)));
    return input;
  }

  getGhostSnapshots(): GhostSnapshot[] {
    return this.snapshots.map(snapshot => ({
      ...snapshot,
      position: [...snapshot.position],
      quaternion: [...snapshot.quaternion],
      thrusters: { ...snapshot.thrusters },
    }));
  }

  getSnapshotCount(): number {
    return this.snapshots.length;
  }

  isFinished(): boolean {
    return this.finished;
  }

  private recordMilestone(state: CarState): void {
    let key: string = state.phase;
    if (state.phase === 'climb' && state.rampS > RAMP_LENGTH * 0.2) key = 'wall';
    if (state.phase === 'inverted' && state.rampS > RAMP_LENGTH * 0.83) key = 'lip';
    if (state.phase === 'hover' && state.altitude < 4) key = 'final descent';
    if (this.milestones.has(key)) return;
    this.milestones.add(key);
    this.snapshots.push({
      position: [...state.position],
      quaternion: [...state.quaternion],
      thrusters: { ...state.thrusters },
      phase: state.phase,
      timestamp: this.elapsed,
    });
  }
}
