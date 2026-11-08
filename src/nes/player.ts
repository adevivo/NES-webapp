// JSNES-based player: fixed-timestep frame pacing, canvas output, audio, per-frame input
// masks, battery-RAM persistence and quick save states. The frame loop is driven by
// `step(p1, p2)`, so multiplayer can later replace LocalInput with network-synced masks.
import { NES } from "jsnes";
import { NesAudio } from "./audio";
import { JSNES_BUTTONS, LocalInput } from "./input";

const NTSC_FPS = 60.0988;
const FRAME_MS = 1000 / NTSC_FPS;

// JSNES internals we touch that its .d.ts doesn't declare.
type NesInternals = NES & { cpu: { mem: Uint8Array | number[] }; rom: { batteryRam: unknown; mapperType: number } };

export interface PlayerStats {
  fps: number;
  frameMsAvg: number; // CPU time spent emulating one frame
  frameMsP95: number;
  audioUnderruns: number;
  audioError: string | null;
  gamepad: string | null;
}

export interface PlayerHooks {
  /** Persist battery RAM (8 KB at $6000) for the loaded game. */
  saveSram?: (data: Uint8Array) => void;
}

export class NesPlayer {
  private nes: NesInternals;
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private view: Uint32Array;
  private frameBuf: Uint32Array<ArrayBufferLike> = new Uint32Array(256 * 240);
  private audio: NesAudio;
  readonly input = new LocalInput();
  private raf = 0;
  private last = 0;
  private acc = 0;
  private prev: [number, number] = [0, 0];
  private running = false;
  private hasBattery = false;
  private sramSnapshot = "";
  private sramTimer = 0;
  private emuTimes: number[] = [];
  private framesThisSecond = 0;
  private fpsWindowStart = 0;
  private fps = 0;

  constructor(canvas: HTMLCanvasElement, private hooks: PlayerHooks = {}) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.img = this.ctx.createImageData(256, 240);
    this.view = new Uint32Array(this.img.data.buffer);
    this.audio = new NesAudio();
    this.nes = new NES({
      onFrame: (buf) => (this.frameBuf = buf),
      onAudioSample: (l, r) => this.audio.push(l, r),
      sampleRate: this.audio.sampleRate,
      emulateSound: true,
    }) as NesInternals;
  }

  async init() {
    await this.audio.init();
  }

  /** Throws a user-readable Error for invalid or unsupported ROMs. */
  load(rom: Uint8Array, sram?: Uint8Array | null) {
    try {
      this.nes.loadROM(rom);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const m = /Unsupported mapper: (\d+)/.exec(msg);
      throw new Error(m ? `This game uses mapper ${m[1]}, which JSNES doesn't support yet.` : `Couldn't load ROM: ${msg}`);
    }
    this.hasBattery = Boolean(this.nes.rom.batteryRam);
    if (this.hasBattery && sram?.length === 0x2000) {
      const mem = this.nes.cpu.mem;
      for (let i = 0; i < 0x2000; i++) mem[0x6000 + i] = sram[i];
    }
    this.sramSnapshot = this.hasBattery ? this.sramKey() : "";
    this.prev = [0, 0];
    this.acc = 0;
    clearInterval(this.sramTimer);
    if (this.hasBattery) this.sramTimer = window.setInterval(() => this.flushSram(), 3000);
  }

  get mapper() {
    return this.nes.rom.mapperType;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.audio.resume();
    this.last = performance.now();
    this.acc = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  pause() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.flushSram();
  }

  get paused() {
    return !this.running;
  }

  reset() {
    this.flushSram();
    this.nes.reloadROM();
  }

  set muted(m: boolean) {
    this.audio.muted = m;
  }
  get muted() {
    return this.audio.muted;
  }

  /** Advance exactly one frame with the given input masks. */
  step(p1: number, p2: number) {
    const masks = [p1, p2];
    for (let p = 0; p < 2; p++) {
      const changed = masks[p] ^ this.prev[p];
      if (!changed) continue;
      for (let bit = 0; bit < 8; bit++) {
        if (!(changed & (1 << bit))) continue;
        const pressed = (masks[p] & (1 << bit)) !== 0;
        const ctrl = (p + 1) as 1 | 2;
        if (pressed) this.nes.buttonDown(ctrl, JSNES_BUTTONS[bit]);
        else this.nes.buttonUp(ctrl, JSNES_BUTTONS[bit]);
      }
      this.prev[p] = masks[p];
    }
    const t0 = performance.now();
    this.nes.frame();
    this.emuTimes.push(performance.now() - t0);
    if (this.emuTimes.length > 600) this.emuTimes.splice(0, 300);
    this.audio.flush();
    this.framesThisSecond++;
  }

  private tick = (now: number) => {
    if (!this.running) return;
    this.acc += now - this.last;
    this.last = now;
    if (this.acc > FRAME_MS * 6) this.acc = FRAME_MS; // tab was hidden/stalled: don't fast-forward
    let ran = 0;
    while (this.acc >= FRAME_MS && ran < 4) {
      this.step(this.input.read(), 0);
      this.acc -= FRAME_MS;
      ran++;
    }
    if (ran) this.draw();
    if (now - this.fpsWindowStart >= 1000) {
      this.fps = (this.framesThisSecond * 1000) / (now - this.fpsWindowStart);
      this.framesThisSecond = 0;
      this.fpsWindowStart = now;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private draw() {
    const src = this.frameBuf;
    const dst = this.view;
    for (let i = 0; i < dst.length; i++) dst[i] = 0xff000000 | src[i];
    this.ctx.putImageData(this.img, 0, 0);
  }

  // ---------- battery RAM ----------

  private sramBytes() {
    return Uint8Array.from(this.nes.cpu.mem.slice(0x6000, 0x8000) as ArrayLike<number>);
  }
  private sramKey() {
    // cheap change detection; 8 KB -> string compare every few seconds is negligible
    return String.fromCharCode(...this.sramBytes().subarray(0, 0x2000));
  }
  flushSram() {
    if (!this.hasBattery || !this.hooks.saveSram) return;
    const key = this.sramKey();
    if (key === this.sramSnapshot) return;
    this.sramSnapshot = key;
    this.hooks.saveSram(this.sramBytes());
  }

  // ---------- save states (also a probe for rollback feasibility) ----------

  saveState() {
    const t0 = performance.now();
    const json = JSON.stringify(this.nes.toJSON());
    return { json, ms: performance.now() - t0, bytes: json.length };
  }

  loadState(json: string) {
    const t0 = performance.now();
    this.nes.fromJSON(JSON.parse(json));
    this.prev = [0, 0];
    this.draw();
    return { ms: performance.now() - t0 };
  }

  stats(): PlayerStats {
    const t = [...this.emuTimes].sort((a, b) => a - b);
    const avg = t.length ? t.reduce((s, x) => s + x, 0) / t.length : 0;
    return {
      fps: Math.round(this.fps * 10) / 10,
      frameMsAvg: Math.round(avg * 100) / 100,
      frameMsP95: t.length ? Math.round(t[Math.floor(t.length * 0.95)] * 100) / 100 : 0,
      audioUnderruns: this.audio.underruns,
      audioError: this.audio.error,
      gamepad: this.input.gamepadName,
    };
  }

  destroy() {
    this.pause();
    clearInterval(this.sramTimer);
    this.input.destroy();
    this.audio.close();
  }
}
