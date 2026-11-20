import './ui/styles.css';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SoundEngine } from './audio/soundEngine';
import { RoadsterPhysics } from './physics/roadsterPhysics';
import { StuntDirector } from './physics/stuntDirector';
import { ArenaEnvironment } from './scene/arenaEnvironment';
import { CameraRig } from './scene/cameraRig';
import { GhostTrail } from './scene/ghostTrail';
import { RampMesh } from './scene/rampMesh';
import { RoadsterModel } from './scene/roadsterModel';
import { ThrusterVfx } from './scene/thrusterVfx';
import type { CameraMode, CarState, ControlInput, GameMode, GhostSnapshot } from './types';
import { HudManager } from './ui/hud';

const FIXED_DT = 1 / 120;
const MAX_FRAME_DT = 0.05;
const MAX_SUBSTEPS = 8;
const CAMERA_ORDER: readonly CameraMode[] = ['ramp', 'chase', 'rear', 'orbit'];

const appEl = document.getElementById('app');
if (!appEl) {
  throw new Error('Missing #app root container');
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(44, window.innerWidth / Math.max(1, window.innerHeight), 0.2, 420);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
appEl.appendChild(renderer.domElement);

const composer = new EffectComposer(renderer);
composer.setPixelRatio(renderer.getPixelRatio());
const renderPass = new RenderPass(scene, camera);
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.42,
  0.35,
  0.88,
);
const outputPass = new OutputPass();
composer.addPass(renderPass);
composer.addPass(bloomPass);
composer.addPass(outputPass);

const arena = new ArenaEnvironment(scene);
const rampMesh = new RampMesh();
const roadsterModel = new RoadsterModel();
const thrusterVfx = new ThrusterVfx(roadsterModel.getAsset());
const ghostTrail = new GhostTrail(roadsterModel.getAsset());
const cameraRig = new CameraRig(camera, renderer.domElement);
const soundEngine = new SoundEngine();

scene.add(arena.group);
scene.add(rampMesh.group);
scene.add(roadsterModel.group);
scene.add(thrusterVfx.group);
scene.add(ghostTrail.group);

const physics = new RoadsterPhysics('demo');
const stuntDirector = new StuntDirector();

let mode: GameMode = 'demo';
let cameraMode: CameraMode = 'ramp';
let ghostEnabled = true;
let auroraEnabled = false;
let muted = false;
let paused = false;
let started = false;

let suctionOn = true;
let flightAssistOn = true;
let lastDemoSnapshotCount = 0;
let playerSnapshots: GhostSnapshot[] = [];
let lastPlayerSnapTime = -1;
let playerAirElapsed = 0;
let prevState: CarState = physics.getState();

arena.setAuroraEnabled(auroraEnabled);
ghostTrail.setVisible(ghostEnabled);

const keys = new Set<string>();

function syncAllState(resetSim: boolean): void {
  if (resetSim) {
    physics.reset(mode);
    stuntDirector.reset();
    thrusterVfx.reset();
    ghostTrail.clear();
    lastDemoSnapshotCount = 0;
    playerSnapshots = [];
    lastPlayerSnapTime = -1;
    playerAirElapsed = 0;
    suctionOn = mode !== 'free';
    flightAssistOn = true;
    prevState = physics.getState();
    roadsterModel.update(prevState, 0);
  }
  arena.setAuroraEnabled(auroraEnabled);
  ghostTrail.setVisible(ghostEnabled);
  cameraRig.setMode(cameraMode);
  soundEngine.setMuted(muted);
}

function selectMode(nextMode: GameMode, shouldStart = true): void {
  mode = nextMode;
  if (shouldStart) {
    started = true;
    hud.dismissWelcome();
  }
  paused = false;
  syncAllState(true);
}

function selectCamera(nextCam: CameraMode): void {
  cameraMode = nextCam;
  cameraRig.setMode(cameraMode);
}

function cycleCamera(): void {
  const idx = CAMERA_ORDER.indexOf(cameraMode);
  selectCamera(CAMERA_ORDER[(idx + 1) % CAMERA_ORDER.length]);
}

function isPressed(...codes: string[]): boolean {
  for (const c of codes) {
    if (keys.has(c)) return true;
  }
  return false;
}

