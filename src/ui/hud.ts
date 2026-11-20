import type { CameraMode, CarState, GameMode, SpoilerMode, StuntPhase, StuntScore } from '../types';

export interface HudCallbacks {
  onSelectMode: (mode: GameMode) => void;
  onSelectCamera: (cam: CameraMode) => void;
  onToggleGhost: () => void;
  onToggleAurora: () => void;
  onToggleMute: () => void;
  onTogglePause: () => void;
  onReset: () => void;
}

const PHASES: readonly StuntPhase[] = ['approach', 'climb', 'inverted', 'launch', 'flip', 'hover', 'landed'];
const PHASE_LABELS = ['APPROACH', 'CLIMB', 'INVERTED', 'LAUNCH', 'FLIP', 'HOVER', 'LANDED'] as const;
const SPOILER_LABEL: Record<SpoilerMode, string> = {
  road: 'ROAD',
  downforce: 'DOWNFORCE',
  airbrake: 'AIRBRAKE',
};
const HORIZON_UNITS_PER_DEG = 0.82;
const SUCTION_FULL_SCALE_KG = 4200;

let nextHudId = 1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function fixed(value: number, digits: number): string {
  const safe = finite(value);
  return safe.toFixed(digits);
}

function grouped(value: number): string {
  return Math.round(finite(value)).toLocaleString('en-US');
}

/**
 * Body frame is +X left, +Y up, +Z nose-forward. Quaternion is [x, y, z, w].
 * Returned roll is negative when the right wing drops.
 */
function attitudeFromQuaternion(q: readonly [number, number, number, number]): { pitch: number; roll: number } {
  const len = Math.hypot(finite(q[0]), finite(q[1]), finite(q[2]), finite(q[3]));
  if (len < 1e-6) return { pitch: 0, roll: 0 };
  const x = finite(q[0]) / len;
  const y = finite(q[1]) / len;
  const z = finite(q[2]) / len;
  const w = finite(q[3]) / len;

  const forwardY = 2 * (y * z - w * x);
  const forwardX = 2 * (x * z + w * y);
  const forwardZ = 1 - 2 * (x * x + y * y);
  const upY = 1 - 2 * (x * x + z * z);
  const leftY = 2 * (x * y + w * z);

  return {
    pitch: Math.atan2(forwardY, Math.hypot(forwardX, forwardZ)),
    roll: Math.atan2(-leftY, upY),
  };
}

function phaseMarkup(): string {
  return PHASES.map((phase, index) => {
    const arrow =
      index < PHASES.length - 1 ? `<span class="hud-phase-arrow" data-phase-arrow>→</span>` : '';
    return `<div class="hud-phase" data-phase="${phase}" role="listitem">
      <span class="hud-phase-label">${PHASE_LABELS[index]}</span>
      <span class="hud-phase-seg"></span>
    </div>${arrow}`;
  }).join('');
}

function horizonMarkup(id: string): string {
  const ticks = [30, 20, 10, -10, -20, -30]
    .map((deg) => {
      const y = (50 - deg * HORIZON_UNITS_PER_DEG).toFixed(2);
      return `<g class="hud-horizon-tick" transform="translate(0 ${y})">
        <line x1="34" x2="66" />
        <text x="68" y="1.6">${Math.abs(deg)}</text>
      </g>`;
    })
    .join('');
  return `<svg class="hud-horizon-svg" viewBox="0 0 100 100" aria-hidden="true">
    <defs>
      <clipPath id="${id}-clip"><circle cx="50" cy="50" r="42" /></clipPath>
      <linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#071018" />
        <stop offset="1" stop-color="#1c6f90" />
      </linearGradient>
      <linearGradient id="${id}-ground" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#8d6840" />
        <stop offset="1" stop-color="#1c140e" />
      </linearGradient>
    </defs>
    <circle class="hud-horizon-well" cx="50" cy="50" r="46" />
    <g clip-path="url(#${id}-clip)">
      <g data-el="horizon-rot">
        <g data-el="horizon-pitch">
          <rect class="hud-horizon-sky" x="-40" y="-130" width="180" height="180" fill="url(#${id}-sky)" />
          <rect class="hud-horizon-ground" x="-40" y="50" width="180" height="180" fill="url(#${id}-ground)" />
          <line class="hud-horizon-line" x1="-20" y1="50" x2="120" y2="50" />
          ${ticks}
        </g>
      </g>
    </g>
    <circle class="hud-horizon-bezel" cx="50" cy="50" r="42" />
    <path class="hud-horizon-pointer" d="M50 6.5 L46.8 12.2 H53.2 Z" />
    <g class="hud-horizon-wings">
      <line x1="16" y1="50" x2="38" y2="50" />
      <line x1="62" y1="50" x2="84" y2="50" />
      <line x1="38" y1="50" x2="45" y2="55" />
      <line x1="62" y1="50" x2="55" y2="55" />
      <circle cx="50" cy="50" r="1.3" />
    </g>
  </svg>`;
}

