import type { CarState, ThrusterState } from '../types';

const MASTER_OPEN = 0.78;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/** 0..1 signals pass through; larger physics units compress instead of slamming the mix. */
function unit(value: number): number {
  const v = Math.max(0, finite(value));
  return v <= 1 ? v : v / (v + 1);
}

function smoothstep(value: number, edge0: number, edge1: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function createContext(): AudioContext | null {
  const legacy = window as Window & { webkitAudioContext?: typeof AudioContext };
  const Ctor = window.AudioContext ?? legacy.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor({ latencyHint: 'interactive' });
  } catch {
    try {
      return new Ctor();
    } catch {
      return null;
    }
  }
}

function makeBuffer(ctx: AudioContext, seconds: number, fill: (data: Float32Array) => void): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  fill(buffer.getChannelData(0));
  return buffer;
}

function fillWhite(data: Float32Array): void {
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
}

/** Paul Kellet pink-noise filter. Turbine roar reads better than raw white noise. */
function fillPink(data: Float32Array): void {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < data.length; i += 1) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
}

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  bus: GainNode;
  powerGain: GainNode;
  powerSine: OscillatorNode;
  powerTri: OscillatorNode;
  suctionGain: GainNode;
  suctionFilter: BiquadFilterNode;
  suctionHum: OscillatorNode;
  suctionHumGain: GainNode;
  hissGain: GainNode;
  hissHighpass: BiquadFilterNode;
  hissBandpass: BiquadFilterNode;
  rumbleGain: GainNode;
  rumbleOsc: OscillatorNode;
  rumbleNoiseGain: GainNode;
  rumbleLowpass: BiquadFilterNode;
  white: AudioBuffer;
}

/**
 * Procedural vehicle synthesizer. No sample files.
 * `unlock()` must run inside a click/keydown so Safari and Chrome leave the suspended state.
 */
export class SoundEngine {
  private graph: Graph | null = null;
  private muted = false;
  private disposed = false;
  private sources: AudioScheduledSourceNode[] = [];
  private paramState = new Map<string, number>();
  private speed = 0;
  private suction = 0;
  private hiss = 0;
  private rumble = 0;
  private prevRcs = 0;
  private nextPuffAt = 0;
  private nextTouchdownAt = 0;

  unlock(): void {
    if (this.disposed) return;
    if (!this.graph) {
      const ctx = createContext();
      if (!ctx) return;
      this.graph = this.buildGraph(ctx);
    }
    if (this.graph.ctx.state === 'suspended') {
      void this.graph.ctx.resume().catch(() => {
        /* A later gesture can call unlock() again. */
      });
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMaster();
  }

  isMuted(): boolean {
    return this.muted;
  }

  update(state: CarState, dt: number): void {
    if (this.disposed) return;
    const step = clamp(finite(dt), 0, 0.25);
    const speed = Math.abs(finite(state.speedKmh));
    const thrusters = state.thrusters;
    const suctionTarget = unit(thrusters.suctionPower);
    const mix = this.thrusterMix(thrusters);
    const blend = 1 - Math.exp(-step / 0.06);
    this.speed += (speed - this.speed) * (1 - Math.exp(-step / 0.09));
    this.suction += (suctionTarget - this.suction) * (1 - Math.exp(-step / 0.12));
    this.hiss += (mix.hiss - this.hiss) * blend;
    this.rumble += (mix.rumble - this.rumble) * (1 - Math.exp(-step / 0.1));

    const rcsRise = Math.max(0, mix.rcs - this.prevRcs);
    this.prevRcs = mix.rcs;
    if (rcsRise > 0.1) this.puffRcs(rcsRise, unit(state.copvPressure / 100));

    const graph = this.graph;
    if (!graph) return;
    this.writePowertrain(graph);
    this.writeSuction(graph);
    this.writeThrusters(graph, mix, unit(state.copvPressure / 100));
  }

  playTouchdown(verticalSpeedMs: number): void {
    const graph = this.graph;
    if (!graph || this.disposed || this.muted) return;
    const now = graph.ctx.currentTime;
    if (now < this.nextTouchdownAt) return;
    this.nextTouchdownAt = now + 0.26;

    const impact = clamp(Math.abs(finite(verticalSpeedMs)), 0, 16);
    const strength = clamp(0.28 + impact / 7.5, 0.28, 1);
    const startHz = 78 + strength * 46;

    this.toneThud(graph, startHz, 30, 0.22 + strength * 0.55, 0.26);
    this.noiseHit(graph, {
      type: 'lowpass',
      freq: 180,
      endFreq: 70,
      q: 0.7,
      peak: 0.34 * strength,
      attack: 0.008,
      release: 0.09,
      duration: 0.1,
    });
    this.noiseHit(graph, {
      type: 'bandpass',
      freq: 1400 + strength * 1600,
      endFreq: 900 + strength * 400,
      q: 5.2,
      peak: 0.22 + strength * 0.28,
      attack: 0.012,
      release: 0.15,
      duration: 0.18,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const source of [...this.sources]) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* Already stopped. */
      }
      source.disconnect();
    }
    this.sources = [];
    const ctx = this.graph?.ctx;
    this.graph = null;
    this.paramState.clear();
    if (ctx && ctx.state !== 'closed') void ctx.close();
  }