function buildManualInput(state: CarState): ControlInput {
  const wDown = isPressed('KeyW', 'ArrowUp');
  const sDown = isPressed('KeyS', 'ArrowDown');
  const aDown = isPressed('KeyA', 'ArrowLeft');
  const dDown = isPressed('KeyD', 'ArrowRight');

  const throttle = wDown ? 1 : 0;
  const brake = sDown ? 1 : 0;
  const steer = (aDown ? 1 : 0) - (dDown ? 1 : 0);

  let pitch = (isPressed('KeyK') ? 1 : 0) - (isPressed('KeyI') ? 1 : 0);
  if (!state.grounded && pitch === 0) {
    pitch = (isPressed('ArrowDown') ? 1 : 0) - (isPressed('ArrowUp') ? 1 : 0);
  }

  let roll = (isPressed('KeyE') ? 1 : 0) - (isPressed('KeyQ') ? 1 : 0);
  let yaw = 0;
  if (!state.grounded) {
    yaw = steer;
    if (roll === 0 && (isPressed('ArrowLeft') || isPressed('ArrowRight'))) {
      roll = (isPressed('ArrowRight') ? 1 : 0) - (isPressed('ArrowLeft') ? 1 : 0);
      yaw = 0;
    }
  }

  return {
    throttle,
    brake,
    steer,
    pitch,
    roll,
    yaw,
    hoverLift: isPressed('Space') ? 1 : 0,
    rearBoost: isPressed('ShiftLeft', 'ShiftRight'),
    retroBrake: isPressed('KeyX'),
    suctionActive: suctionOn,
    flightAssist: flightAssistOn,
  };
}

function recordPlayerSnapshot(state: CarState, dt: number): void {
  if (state.phase === 'ready' || state.phase === 'landed' || state.phase === 'crashed') return;
  playerAirElapsed += dt;
  const minInterval = state.grounded ? 0.55 : 0.35;
  if (playerSnapshots.length >= 16) return;
  if (lastPlayerSnapTime >= 0 && playerAirElapsed - lastPlayerSnapTime < minInterval) return;

  const last = playerSnapshots[playerSnapshots.length - 1];
  if (last) {
    const dist = Math.hypot(
      state.position[0] - last.position[0],
      state.position[1] - last.position[1],
      state.position[2] - last.position[2],
    );
    if (dist < 4.5) return;
  }

  lastPlayerSnapTime = playerAirElapsed;
  playerSnapshots.push({
    position: [...state.position],
    quaternion: [...state.quaternion],
    thrusters: { ...state.thrusters },
    phase: state.phase,
    timestamp: playerAirElapsed,
  });
  ghostTrail.setSnapshots(playerSnapshots);
}

// Register welcome dismissal + audio unlock in capture phase BEFORE HudManager stops propagation.
const onUnlockPointer = (): void => {
  soundEngine.unlock();
};

const PREVENT_SCROLL_KEYS = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
]);

const onKeyDown = (event: KeyboardEvent): void => {
  soundEngine.unlock();

  if (!started && (event.code === 'Enter' || event.code === 'Space')) {
    event.preventDefault();
    started = true;
    hud.dismissWelcome();
    return;
  }

  if (started && PREVENT_SCROLL_KEYS.has(event.code)) {
    event.preventDefault();
  }

  if (event.repeat) return;

  switch (event.code) {
    case 'Digit1':
      selectCamera('ramp');
      break;
    case 'Digit2':
      selectCamera('chase');
      break;
    case 'Digit3':
      selectCamera('rear');
      break;
    case 'Digit4':
      selectCamera('orbit');
      break;
    case 'KeyC':
      cycleCamera();
      break;
    case 'KeyG':
      ghostEnabled = !ghostEnabled;
      ghostTrail.setVisible(ghostEnabled);
      break;
    case 'KeyB':
      auroraEnabled = !auroraEnabled;
      arena.setAuroraEnabled(auroraEnabled);
      break;
    case 'KeyM':
      muted = !muted;
      soundEngine.setMuted(muted);
      break;
    case 'KeyP':
      paused = !paused;
      break;
    case 'KeyR':
      selectMode(mode, true);
      break;
    case 'KeyV':
      hud.dismissWelcome();
      selectMode('demo', true);
      break;
    case 'KeyF':
      suctionOn = !suctionOn;
      break;
    case 'KeyH':
      flightAssistOn = !flightAssistOn;
      break;
    default:
      break;
  }

  keys.add(event.code);
};

const onKeyUp = (event: KeyboardEvent): void => {
  if (started && PREVENT_SCROLL_KEYS.has(event.code)) {
    event.preventDefault();
  }
  keys.delete(event.code);
};

const onBlur = (): void => {
  keys.clear();
};

const onResize = (): void => {
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(width, height);
};

window.addEventListener('pointerdown', onUnlockPointer);
window.addEventListener('keydown', onKeyDown, true);
window.addEventListener('keyup', onKeyUp);
window.addEventListener('blur', onBlur);
window.addEventListener('resize', onResize);

