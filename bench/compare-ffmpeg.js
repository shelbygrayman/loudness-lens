// Compare Loudness Lens with ffmpeg's ebur128 filter on generated signals.
// Usage: node bench/compare-ffmpeg.js [out.json]   (needs ffmpeg on PATH)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measure, parseWav, makeTruePeak, toDb } from '../loudness.js';

const VARIANTS = (process.env.TP_VARIANTS ?? '').split(',').filter(Boolean).map(v => v.split('x').map(Number));

const FS = 48000;
const db = x => 10 ** (x / 20);
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;

function render(seconds, fn) {
  const n = Math.round(seconds * FS), L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { const [l, r] = fn(i / FS, i); L[i] = l; R[i] = r; }
  return [L, R];
}
const sine = (f, t) => Math.sin(2 * Math.PI * f * t);

// A synthetic "song": kick, hats, bass, chords, a quiet intro and a louder, limited second half.
// drive sets how hard the soft clipper works; peak sets the final sample peak in dBFS.
function song(drive, peak) {
  let pink = 0, hp = 0, prev = 0;
  const [L, R] = render(60, (t) => {
    const beat = t % 0.5, bar = Math.floor(t / 2) % 4;
    const kick = Math.exp(-beat * 30) * sine(55 + 60 * Math.exp(-beat * 40), t) * 0.9;
    pink = 0.97 * pink + 0.03 * rand();
    const w = rand(); hp = 0.6 * (hp + w - prev); prev = w;
    const hat = Math.exp(-(t % 0.25) * 60) * hp * 0.3;
    const roots = [55, 65.41, 73.42, 49];
    const bass = 0.35 * sine(roots[bar], t);
    const chord = 0.12 * (sine(roots[bar] * 4, t) + sine(roots[bar] * 5, t) + sine(roots[bar] * 6, t));
    const section = t < 15 ? 0.3 : 1;
    const l = section * (kick + hat + bass + chord + pink * 0.5), r = section * (kick + hat * 0.8 + bass + chord * 0.9 + pink * 0.5);
    return [Math.tanh(l * drive), Math.tanh(r * drive)];
  });
  let max = 0;
  for (const c of [L, R]) for (const v of c) max = Math.max(max, Math.abs(v));
  const g = db(peak) / max;
  for (const c of [L, R]) for (let i = 0; i < c.length; i++) c[i] *= g;
  return [L, R];
}

// Reference true peak: 64x windowed-sinc interpolation (±128 taps, Kaiser) evaluated around the
// loudest 20,000 sample intervals per channel. Slow but much finer than any 4x meter.
// cut < 1 band-limits the reconstruction (cut = 20/24 keeps only content up to 20 kHz at 48 kHz).
function referencePeak(chans, cut = 1) {
  const H = 128, OS = 64, beta = 12;
  const i0 = x => { let s = 1, t = 1; for (let k = 1; k < 80; k++) { t *= (x / (2 * k)) ** 2; s += t; if (t < 1e-15 * s) break; } return s; };
  const kernels = [];
  for (let p = 0; p < OS; p++) {
    const frac = p / OS, k = new Float64Array(2 * H);
    for (let j = -H + 1; j <= H; j++) {
      const t = j - frac, u = t * cut, s = cut * (u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u));
      const r = t / H;
      k[j + H - 1] = Math.abs(r) >= 1 ? 0 : s * i0(beta * Math.sqrt(1 - r * r)) / i0(beta);
    }
    kernels.push(k);
  }
  let peak = 0;
  for (const x of chans) {
    const idx = [];
    for (let i = H; i + H < x.length; i++) idx.push(i);
    idx.sort((a, b) => Math.max(Math.abs(x[b]), Math.abs(x[b + 1])) - Math.max(Math.abs(x[a]), Math.abs(x[a + 1])));
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    for (const i of idx.slice(0, 20000)) {
      for (const k of kernels) {
        let acc = 0;
        for (let j = -H + 1; j <= H; j++) acc += x[i + j] * k[j + H - 1];
        peak = Math.max(peak, Math.abs(acc));
      }
    }
  }
  return 20 * Math.log10(peak);
}

