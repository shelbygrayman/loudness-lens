import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from './loudness.js';

const db = x => 10 ** (x / 20);
function sine(freq, dbfs, seconds, fs = 48000, phase = 0) {
  const n = Math.round(seconds * fs), a = db(dbfs), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a * Math.sin(2 * Math.PI * freq * i / fs + phase);
  return out;
}
const concat = (...parts) => { const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const stereo = x => [x, Float32Array.from(x)];
const near = (actual, expected, tol, label) => assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual.toFixed(3)} vs ${expected} (±${tol})`);

test('K-weighting at 48 kHz reproduces the BS.1770 coefficient table', () => {
  const [s, h] = L.kWeighting(48000);
  [1.53512485958697, -2.69169618940638, 1.19839281085285].forEach((v, i) => near(s.b[i], v, 1e-8, `shelf b${i}`));
  [-1.69065929318241, 0.73248077421585].forEach((v, i) => near(s.a[i + 1], v, 1e-8, `shelf a${i + 1}`));
  [-1.99004745483398, 0.99007225036621].forEach((v, i) => near(h.a[i + 1], v, 1e-8, `hp a${i + 1}`));
});

test('BS.1770: 0 dBFS 1 kHz sine in one channel reads −3.01 LKFS', () => {
  near(L.measure([sine(1000, 0, 10)], 48000, { truePeak: false }).integrated, -3.01, 0.05, 'mono');
});

// EBU Tech 3341 minimal requirements, stereo 1 kHz sine, ±0.1 LU.
test('EBU 3341 case 1 and 2: steady sines at −23 and −33 dBFS', () => {
  near(L.measure(stereo(sine(1000, -23, 20)), 48000, { truePeak: false }).integrated, -23, 0.1, 'case 1');
  near(L.measure(stereo(sine(1000, -33, 20)), 48000, { truePeak: false }).integrated, -33, 0.1, 'case 2');
});

test('EBU 3341 case 3: relative gate drops the −36 dBFS sections', () => {
  const x = concat(sine(1000, -36, 10), sine(1000, -23, 60), sine(1000, -36, 10));
  near(L.measure(stereo(x), 48000, { truePeak: false }).integrated, -23, 0.1, 'case 3');
});

test('EBU 3341 case 4: absolute gate drops the −72 dBFS sections', () => {
  const x = concat(sine(1000, -72, 10), sine(1000, -36, 10), sine(1000, -23, 60), sine(1000, -36, 10), sine(1000, -72, 10));
  near(L.measure(stereo(x), 48000, { truePeak: false }).integrated, -23, 0.1, 'case 4');
});

test('EBU 3341 case 5: −26 / −20 / −26 dBFS', () => {
  const x = concat(sine(1000, -26, 20), sine(1000, -20, 20.1), sine(1000, -26, 20));
  near(L.measure(stereo(x), 48000, { truePeak: false }).integrated, -23, 0.1, 'case 5');
});

test('momentary and short-term maxima on a steady signal', () => {
  const m = L.measure(stereo(sine(1000, -23, 20)), 48000, { truePeak: false });
  near(m.momentaryMax, -23, 0.1, 'momentary');
  near(m.shortTermMax, -23, 0.1, 'short-term');
});

test('works at 44.1 kHz and 96 kHz', () => {
  for (const fs of [44100, 96000]) near(L.measure(stereo(sine(1000, -23, 10, fs)), fs, { truePeak: false }).integrated, -23, 0.1, `${fs} Hz`);
});

// EBU Tech 3342 loudness range cases (±1 LU).
test('EBU 3342 cases 1 and 2: loudness range of stepped sines', () => {
  near(L.measure(stereo(concat(sine(1000, -20, 20), sine(1000, -30, 20))), 48000, { truePeak: false }).lra, 10, 1, 'LRA 10');
  near(L.measure(stereo(concat(sine(1000, -20, 20), sine(1000, -15, 20))), 48000, { truePeak: false }).lra, 5, 1, 'LRA 5');
});

test('true peak catches an intersample peak that sample peak misses', () => {
  const x = sine(12000, 0, 1, 48000, Math.PI / 4); // fs/4 at 45°: samples land at ±0.707
  const m = L.measure([x], 48000);
  near(m.samplePeak, -3.01, 0.05, 'sample peak');
  near(m.truePeak, 0, 0.2, 'true peak');
});

test('true peak of a plain sine equals its level', () => {
  near(L.measure([sine(997, -6, 1)], 48000).truePeak, -6, 0.1, '997 Hz');
});

test('silence reads −∞ and has no loudness range', () => {
  const m = L.measure(stereo(new Float32Array(48000 * 5)), 48000);
  assert.equal(m.integrated, -Infinity);
  assert.equal(m.lra, null);
  assert.deepEqual(L.compareTargets(m), []);
});

test('5.1 weights: LFE excluded, surrounds +1.5 dB', () => {
  assert.deepEqual(L.channelWeights(6), [1, 1, 1, 0, 1.41, 1.41]);
  const z = new Float32Array(48000 * 5), s = sine(1000, -23, 5);
  const lfeOnly = L.measure([z, z, z, s, z, z], 48000, { truePeak: false });
  assert.equal(lfeOnly.integrated, -Infinity);
});

test('input validation', () => {
  assert.throws(() => L.measure([], 48000), /No audio/);
  assert.throws(() => L.measure([new Float32Array(10), new Float32Array(11)], 48000), /different lengths/);
  assert.throws(() => L.measure([new Float32Array(10)], 1000), /sample rate/);
});

// ---------- WAV ----------
function wav({ format = 1, bits = 16, channels = 2, sampleRate = 44100, frames, write, extensible = false, odd = false }) {
  const bytes = bits / 8, dataSize = frames * channels * bytes;
  const fmtSize = extensible ? 40 : 16;
  const extra = odd ? 10 : 0; // odd-sized LIST chunk before data
  const buf = new ArrayBuffer(12 + 8 + fmtSize + extra + 8 + dataSize);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, buf.byteLength - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, fmtSize, true);
  v.setUint16(20, extensible ? 0xfffe : format, true); v.setUint16(22, channels, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * bytes, true); v.setUint16(32, channels * bytes, true); v.setUint16(34, bits, true);
  if (extensible) {
    v.setUint16(36, 22, true); v.setUint16(38, bits, true); v.setUint32(40, 3, true);
    const guid = [format, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];
    guid.forEach((b, i) => v.setUint8(44 + i, b));
  }
  let o = 20 + fmtSize;
  if (odd) { str(o, 'LIST'); v.setUint32(o + 4, 1, true); o += 10; }
  str(o, 'data'); v.setUint32(o + 4, dataSize, true); o += 8;
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++, o += bytes) write(v, o, f, c);
  return buf;
}

test('WAV: 16-bit PCM, exact sample values, odd chunk padding', () => {
  const vals = [0, 16384, -32768, 32767];
  const p = L.parseWav(wav({ frames: 2, odd: true, write: (v, o, f, c) => v.setInt16(o, vals[f * 2 + c], true) }));
  assert.equal(p.sampleRate, 44100);
  assert.deepEqual([...p.channels[0]], [0, -1]);
  assert.deepEqual([...p.channels[1]], [0.5, 32767 / 32768]);
});

test('WAV: 24-bit PCM sign extension', () => {
  const write24 = (v, o, n) => { const u = n < 0 ? n + 0x1000000 : n; v.setUint8(o, u & 255); v.setUint8(o + 1, (u >> 8) & 255); v.setUint8(o + 2, (u >> 16) & 255); };
  const vals = [-8388608, 4194304];
  const p = L.parseWav(wav({ bits: 24, channels: 1, frames: 2, write: (v, o, f) => write24(v, o, vals[f]) }));
  assert.deepEqual([...p.channels[0]], [-1, 0.5]);
});

test('WAV: 32-bit float through WAVE_FORMAT_EXTENSIBLE', () => {
  const p = L.parseWav(wav({ format: 3, bits: 32, channels: 1, frames: 3, extensible: true, write: (v, o, f) => v.setFloat32(o, [0.25, -0.75, 1.5][f], true) }));
  assert.equal(p.float, true);
  assert.deepEqual([...p.channels[0]], [0.25, -0.75, 1.5]);
});

test('WAV: rejects junk and unsupported encodings', () => {
  assert.throws(() => L.parseWav(new ArrayBuffer(8)), /RIFF/);
  assert.throws(() => L.parseWav(wav({ bits: 12, frames: 1, write: () => {} })), /Unsupported WAV encoding|Block alignment/);
  assert.throws(() => L.parseWav(wav({ format: 2, frames: 1, write: () => {} })), /Unsupported WAV encoding/);
});

// ---------- Targets ----------
test('targets: loud master is turned down everywhere it is louder than target', () => {
  const r = L.compareTargets({ integrated: -9.2, truePeak: -0.3 });
  const spotify = r.find(t => t.id === 'spotify');
  assert.equal(spotify.outcome, 'down');
  assert.equal(spotify.change, -4.8);
  assert.equal(r.find(t => t.id === 'apple').change, -6.8);
  assert.ok(r.every(t => t.outcome === 'down'));
});

test('targets: quiet master raised by Spotify only as far as peak headroom allows', () => {
  const r = L.compareTargets({ integrated: -18, truePeak: -3.5 });
  const s = r.find(t => t.id === 'spotify');
  assert.equal(s.outcome, 'up-limited');
  assert.equal(s.change, 2.5);
  assert.equal(r.find(t => t.id === 'youtube').outcome, 'maybe-up');
  assert.equal(r.find(t => t.id === 'spotify-quiet').outcome, 'down');
});

test('advice follows Spotify true-peak guidance', () => {
  assert.match(L.advice({ integrated: -9, truePeak: -1.5, samplePeak: -1.6, duration: 200 })[0].text, /below −2 dBTP/);
  assert.match(L.advice({ integrated: -16, truePeak: -0.5, samplePeak: -0.6, duration: 200 })[0].text, /above Spotify's recommended −1 dBTP/);
  assert.equal(L.advice({ integrated: -16, truePeak: -1.5, samplePeak: -1.6, duration: 200 })[0].level, 'ok');
});

test('two-pass true peak equals the exhaustive search', () => {
  let s = 7;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (const drive of [0.5, 3, 10]) {
    const x = new Float32Array(48000);
    let lp = 0;
    for (let i = 0; i < x.length; i++) { lp = 0.7 * lp + 0.3 * rand(); x[i] = Math.tanh((lp + 0.5 * Math.sin(i * 0.05)) * drive) * 0.9; }
    assert.equal(L.truePeak(x), L.truePeak(x, { exhaustive: true }), `drive ${drive}`);
  }
});