  private thrusterMix(thrusters: ThrusterState): { hiss: number; rumble: number; rcs: number; boost: number; lift: number } {
    const lift = clamp(
      (unit(thrusters.liftFL) + unit(thrusters.liftFR) + unit(thrusters.liftRL) + unit(thrusters.liftRR)) / 4,
      0,
      1,
    );
    const rcs = clamp(
      unit(thrusters.rcsRollL) + unit(thrusters.rcsRollR) + unit(thrusters.rcsPitchUp) + unit(thrusters.rcsPitchDown),
      0,
      1,
    );
    const boost = unit(thrusters.rearBoost);
    const retro = unit(thrusters.retroFront);
    return {
      lift,
      rcs,
      boost,
      hiss: clamp(lift * 0.74 + retro * 0.92 + rcs * 1.2 + boost * 0.3, 0, 1),
      rumble: clamp(lift * 0.82 + boost * 1 + retro * 0.58 + rcs * 0.24, 0, 1),
    };
  }

  private buildGraph(ctx: AudioContext): Graph {
    const master = ctx.createGain();
    master.gain.setValueAtTime(this.muted ? 0 : MASTER_OPEN, ctx.currentTime);

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 10;
    compressor.ratio.value = 3.2;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.16;

    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(compressor);
    compressor.connect(master);
    master.connect(ctx.destination);

    const white = makeBuffer(ctx, 2, fillWhite);
    const pink = makeBuffer(ctx, 2, fillPink);

    const powerGain = ctx.createGain();
    powerGain.gain.setValueAtTime(0, ctx.currentTime);
    const powerSine = ctx.createOscillator();
    powerSine.type = 'sine';
    powerSine.frequency.setValueAtTime(90, ctx.currentTime);
    const powerTri = ctx.createOscillator();
    powerTri.type = 'triangle';
    powerTri.frequency.setValueAtTime(180, ctx.currentTime);
    const sineMix = ctx.createGain();
    sineMix.gain.value = 0.72;
    const triMix = ctx.createGain();
    triMix.gain.value = 0.28;
    powerSine.connect(sineMix);
    powerTri.connect(triMix);
    sineMix.connect(powerGain);
    triMix.connect(powerGain);
    powerGain.connect(bus);

    const suctionGain = ctx.createGain();
    suctionGain.gain.setValueAtTime(0, ctx.currentTime);
    const suctionFilter = ctx.createBiquadFilter();
    suctionFilter.type = 'bandpass';
    suctionFilter.frequency.setValueAtTime(240, ctx.currentTime);
    suctionFilter.Q.value = 1.35;
    const suctionSource = this.loop(ctx, pink);
    suctionSource.connect(suctionFilter);
    suctionFilter.connect(suctionGain);
    suctionGain.connect(bus);

    const suctionHum = ctx.createOscillator();
    suctionHum.type = 'sine';
    suctionHum.frequency.setValueAtTime(46, ctx.currentTime);
    const suctionHumGain = ctx.createGain();
    suctionHumGain.gain.setValueAtTime(0, ctx.currentTime);
    suctionHum.connect(suctionHumGain);
    suctionHumGain.connect(bus);

    const hissGain = ctx.createGain();
    hissGain.gain.setValueAtTime(0, ctx.currentTime);
    const hissHighpass = ctx.createBiquadFilter();
    hissHighpass.type = 'highpass';
    hissHighpass.frequency.setValueAtTime(1800, ctx.currentTime);
    hissHighpass.Q.value = 0.7;
    const hissBandpass = ctx.createBiquadFilter();
    hissBandpass.type = 'bandpass';
    hissBandpass.frequency.setValueAtTime(4600, ctx.currentTime);
    hissBandpass.Q.value = 0.85;
    const hissSource = this.loop(ctx, white);
    hissSource.connect(hissHighpass);
    hissHighpass.connect(hissBandpass);
    hissBandpass.connect(hissGain);
    hissGain.connect(bus);

    const rumbleGain = ctx.createGain();
    rumbleGain.gain.setValueAtTime(0, ctx.currentTime);
    const rumbleOsc = ctx.createOscillator();
    rumbleOsc.type = 'sine';
    rumbleOsc.frequency.setValueAtTime(36, ctx.currentTime);
    const rumbleOscGain = ctx.createGain();
    rumbleOscGain.gain.value = 0.62;
    rumbleOsc.connect(rumbleOscGain);
    rumbleOscGain.connect(rumbleGain);

    const rumbleLowpass = ctx.createBiquadFilter();
    rumbleLowpass.type = 'lowpass';
    rumbleLowpass.frequency.value = 140;
    rumbleLowpass.Q.value = 0.6;
    const rumbleNoiseGain = ctx.createGain();
    rumbleNoiseGain.gain.value = 0.55;
    const rumbleSource = this.loop(ctx, white);
    rumbleSource.connect(rumbleLowpass);
    rumbleLowpass.connect(rumbleNoiseGain);
    rumbleNoiseGain.connect(rumbleGain);
    rumbleGain.connect(bus);

    powerSine.start();
    powerTri.start();
    suctionHum.start();
    rumbleOsc.start();
    for (const osc of [powerSine, powerTri, suctionHum, rumbleOsc]) this.sources.push(osc);

    return {
      ctx,
      master,
      bus,
      powerGain,
      powerSine,
      powerTri,
      suctionGain,
      suctionFilter,
      suctionHum,
      suctionHumGain,
      hissGain,
      hissHighpass,
      hissBandpass,
      rumbleGain,
      rumbleOsc,
      rumbleNoiseGain,
      rumbleLowpass,
      white,
    };
  }

