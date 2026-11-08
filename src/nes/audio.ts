// Streams JSNES audio samples into an AudioWorklet ring buffer.
// The emulator is paced by requestAnimationFrame, not by the audio clock, so the buffer can
// drift: the worklet plays silence on underrun and drops the oldest samples when too full.

const WORKLET = `
class NesSink extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 16384;               // per channel, ~340ms at 48kHz
    this.l = new Float32Array(this.cap);
    this.r = new Float32Array(this.cap);
    this.read = 0; this.size = 0; this.underruns = 0;
    this.port.onmessage = (e) => {
      const { l, r } = e.data;
      for (let i = 0; i < l.length; i++) {
        if (this.size === this.cap) { this.read = (this.read + 1) % this.cap; this.size--; }
        const w = (this.read + this.size) % this.cap;
        this.l[w] = l[i]; this.r[w] = r[i]; this.size++;
      }
    };
  }
  process(_inputs, outputs) {
    const [ol, or] = outputs[0];
    const n = ol.length;
    if (this.size < n) { this.underruns++; ol.fill(0); or && or.fill(0); return true; }
    for (let i = 0; i < n; i++) {
      ol[i] = this.l[this.read];
      if (or) or[i] = this.r[this.read];
      this.read = (this.read + 1) % this.cap;
    }
    this.size -= n;
    if ((currentFrame & 0x3fff) < n) this.port.postMessage({ underruns: this.underruns, buffered: this.size });
    return true;
  }
}
registerProcessor("nes-sink", NesSink);
`;

export class NesAudio {
  readonly ctx: AudioContext;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode;
  private l: number[] = [];
  private r: number[] = [];
  underruns = 0;
  buffered = 0;
  error: string | null = null;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }

  get sampleRate() {
    return this.ctx.sampleRate;
  }

  async init() {
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.node = new AudioWorkletNode(this.ctx, "nes-sink", { outputChannelCount: [2] });
      this.node.port.onmessage = (e) => {
        this.underruns = e.data.underruns;
        this.buffered = e.data.buffered;
      };
      this.node.connect(this.gain);
    } catch (e) {
      this.error = String(e);
    }
  }

  /** Must be called from a user gesture at least once (autoplay policy). */
  resume() {
    if (this.ctx.state !== "running") this.ctx.resume().catch(() => {});
  }

  push(left: number, right: number) {
    this.l.push(left);
    this.r.push(right);
  }

  /** Send the samples produced since the last flush (call once per emulated frame). */
  flush() {
    if (!this.node || !this.l.length) {
      this.l.length = this.r.length = 0;
      return;
    }
    const l = Float32Array.from(this.l);
    const r = Float32Array.from(this.r);
    this.l.length = this.r.length = 0;
    this.node.port.postMessage({ l, r }, [l.buffer, r.buffer]);
  }

  set muted(m: boolean) {
    this.gain.gain.value = m ? 0 : 1;
  }
  get muted() {
    return this.gain.gain.value === 0;
  }

  close() {
    this.ctx.close().catch(() => {});
  }
}
