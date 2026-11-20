export type VoxelMaterialTag = 0 | 1 | 2 | 3 | 4 | 5;
// 0 = body/matte, 1 = bronze glass, 2 = metal/nozzle, 3 = emissiveHead, 4 = emissiveTail, 5 = emissiveAmber

export interface VoxelPartData {
  /** Center pivot in car-local meters (+X left, +Y up, +Z nose forward, ground Y=0). */
  pivot: [number, number, number];
  /**
   * Flat packed voxel quads relative to world car origin in grid indices, or local offsets:
   * [x_m, y_m, z_m, colorIndex, materialTag] stride = 5 numbers per exposed voxel.
   */
  voxels: number[];
}

export interface NozzleAnchors {
  liftFL: [number, number, number];
  liftFR: [number, number, number];
  liftRL: [number, number, number];
  liftRR: [number, number, number];
  rearBoost: [number, number, number][];
  retroFront: [number, number, number];
  rcsLeft: [number, number, number];
  rcsRight: [number, number, number];
  rcsNose: [number, number, number];
  rcsTail: [number, number, number];
}

export interface RostrVoxelAsset {
  voxelSize: number;
  dimensions: { width: number; length: number; height: number };
  palette: string[];
  parts: {
    chassis: VoxelPartData;
    spoiler: VoxelPartData;
    wheelFL: VoxelPartData;
    wheelFR: VoxelPartData;
    wheelRL: VoxelPartData;
    wheelRR: VoxelPartData;
    fan0: VoxelPartData;
    fan1: VoxelPartData;
    fan2: VoxelPartData;
    fan3: VoxelPartData;
  };
  nozzles: NozzleAnchors;
}

export interface RampConfig {
  baseX: number;
  baseZ: number;
  radius: number;
  width: number;
  arcAngleRad: number;
  lipLength: number;
  approachStartX: number;
}

export const ARENA_CONFIG: {
  ramp: RampConfig;
  spawnPosition: [number, number, number];
  landingPadX: number;
  landingPadRadius: number;
  tarmacHalfExtentX: number;
  tarmacHalfExtentZ: number;
} = {
  ramp: {
    baseX: 14.0,
    baseZ: 0.0,
    radius: 11.0,
    width: 6.4,
    arcAngleRad: Math.PI + 0.22,
    lipLength: 6.2,
    approachStartX: -12.0,
  },
  spawnPosition: [-10.0, 0.0, 0.0],
  landingPadX: -20.0,
  landingPadRadius: 7.5,
  tarmacHalfExtentX: 90.0,
  tarmacHalfExtentZ: 55.0,
};

export interface RampSample {
  /** World-space point on the driving surface. */
  position: [number, number, number];
  /** Unit forward tangent along driving direction (approach -> climb -> inverted exit). */
  tangent: [number, number, number];
  /** Unit inward surface normal pointing into the open air away from the concrete deck. */
  normal: [number, number, number];
  /** Unit transverse vector along ramp width (+Z_world). */
  side: [number, number, number];
  /** Arc distance from start of curved C-ramp (s=0 at baseX). */
  s: number;
  /** Angle in radians from horizontal bottom (0 = upright, PI = upside down). */
  angleRad: number;
  /** True when projecting cleanly onto the curved ramp / overhang lip span. */
  onRamp: boolean;
  /** True once past the cantilevered inverted launch lip. */
  pastLip: boolean;
  /** Signed height above the driving surface along `normal`. */
  signedDistance: number;
}

export type GameMode = 'demo' | 'play' | 'free';
export type CameraMode = 'ramp' | 'chase' | 'rear' | 'orbit';
export type StuntPhase =
  | 'ready'
  | 'approach'
  | 'climb'
  | 'inverted'
  | 'launch'
  | 'flip'
  | 'hover'
  | 'landed'
  | 'crashed';
export type SpoilerMode = 'road' | 'downforce' | 'airbrake';

export interface ThrusterState {
  liftFL: number;
  liftFR: number;
  liftRL: number;
  liftRR: number;
  rearBoost: number;
  retroFront: number;
  rcsRollL: number;
  rcsRollR: number;
  rcsPitchUp: number;
  rcsPitchDown: number;
  suctionPower: number;
  groundEffectIntensity: number;
}

export interface ControlInput {
  throttle: number;       // 0..1
  brake: number;          // 0..1
  steer: number;          // -1 (right) .. +1 (left)
  pitch: number;          // -1 (nose down) .. +1 (nose up)
  roll: number;           // -1 .. +1
  yaw: number;            // -1 .. +1
  hoverLift: number;      // 0..1
  rearBoost: boolean;
  retroBrake: boolean;
  suctionActive: boolean;
  flightAssist: boolean;
}

export interface CarState {
  position: [number, number, number];
  velocity: [number, number, number];
  quaternion: [number, number, number, number];
  angularVelocity: [number, number, number];
  speedKmh: number;
  altitude: number;
  wheelSpin: number;
  steerAngle: number;
  suspensionOffset: number;
  spoilerAngle: number;
  spoilerMode: SpoilerMode;
  suctionDownforceKg: number;
  copvPressure: number;   // 0..100
  grounded: boolean;
  onRamp: boolean;
  rampS: number;
  braking: boolean;
  thrusters: ThrusterState;
  phase: StuntPhase;
}

export interface StuntScore {
  invertedSeconds: number;
  peakAltitudeM: number;
  flipDegrees: number;
  touchdownVerticalMs: number;
  totalScore: number;
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
  completed: boolean;
}

export interface GhostSnapshot {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  thrusters: ThrusterState;
  phase: StuntPhase;
  timestamp: number;
}
