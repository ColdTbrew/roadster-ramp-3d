import { ARENA_CONFIG, type RampConfig, type RampSample } from '../types';

export function getRampLength(cfg: RampConfig = ARENA_CONFIG.ramp): number {
  return cfg.radius * cfg.arcAngleRad + cfg.lipLength;
}

export function sampleRamp(s: number, cfg: RampConfig = ARENA_CONFIG.ramp): RampSample {
  const length = getRampLength(cfg);
  const distance = Math.max(0, Math.min(s, length));
  const arcLength = cfg.radius * cfg.arcAngleRad;
  const angleRad = Math.min(distance, arcLength) / cfg.radius;
  const sin = Math.sin(angleRad);
  const cos = Math.cos(angleRad);
  const lip = Math.max(0, distance - arcLength);

  return {
    position: [cfg.baseX + cfg.radius * sin + lip * cos, cfg.radius * (1 - cos) + lip * sin, cfg.baseZ],
    tangent: [cos, sin, 0],
    normal: [-sin, cos, 0],
    side: [0, 0, 1],
    s: distance,
    angleRad,
    onRamp: s >= -0.2 && s <= length,
    pastLip: distance > length - 0.15,
    signedDistance: 0,
  };
}

export function projectOntoRamp(pos: [number, number, number], cfg: RampConfig = ARENA_CONFIG.ramp): RampSample {
  const arcLength = cfg.radius * cfg.arcAngleRad;
  const end = sampleRamp(arcLength, cfg);
  const dx = pos[0] - cfg.baseX;
  const dy = pos[1] - cfg.radius;
  const angle = (Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI);
  const lipOffset = (pos[0] - end.position[0]) * end.tangent[0]
    + (pos[1] - end.position[1]) * end.tangent[1];
  const candidates = [0, arcLength, arcLength + Math.max(0, lipOffset)];
  if (angle <= cfg.arcAngleRad) candidates.push(angle * cfg.radius);

  let closest = end;
  let minDistance = Infinity;
  for (const s of candidates) {
    const point = sampleRamp(s, cfg);
    const distance = (pos[0] - point.position[0]) ** 2 + (pos[1] - point.position[1]) ** 2;
    if (distance < minDistance) {
      closest = point;
      minDistance = distance;
    }
  }

  const signedDistance = (pos[0] - closest.position[0]) * closest.normal[0]
    + (pos[1] - closest.position[1]) * closest.normal[1];
  return {
    ...closest,
    signedDistance,
    onRamp: Math.abs(pos[2] - cfg.baseZ) <= cfg.width * 0.5
      && signedDistance >= -0.6 && signedDistance <= 1.25,
  };
}

export function getRampMeshProfile(segments = 96, cfg: RampConfig = ARENA_CONFIG.ramp): RampSample[] {
  const count = Math.max(1, Math.floor(segments));
  const length = getRampLength(cfg);
  return Array.from({ length: count + 1 }, (_, i) => sampleRamp(length * i / count, cfg));
}