  private loop(ctx: AudioContext, buffer: AudioBuffer): AudioBufferSourceNode {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.start();
    this.sources.push(source);
    return source;
  }

  private applyMaster(): void {
    const graph = this.graph;
    if (!graph) return;
    this.target(graph.master.gain, 'master', this.muted ? 0 : MASTER_OPEN, 0.03, 0.0001);
  }

  private writePowertrain(graph: Graph): void {
    const speed = this.speed;
    const freq = clamp(86 + speed * 7.35, 86, 1680);
    const drive = smoothstep(speed, 0.4, 14);
    const gain = 0.01 + drive * 0.11 + smoothstep(speed, 28, 170) * 0.05;
    this.target(graph.powerSine.frequency, 'power-f', freq, 0.05, 0.8);
    this.target(graph.powerTri.frequency, 'power-h', freq * 2, 0.05, 1.5);
    this.target(graph.powerGain.gain, 'power-g', gain, 0.06, 0.001);
  }

  private writeSuction(graph: Graph): void {
    const power = clamp(this.suction, 0, 1);
    this.target(graph.suctionFilter.frequency, 'suction-f', 170 + power * 560, 0.08, 1);
    this.target(graph.suctionGain.gain, 'suction-g', power * 0.42, 0.09, 0.001);
    this.target(graph.suctionHum.frequency, 'hum-f', 40 + power * 34, 0.1, 0.4);
    this.target(graph.suctionHumGain.gain, 'hum-g', power * 0.1, 0.09, 0.001);
  }