function shell(id: string): string {
  return `<div class="hud-welcome" data-el="welcome" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
    <div class="hud-welcome-card">
      <p class="hud-kicker">Tesla Roadster · SpaceX cold-gas</p>
      <h1 class="hud-title" id="${id}-title">THE RAMP // 2026 ROADSTER</h1>
      <p class="hud-welcome-copy">Climb the loop on the underbody suction fans and stay planted through the inverted arc. Over the lip, the SpaceX cold-gas nitrogen thrusters flip the car, hold the hover, and plant the landing.</p>
      <div class="hud-welcome-actions">
        <button type="button" class="hud-btn hud-btn-primary" data-action="mode" data-mode="demo" data-dismiss="1">▶ RECREATE 'THE RAMP' (Demo)</button>
        <button type="button" class="hud-btn hud-btn-secondary" data-action="mode" data-mode="play" data-dismiss="1">🎮 DRIVE IT YOURSELF</button>
        <button type="button" class="hud-btn hud-btn-quiet" data-action="mode" data-mode="free" data-dismiss="1">🛫 FREE FLIGHT</button>
      </div>
      <p class="hud-welcome-hint"><kbd>Enter</kbd> <kbd>Space</kbd> dismiss</p>
    </div>
  </div>
  <header class="hud-top">
    <div class="hud-controls">
      <div class="hud-group" role="group" aria-label="Mode">
        <span class="hud-group-label">Mode</span>
        <button type="button" class="hud-pill" data-action="mode" data-mode="demo">Demo</button>
        <button type="button" class="hud-pill" data-action="mode" data-mode="play">Play Stunt</button>
        <button type="button" class="hud-pill" data-action="mode" data-mode="free">Free Flight</button>
      </div>
      <div class="hud-group" role="group" aria-label="Camera">
        <span class="hud-group-label">Cam</span>
        <button type="button" class="hud-pill" data-action="camera" data-camera="ramp">1 Ramp</button>
        <button type="button" class="hud-pill" data-action="camera" data-camera="chase">2 Chase</button>
        <button type="button" class="hud-pill" data-action="camera" data-camera="rear">3 Rear</button>
        <button type="button" class="hud-pill" data-action="camera" data-camera="orbit">4 Orbit</button>
      </div>
      <div class="hud-group" role="group" aria-label="Utilities">
        <span class="hud-group-label">Sys</span>
        <button type="button" class="hud-pill" data-action="ghost" aria-pressed="false">G Trail</button>
        <button type="button" class="hud-pill" data-action="aurora" aria-pressed="false">B Aurora</button>
        <button type="button" class="hud-pill hud-pill-caution" data-action="pause" aria-pressed="false">P Pause</button>
        <button type="button" class="hud-pill hud-pill-caution" data-action="mute" aria-pressed="false">M Mute</button>
        <button type="button" class="hud-pill" data-action="reset">R Reset</button>
      </div>
    </div>
    <div class="hud-status">
      <div class="hud-live" data-el="live-flag">SYS // LIVE</div>
      <div class="hud-phasebar" data-el="phasebar" role="list" aria-label="Stunt phase">
        ${phaseMarkup()}
      </div>
      <div class="hud-crashed-flag" data-el="phase-crashed" hidden>CRASHED</div>
      <section class="hud-score" data-el="score" aria-hidden="true">
        <div class="hud-score-head">
          <span class="hud-kicker">Stunt Grade</span>
          <strong class="hud-grade" data-el="grade" data-grade="D">D</strong>
        </div>
        <dl class="hud-score-grid">
          <div><dt>Inverted Time</dt><dd data-el="stat-invert">0.00 s</dd></div>
          <div><dt>Peak Height</dt><dd data-el="stat-height">0.0 m</dd></div>
          <div><dt>Flip</dt><dd data-el="stat-flip">0°</dd></div>
          <div><dt>Touchdown</dt><dd data-el="stat-td">0.0 m/s</dd></div>
          <div class="hud-score-total"><dt>Score</dt><dd data-el="stat-score">0</dd></div>
        </dl>
        <div class="hud-score-actions">
          <button type="button" class="hud-btn hud-btn-primary hud-btn-compact" data-action="mode" data-mode="demo">Replay Demo</button>
          <button type="button" class="hud-btn hud-btn-secondary hud-btn-compact" data-action="mode" data-mode="play">Play Again</button>
        </div>
      </section>
    </div>
  </header>
  <footer class="hud-bottom">
    <section class="hud-telemetry" aria-label="Vehicle telemetry">
      <div class="hud-panel hud-readouts">
        <div class="hud-readout">
          <span class="hud-readout-label">Speed</span>
          <span class="hud-readout-value" data-el="speed">0</span>
          <span class="hud-readout-unit">km/h</span>
        </div>
        <div class="hud-readout">
          <span class="hud-readout-label">Altitude</span>
          <span class="hud-readout-value hud-readout-value-alt" data-el="altitude">0.0</span>
          <span class="hud-readout-unit">m</span>
        </div>
      </div>
      <div class="hud-panel hud-horizon" aria-label="Artificial horizon">
        ${horizonMarkup(id)}
        <div class="hud-horizon-readout"><span data-el="pitch">P +0</span><span data-el="roll">R +0</span></div>
      </div>
      <div class="hud-panel hud-suction" data-el="suction">
        <div class="hud-panel-head">
          <svg class="hud-fan" viewBox="0 0 24 24" aria-hidden="true">
            <circle class="hud-fan-ring" cx="12" cy="12" r="10" />
            <g class="hud-fan-blades">
              <path d="M12 12 C13 8 16 5.5 12 2 C8 5.5 11 8 12 12Z" />
              <path d="M12 12 C16 13 18.5 16 22 12 C18.5 8 16 11 12 12Z" />
              <path d="M12 12 C11 16 8 18.5 12 22 C16 18.5 13 16 12 12Z" />
              <path d="M12 12 C8 11 5.5 8 2 12 C5.5 16 8 13 12 12Z" />
            </g>
            <circle class="hud-fan-hub" cx="12" cy="12" r="1.7" />
          </svg>
          <span class="hud-panel-title">Suction Fan</span>
          <span class="hud-badge" data-el="suction-badge">OFF</span>
        </div>
        <div class="hud-meter" role="meter" aria-label="Downforce" aria-valuemin="0" aria-valuemax="${SUCTION_FULL_SCALE_KG}" aria-valuenow="0" data-el="df-meter">
          <span class="hud-meter-fill hud-meter-fill-amber" data-el="df-fill"></span>
        </div>
        <div class="hud-meter-label"><span>Downforce</span><span data-el="df-kg">0 kg</span></div>
      </div>
      <div class="hud-panel hud-copv">
        <div class="hud-panel-head">
          <span class="hud-panel-title">COPV Nitrogen</span>
          <span class="hud-badge hud-badge-cyan" data-el="copv-pct">100%</span>
        </div>
        <div class="hud-meter" role="meter" aria-label="COPV nitrogen" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100" data-el="copv-meter">
          <span class="hud-meter-fill hud-meter-fill-cyan" data-el="copv-fill"></span>
        </div>
        <div class="hud-meter-label"><span>N₂ tank</span><span data-el="copv-state">FULL</span></div>
      </div>
      <div class="hud-panel hud-systems">
        <div class="hud-sys-row">
          <span class="hud-panel-title">Active Spoiler</span>
          <span class="hud-badge" data-el="spoiler" data-spoiler="road">ROAD</span>
        </div>
        <div class="hud-sys-note" data-el="spoiler-angle">0°</div>
        <div class="hud-sys-row">
          <span class="hud-panel-title">Flight Assist</span>
          <span class="hud-badge" data-el="assist">STBY</span>
        </div>
      </div>
    </section>
    <aside class="hud-help" data-el="help">
      <button type="button" class="hud-help-toggle" data-action="help" aria-expanded="true" aria-controls="${id}-help">
        <span>Controls</span><span data-el="help-chevron" aria-hidden="true">▾</span>
      </button>
      <div class="hud-help-body" id="${id}-help">
        <ul class="hud-help-list">
          <li><span>Drive</span><span><kbd>W</kbd><kbd>S</kbd> or <kbd>↑</kbd><kbd>↓</kbd></span></li>
          <li><span>Steer</span><span><kbd>A</kbd><kbd>D</kbd> or <kbd>←</kbd><kbd>→</kbd></span></li>
          <li><span>Boost</span><span><kbd>Shift</kbd></span></li>
          <li><span>Suction</span><span><kbd>F</kbd></span></li>
          <li><span>Hover Thrusters</span><span><kbd>Space</kbd></span></li>
          <li><span>Retro-Brake</span><span><kbd>X</kbd></span></li>
          <li><span>Mid-Air Flip/Roll</span><span><kbd>Q</kbd><kbd>E</kbd></span></li>
          <li><span>Pitch</span><span><kbd>I</kbd><kbd>K</kbd> or arrows in air</span></li>
          <li><span>Cam</span><span><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><kbd>4</kbd></span></li>
          <li><span>Trail</span><span><kbd>G</kbd></span></li>
          <li><span>Reset</span><span><kbd>R</kbd></span></li>
        </ul>
      </div>
    </aside>
  </footer>`;
}