const CASES = {
  'sine 1 kHz −23 dBFS (EBU 3341 #1)': () => render(20, t => [db(-23) * sine(1000, t), db(-23) * sine(1000, t)]),
  'stepped −26/−20/−26 (EBU 3341 #5)': () => render(60.1, t => { const g = t < 20 || t >= 40.1 ? -26 : -20; return [db(g) * sine(1000, t), db(g) * sine(1000, t)]; }),
  'low-passed noise': () => { let a = 0, b = 0; return render(30, () => { a = 0.98 * a + 0.02 * rand(); b = 0.98 * b + 0.02 * rand(); return [a * 1.2, b * 1.2]; }); },
  'intersample peak, fs/4 at 45°': () => render(5, t => [sine(12000, t + 1 / (8 * 12000)) * 0.99, sine(12000, t + 1 / (8 * 12000)) * 0.99]),
  'synthetic song, gentle master': () => song(1, -1),
  'synthetic song, loud master': () => song(4, -0.1)
};

function writeWavFloat(path, chans) {
  const n = chans[0].length, c = chans.length, buf = Buffer.alloc(44 + n * c * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * c * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20); buf.writeUInt16LE(c, 22); buf.writeUInt32LE(FS, 24);
  buf.writeUInt32LE(FS * c * 4, 28); buf.writeUInt16LE(c * 4, 32); buf.writeUInt16LE(32, 34); buf.write('data', 36); buf.writeUInt32LE(n * c * 4, 40);
  for (let i = 0, o = 44; i < n; i++) for (let k = 0; k < c; k++, o += 4) buf.writeFloatLE(chans[k][i], o);
  writeFileSync(path, buf);
}

function ffmpegSummary(path) {
  const res = execFileSync('sh', ['-c', `ffmpeg -hide_banner -nostats -i "${path}" -af ebur128=peak=true -f null - 2>&1`], { encoding: 'utf8' });
  const summary = res.slice(res.lastIndexOf('Summary:'));
  const num = re => { const m = summary.match(re); return m ? Number(m[1]) : null; };
  return { integrated: num(/I:\s+(-?[\d.]+) LUFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/), truePeak: num(/Peak:\s+(-?[\d.]+) dBFS/) };
}

const dir = mkdtempSync(join(tmpdir(), 'loudness-bench-'));
const rows = [];
try {
  const version = execFileSync('sh', ['-c', 'ffmpeg -version | head -1'], { encoding: 'utf8' }).trim();
  for (const [name, make] of Object.entries(CASES)) {
    seed = 1;
    const path = join(dir, 'case.wav');
    writeWavFloat(path, make());
    const parsed = parseWav(readFileSync(path));
    const t0 = performance.now();
    const ours = measure(parsed.channels, parsed.sampleRate);
    const ms = performance.now() - t0;
    const ref = ffmpegSummary(path);
    const truth = referencePeak(parsed.channels);
    const truth20 = referencePeak(parsed.channels, 20000 / FS * 2);
    const variants = Object.fromEntries(VARIANTS.map(([t, p]) => { const f = makeTruePeak(t, p); return [`${p}x/${t}`, Math.round(toDb(Math.max(...parsed.channels.map(f))) * 10) / 10]; }));
    if (VARIANTS.length) console.log(name, 'ref', Math.round(truth * 10) / 10, 'ref20k', Math.round(truth20 * 10) / 10, JSON.stringify(variants));
    const r1 = x => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
    rows.push({
      case: name,
      integrated: { ours: r1(ours.integrated), ffmpeg: ref.integrated, diff: r1(ours.integrated - ref.integrated) },
      lra: { ours: r1(ours.lra), ffmpeg: ref.lra, diff: r1(ours.lra - ref.lra) },
      truePeak: { ours: r1(ours.truePeak), ffmpeg: ref.truePeak, reference: r1(truth), reference20k: r1(truth20), oursError: r1(ours.truePeak - truth), ffmpegError: r1(ref.truePeak - truth) },
      seconds: Math.round(ours.duration * 10) / 10,
      measureMs: Math.round(ms)
    });
  }
  const result = { date: new Date().toISOString().slice(0, 10), node: process.version, ffmpeg: version, sampleRate: FS, reference: '64x windowed-sinc interpolation, ±128 taps, Kaiser beta 12, loudest 20,000 intervals per channel; reference20k band-limits it to 20 kHz', rows };
  console.table(rows.map(r => ({ case: r.case, 'I ours': r.integrated.ours, 'I ffmpeg': r.integrated.ffmpeg, 'LRA ours': r.lra.ours, 'LRA ffmpeg': r.lra.ffmpeg, 'TP ours': r.truePeak.ours, 'TP ffmpeg': r.truePeak.ffmpeg, 'TP ref': r.truePeak.reference, 'TP ref ≤20k': r.truePeak.reference20k, ms: r.measureMs })));
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