  private writeThrusters(
    graph: Graph,
    mix: { hiss: number; rumble: number; rcs: number; boost: number; lift: number },
    pressure: number,
  ): void {
    const presence = 0.62 + 0.38 * clamp(pressure, 0, 1);
    const hiss = clamp(this.hiss, 0, 1);
    const rumble = clamp(this.rumble, 0, 1);
    this.target(graph.hissHighpass.frequency, 'hiss-hp', 1500 + hiss * 1600 + mix.rcs * 700, 0.04, 8);
    this.target(graph.hissBandpass.frequency, 'hiss-bp', 3600 + hiss * 2400 + mix.rcs * 800, 0.04, 12);
    this.target(graph.hissGain.gain, 'hiss-g', hiss * 0.5 * presence, 0.035, 0.001);
    this.target(graph.rumbleOsc.frequency, 'rumble-f', 32 + mix.boost * 12 + mix.lift * 8, 0.08, 0.3);
    this.target(graph.rumbleGain.gain, 'rumble-g', rumble * 0.46, 0.07, 0.001);
  }

  private puffRcs(rise: number, pressure: number): void {
    const graph = this.graph;
    if (!graph || this.muted) return;
    const now = graph.ctx.currentTime;
    if (now < this.nextPuffAt) return;
    this.nextPuffAt = now + 0.07;
    this.noiseHit(graph, {
      type: 'bandpass',
      freq: 5200 + rise * 1800,
      endFreq: 3400,
      q: 2.4,
      peak: (0.08 + rise * 0.22) * (0.55 + 0.45 * pressure),
      attack: 0.006,
      release: 0.07,
      duration: 0.09,
    });
  }

  private toneThud(graph: Graph, startHz: number, endHz: number, peak: number, release: number): void {
    const now = graph.ctx.currentTime;
    const osc = graph.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(Math.max(28, startHz), now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(24, endHz), now + release);
    const gain = graph.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + release);
    osc.connect(gain);
    gain.connect(graph.bus);
    osc.start(now);
    osc.stop(now + release + 0.03);
    this.watch(osc, () => {
      osc.disconnect();
      gain.disconnect();
    });
  }

  private noiseHit(
    graph: Graph,
    opts: {
      type: BiquadFilterType;
      freq: number;
      endFreq: number;
      q: number;
      peak: number;
      attack: number;
      release: number;
      duration: number;
    },
  ): void {
    const now = graph.ctx.currentTime;
    const source = graph.ctx.createBufferSource();
    source.buffer = graph.white;
    const filter = graph.ctx.createBiquadFilter();
    filter.type = opts.type;
    filter.Q.value = opts.q;
    filter.frequency.setValueAtTime(Math.max(30, opts.freq), now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(30, opts.endFreq), now + opts.duration);
    const gain = graph.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, opts.peak), now + opts.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(opts.release, opts.attack + 0.02));
    source.connect(filter);
    filter.connect(gain);
    gain.connect(graph.bus);
    source.start(now);
    source.stop(now + opts.duration + 0.02);
    this.watch(source, () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    });
  }

  private watch(source: AudioScheduledSourceNode, cleanup: () => void): void {
    this.sources.push(source);
    source.onended = () => {
      cleanup();
      const index = this.sources.indexOf(source);
      if (index >= 0) this.sources.splice(index, 1);
    };
  }

  private target(param: AudioParam, key: string, value: number, tau: number, epsilon: number): void {
    const ctx = this.graph?.ctx;
    if (!ctx) return;
    const next = finite(value);
    const prev = this.paramState.get(key);
    if (prev !== undefined && Math.abs(prev - next) < epsilon && !(next === 0 && prev !== 0)) return;
    this.paramState.set(key, next);
    param.setTargetAtTime(next, ctx.currentTime, Math.max(0.01, tau));
  }
}