export class HudManager {
  private readonly root: HTMLElement;
  private readonly callbacks: HudCallbacks;
  private welcomeOpen = true;
  private readonly welcome: HTMLElement;
  private readonly phaseItems: HTMLElement[];
  private readonly phaseArrows: HTMLElement[];
  private readonly phaseBar: HTMLElement;
  private readonly scoreCard: HTMLElement;
  private readonly help: HTMLElement;
  private readonly helpToggle: HTMLButtonElement;
  private readonly horizonRot: SVGGElement;
  private readonly horizonPitch: SVGGElement;

  private readonly onKey = (event: KeyboardEvent): void => {
    if (!this.welcomeOpen) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('button')) return;
    event.preventDefault();
    event.stopPropagation();
    this.dismissWelcome();
  };

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest('button');
    if (!(button instanceof HTMLButtonElement) || !this.root.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    this.dispatch(button);
    button.blur();
  };

  constructor(container: HTMLElement, callbacks: HudCallbacks) {
    this.callbacks = callbacks;
    const id = `hud${nextHudId}`;
    nextHudId += 1;
    const root = document.createElement('div');
    root.className = 'hud-root';
    root.innerHTML = shell(id);
    container.appendChild(root);
    this.root = root;
    this.welcome = this.must('[data-el="welcome"]');
    this.phaseBar = this.must('[data-el="phasebar"]');
    this.scoreCard = this.must('[data-el="score"]');
    this.help = this.must('[data-el="help"]');
    const toggle = this.must('.hud-help-toggle');
    if (!(toggle instanceof HTMLButtonElement)) throw new Error('HUD help toggle missing');
    this.helpToggle = toggle;
    this.phaseItems = [...root.querySelectorAll<HTMLElement>('[data-phase]')];
    this.phaseArrows = [...root.querySelectorAll<HTMLElement>('[data-phase-arrow]')];
    this.horizonRot = this.svg('[data-el="horizon-rot"]');
    this.horizonPitch = this.svg('[data-el="horizon-pitch"]');
    root.addEventListener('click', this.onClick);
    window.addEventListener('keydown', this.onKey, true);
    if (window.matchMedia('(max-width: 860px)').matches) this.setHelpOpen(false);
  }

  update(
    state: CarState,
    score: StuntScore,
    flags: {
      mode: GameMode;
      camera: CameraMode;
      ghostEnabled: boolean;
      auroraEnabled: boolean;
      flightAssist: boolean;
      muted: boolean;
      paused: boolean;
    },
  ): void {
    this.paintModes(flags.mode);
    this.paintCameras(flags.camera);
    this.paintToggle('ghost', flags.ghostEnabled);
    this.paintToggle('aurora', flags.auroraEnabled);
    this.paintToggle('pause', flags.paused);
    this.paintToggle('mute', flags.muted);
    this.setText('[data-el="live-flag"]', flags.paused ? 'SYS // PAUSED' : 'SYS // LIVE');
    this.must('[data-el="live-flag"]').classList.toggle('is-paused', flags.paused);

    this.paintPhases(state.phase);
    this.paintScore(state.phase, score);
    this.paintTelemetry(state, flags.flightAssist);
    this.paintHorizon(state);
  }

  dismissWelcome(): void {
    if (!this.welcomeOpen) return;
    this.welcomeOpen = false;
    this.welcome.classList.add('is-dismissed');
    this.welcome.setAttribute('aria-hidden', 'true');
    this.welcome.inert = true;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.root.removeEventListener('click', this.onClick);
    this.root.remove();
  }

  private dispatch(button: HTMLButtonElement): void {
    const action = button.dataset.action;
    switch (action) {
      case 'mode': {
        const mode = button.dataset.mode;
        if (mode === 'demo' || mode === 'play' || mode === 'free') {
          this.callbacks.onSelectMode(mode);
          if (button.dataset.dismiss === '1') this.dismissWelcome();
        }
        break;
      }
      case 'camera': {
        const cam = button.dataset.camera;
        if (cam === 'ramp' || cam === 'chase' || cam === 'rear' || cam === 'orbit') {
          this.callbacks.onSelectCamera(cam);
        }
        break;
      }
      case 'ghost':
        this.callbacks.onToggleGhost();
        break;
      case 'aurora':
        this.callbacks.onToggleAurora();
        break;
      case 'pause':
        this.callbacks.onTogglePause();
        break;
      case 'mute':
        this.callbacks.onToggleMute();
        break;
      case 'reset':
        this.callbacks.onReset();
        break;
      case 'help':
        this.setHelpOpen(this.help.classList.contains('is-collapsed'));
        break;
      default:
        break;
    }
  }

  private paintModes(mode: GameMode): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-action="mode"][data-mode]').forEach((button) => {
      if (button.dataset.dismiss === '1' || button.closest('.hud-score')) return;
      const active = button.dataset.mode === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  private paintCameras(camera: CameraMode): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-action="camera"]').forEach((button) => {
      const active = button.dataset.camera === camera;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  private paintToggle(action: string, active: boolean): void {
    const button = this.root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
    if (!button) return;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  private paintPhases(phase: StuntPhase): void {
    const crashed = phase === 'crashed';
    const index = PHASES.indexOf(phase);
    this.phaseItems.forEach((item, itemIndex) => {
      item.classList.toggle('is-done', !crashed && index > itemIndex);
      item.classList.toggle('is-current', !crashed && index === itemIndex);
    });
    this.phaseArrows.forEach((arrow, arrowIndex) => {
      arrow.classList.toggle('is-done', !crashed && index > arrowIndex);
    });
    this.phaseBar.classList.toggle('is-crashed', crashed);
    const flag = this.must('[data-el="phase-crashed"]');
    flag.hidden = !crashed;
  }

  private paintScore(phase: StuntPhase, score: StuntScore): void {
    const visible = score.completed || phase === 'crashed';
    this.scoreCard.classList.toggle('is-visible', visible);
    this.scoreCard.classList.toggle('is-crashed', phase === 'crashed');
    this.scoreCard.setAttribute('aria-hidden', visible ? 'false' : 'true');
    const grade = this.must('[data-el="grade"]');
    this.setText('[data-el="grade"]', score.grade);
    grade.dataset.grade = score.grade;
    this.setText('[data-el="stat-invert"]', `${fixed(score.invertedSeconds, 2)} s`);
    this.setText('[data-el="stat-height"]', `${fixed(score.peakAltitudeM, 1)} m`);
    this.setText('[data-el="stat-flip"]', `${Math.round(finite(score.flipDegrees))}°`);
    this.setText('[data-el="stat-td"]', `${fixed(Math.abs(score.touchdownVerticalMs), 1)} m/s`);
    this.setText('[data-el="stat-score"]', grouped(score.totalScore));
  }

  private paintTelemetry(state: CarState, flightAssist: boolean): void {
    this.setText('[data-el="speed"]', grouped(Math.abs(state.speedKmh)));
    this.setText('[data-el="altitude"]', fixed(state.altitude, 1));

    const power = clamp(finite(state.thrusters.suctionPower), 0, 1);
    const kg = Math.max(0, finite(state.suctionDownforceKg));
    const suctionOn = power > 0.04 || kg > 8;
    const suction = this.must('[data-el="suction"]');
    suction.classList.toggle('is-on', suctionOn);
    this.setText('[data-el="suction-badge"]', suctionOn ? 'ON' : 'OFF');
    const dfRatio = clamp(Math.max(kg / SUCTION_FULL_SCALE_KG, suctionOn ? power * 0.12 : 0), 0, 1);
    this.setMeter('[data-el="df-fill"]', '[data-el="df-meter"]', dfRatio, Math.round(kg));
    this.setText('[data-el="df-kg"]', `${grouped(kg)} kg`);

    const copv = clamp(finite(state.copvPressure), 0, 100);
    this.setText('[data-el="copv-pct"]', `${Math.round(copv)}%`);
    this.setMeter('[data-el="copv-fill"]', '[data-el="copv-meter"]', copv / 100, Math.round(copv));
    const copvFill = this.must('[data-el="copv-fill"]');
    copvFill.classList.toggle('is-mid', copv < 45 && copv >= 20);
    copvFill.classList.toggle('is-low', copv < 20);
    this.setText('[data-el="copv-state"]', copv < 20 ? 'LOW' : copv < 45 ? 'HOLD' : 'NOMINAL');

    const spoiler = this.must('[data-el="spoiler"]');
    this.setText('[data-el="spoiler"]', SPOILER_LABEL[state.spoilerMode]);
    spoiler.dataset.spoiler = state.spoilerMode;
    const angleDeg = (finite(state.spoilerAngle) * 180) / Math.PI;
    this.setText('[data-el="spoiler-angle"]', `${Math.round(angleDeg)}°`);

    const assist = this.must('[data-el="assist"]');
    let assistLabel = 'STBY';
    if (!flightAssist || state.phase === 'crashed') assistLabel = 'OFF';
    else if (!state.grounded) assistLabel = 'ACTIVE';
    this.setText('[data-el="assist"]', assistLabel);
    assist.classList.toggle('is-on', assistLabel === 'ACTIVE');
    assist.classList.toggle('is-off', assistLabel === 'OFF');
  }

  private paintHorizon(state: CarState): void {
    const { pitch, roll } = attitudeFromQuaternion(state.quaternion);
    const pitchDeg = (pitch * 180) / Math.PI;
    const rollDeg = (roll * 180) / Math.PI;
    this.horizonRot.setAttribute('transform', `rotate(${rollDeg.toFixed(2)} 50 50)`);
    this.horizonPitch.setAttribute('transform', `translate(0 ${(pitchDeg * HORIZON_UNITS_PER_DEG).toFixed(2)})`);
    this.setText('[data-el="pitch"]', `P ${signed(pitchDeg)}`);
    this.setText('[data-el="roll"]', `R ${signed(rollDeg)}`);
  }

  private setHelpOpen(open: boolean): void {
    this.help.classList.toggle('is-collapsed', !open);
    this.helpToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    this.setText('[data-el="help-chevron"]', open ? '▾' : '▸');
  }

  private setMeter(fillSelector: string, meterSelector: string, ratio: number, valueNow: number): void {
    const fill = this.must(fillSelector);
    const width = `${(clamp(ratio, 0, 1) * 100).toFixed(1)}%`;
    if (fill.style.width !== width) fill.style.width = width;
    this.must(meterSelector).setAttribute('aria-valuenow', String(valueNow));
  }

  private setText(selector: string, value: string): void {
    const node = this.must(selector);
    if (node.textContent !== value) node.textContent = value;
  }

  private svg(selector: string): SVGGElement {
    const node = this.root.querySelector(selector);
    if (!(node instanceof SVGGElement)) throw new Error(`HUD node missing: ${selector}`);
    return node;
  }

  private must(selector: string): HTMLElement {
    const node = this.root.querySelector(selector);
    if (!(node instanceof HTMLElement)) throw new Error(`HUD node missing: ${selector}`);
    return node;
  }
}

function signed(degrees: number): string {
  const rounded = Math.round(finite(degrees));
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}