const hud = new HudManager(appEl, {
  onSelectMode: (nextMode) => {
    soundEngine.unlock();
    selectMode(nextMode, true);
  },
  onSelectCamera: (cam) => {
    soundEngine.unlock();
    selectCamera(cam);
  },
  onToggleGhost: () => {
    ghostEnabled = !ghostEnabled;
    ghostTrail.setVisible(ghostEnabled);
  },
  onToggleAurora: () => {
    auroraEnabled = !auroraEnabled;
    arena.setAuroraEnabled(auroraEnabled);
  },
  onToggleMute: () => {
    soundEngine.unlock();
    muted = !muted;
    soundEngine.setMuted(muted);
  },
  onTogglePause: () => {
    paused = !paused;
  },
  onReset: () => {
    soundEngine.unlock();
    selectMode(mode, true);
  },
});

syncAllState(true);

let accumulator = 0;
let lastTimeMs = performance.now();
let elapsedSec = 0;
let rafId = 0;
let disposed = false;

function handleLandingImpact(before: CarState, after: CarState): void {
  const becameGrounded = !before.grounded && after.grounded;
  const becameFinished = before.phase !== after.phase && (after.phase === 'landed' || after.phase === 'crashed');
  const bounced = before.velocity[1] < -2.2 && after.velocity[1] > 0.5 && after.altitude < 0.25;
  if (!becameGrounded && !becameFinished && !bounced) return;
  const impactSpeed = Math.max(1.2, Math.abs(before.velocity[1]));
  soundEngine.playTouchdown(impactSpeed);
  cameraRig.triggerLandingShake(Math.min(1.6, impactSpeed * 0.22));
}

function tick(nowMs: number): void {
  if (disposed) return;
  rafId = requestAnimationFrame(tick);

  const rawDt = (nowMs - lastTimeMs) / 1000;
  lastTimeMs = nowMs;
  const dt = Math.min(Math.max(rawDt, 0), MAX_FRAME_DT);

  if (!paused) {
    elapsedSec += dt;
    arena.update(elapsedSec);

    if (started) {
      accumulator += dt;
      let steps = 0;
      while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
        const current = physics.getState();
        const input =
          mode === 'demo'
            ? stuntDirector.getInput(current, FIXED_DT)
            : buildManualInput(current);
        const next = physics.step(FIXED_DT, input);
        handleLandingImpact(prevState, next);
        prevState = next;

        if (mode === 'demo') {
          const snapCount = stuntDirector.getSnapshotCount();
          if (snapCount !== lastDemoSnapshotCount) {
            lastDemoSnapshotCount = snapCount;
            ghostTrail.setSnapshots(stuntDirector.getGhostSnapshots());
          }
        } else {
          recordPlayerSnapshot(next, FIXED_DT);
        }

        accumulator -= FIXED_DT;
        steps += 1;
      }
      if (steps === MAX_SUBSTEPS) {
        accumulator = 0;
      }
    }
  }

  const state = physics.getState();
  const score = physics.getScore();
  roadsterModel.update(state, paused ? 0 : dt);
  thrusterVfx.update(state, paused ? 0 : dt);
  cameraRig.update(state, dt);
  soundEngine.update(paused ? { ...state, speedKmh: 0, thrusters: { ...state.thrusters, liftFL: 0, liftFR: 0, liftRL: 0, liftRR: 0, rearBoost: 0, retroFront: 0, rcsRollL: 0, rcsRollR: 0, rcsPitchUp: 0, rcsPitchDown: 0, suctionPower: 0, groundEffectIntensity: 0 } } : state, dt);
  hud.update(state, score, {
    mode,
    camera: cameraMode,
    ghostEnabled,
    auroraEnabled,
    flightAssist: flightAssistOn,
    muted,
    paused,
  });

  composer.render();
}

function disposeAll(): void {
  if (disposed) return;
  disposed = true;
  cancelAnimationFrame(rafId);
  window.removeEventListener('pointerdown', onUnlockPointer);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('blur', onBlur);
  window.removeEventListener('resize', onResize);
  window.removeEventListener('beforeunload', disposeAll);

  hud.dispose();
  soundEngine.dispose();
  cameraRig.dispose();
  ghostTrail.dispose();
  thrusterVfx.dispose();
  roadsterModel.dispose();
  rampMesh.dispose();
  arena.dispose();
  bloomPass.dispose();
  outputPass.dispose();
  composer.dispose();
  renderer.dispose();
  renderer.domElement.remove();
}

window.addEventListener('beforeunload', disposeAll);
rafId = requestAnimationFrame(tick);
