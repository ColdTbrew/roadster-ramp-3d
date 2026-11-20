import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { ARENA_CONFIG } from '../../types';
import type { ControlInput, StuntPhase } from '../../types';
import { getRampLength, getRampMeshProfile, projectOntoRamp, sampleRamp } from '../rampCurve';
import { RoadsterPhysics } from '../roadsterPhysics';
import { StuntDirector } from '../stuntDirector';

const DT = 1 / 120;
const idle: ControlInput = {
  throttle: 0, brake: 0, steer: 0, pitch: 0, roll: 0, yaw: 0, hoverLift: 0,
  rearBoost: false, retroBrake: false, suctionActive: false, flightAssist: false,
};

function expectVector(actual: number[], expected: number[]): void {
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 8));
}

describe('C-ramp', () => {
  const ramp = ARENA_CONFIG.ramp;

  it.each([
    [0, [14, 0, 0], [1, 0, 0], [0, 1, 0]],
    [Math.PI / 2, [25, 11, 0], [0, 1, 0], [-1, 0, 0]],
    [Math.PI, [14, 22, 0], [-1, 0, 0], [0, -1, 0]],
  ] as const)('samples the surface frame at angle %s', (angle, position, tangent, normal) => {
    const sample = sampleRamp(ramp.radius * angle);
    expectVector(sample.position, [...position]);
    expectVector(sample.tangent, [...tangent]);
    expectVector(sample.normal, [...normal]);
    expectVector(sample.side, [0, 0, 1]);
  });

  it('extends the arc tangent and projects points onto the inverted lip', () => {
    const arcEnd = sampleRamp(ramp.radius * ramp.arcAngleRad);
    const length = getRampLength();
    const lip = sampleRamp(length);
    const expectedEnd = new Vector3(...arcEnd.position).addScaledVector(
      new Vector3(...arcEnd.tangent), ramp.lipLength,
    );
    expectVector(lip.position, expectedEnd.toArray());
    expectVector(lip.tangent, arcEnd.tangent);
    expectVector(lip.normal, arcEnd.normal);
    expect(lip.pastLip).toBe(true);

    const point = expectedEnd.addScaledVector(new Vector3(...lip.normal), 0.4);
    const projected = projectOntoRamp(point.toArray());
    expect(projected.onRamp).toBe(true);
    expect(projected.s).toBeCloseTo(length, 8);
    expect(projected.signedDistance).toBeCloseTo(0.4, 8);
    expect(projectOntoRamp(point.setZ(ramp.width).toArray()).onRamp).toBe(false);
    expect(getRampMeshProfile(12)).toHaveLength(13);
  });
});

describe('Roadster physics', () => {
  it('holds a stationary inverted car with suction and falls when released', () => {
    const physics = new RoadsterPhysics();
    const top = sampleRamp(ARENA_CONFIG.ramp.radius * Math.PI);
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2));
    Object.assign(physics['state'], {
      position: top.position, quaternion: q.toArray(), onRamp: true, rampS: top.s, phase: 'inverted',
    });

    for (let i = 0; i < 120; i++) physics.step(DT, { ...idle, suctionActive: true });
    const held = physics.getState();
    expect(held.grounded).toBe(true);
    expect(held.onRamp).toBe(true);
    expectVector(held.position, top.position);
    expect(held.speedKmh).toBeCloseTo(0);

    for (let i = 0; i < 60; i++) physics.step(DT, idle);
    const released = physics.getState();
    expect(released.grounded).toBe(false);
    expect(released.onRamp).toBe(false);
    expect(released.position[1]).toBeLessThan(top.position[1] - 1);
  });

  it('replays identical fixed-step inputs after reset', () => {
    const physics = new RoadsterPhysics();
    const director = new StuntDirector();
    const run = () => {
      let state = physics.getState();
      for (let i = 0; i < 1800 && !director.isFinished(); i++) {
        state = physics.step(DT, director.getInput(state, DT));
      }
      return { state, score: physics.getScore(), ghosts: director.getGhostSnapshots() };
    };

    const first = run();
    physics.reset();
    director.reset();
    expect(run()).toEqual(first);
  });

  it('flies the complete scripted stunt and lands gently on the pad', () => {
    const physics = new RoadsterPhysics('demo');
    const director = new StuntDirector();
    const phases = new Set<StuntPhase>();
    let state = physics.getState();
    let entrySpeed = 0;
    let launchSpeed = 0;
    for (let i = 0; i < 2400 && !director.isFinished(); i++) {
      if (state.phase === 'climb' && entrySpeed === 0) entrySpeed = state.speedKmh;
      if (state.phase === 'launch') launchSpeed = state.speedKmh;
      phases.add(state.phase);
      state = physics.step(DT, director.getInput(state, DT));
    }

    expect([...phases]).toEqual(['ready', 'approach', 'climb', 'inverted', 'launch', 'flip', 'hover', 'landed']);
    expect(entrySpeed).toBeGreaterThan(90);
    expect(entrySpeed).toBeLessThan(105);
    expect(launchSpeed).toBeGreaterThan(55);
    expect(launchSpeed).toBeLessThan(75);
    expect(director.isFinished()).toBe(true);
    expect(director.getGhostSnapshots().length).toBeGreaterThanOrEqual(8);
    expect(Math.abs(state.position[0] - ARENA_CONFIG.landingPadX)).toBeLessThan(2);
    const score = physics.getScore();
    expect(score.touchdownVerticalMs).toBeLessThan(2.2);
    expect(score.completed).toBe(true);
    expect(['S', 'A']).toContain(score.grade);
  });

  it('lifts off the tarmac in Play mode with suction enabled and does not score a tarmac hop', () => {
    const physics = new RoadsterPhysics('play');
    let state = physics.getState();
    for (let i = 0; i < 120; i++) {
      state = physics.step(DT, { ...idle, hoverLift: 1, suctionActive: true, flightAssist: true });
    }
    expect(state.grounded).toBe(false);
    expect(state.altitude).toBeGreaterThan(5);

    for (let i = 0; i < 1200 && !state.grounded; i++) {
      const hover = state.velocity[1] < -2.0 ? 0.65 : 0;
      state = physics.step(DT, { ...idle, hoverLift: hover, suctionActive: true, flightAssist: true });
    }
    expect(state.grounded).toBe(true);
    expect(physics.getScore().completed).toBe(false);
    expect(state.phase).not.toBe('landed');
  });
});
