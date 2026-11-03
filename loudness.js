/* Loudness Lens core: ITU-R BS.1770-4 loudness, EBU Tech 3342 loudness range, true-peak estimate,
   and a strict WAV reader. Pure functions, no dependencies. Runs in browsers, workers and Node 20+. */

// ---------- K-weighting ----------
// Coefficients derived for any sample rate from the BS.1770 analog prototypes (same derivation as
// libebur128 and pyloudnorm). At 48 kHz they reproduce the table in the recommendation.
export function kWeighting(fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0],
    a: [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
  };
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const highpass = { b: [1, -2, 1], a: [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
  return [shelf, highpass];
}

function biquadInPlace(x, { b, a }) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const [b0, b1, b2] = b, [, a1, a2] = a;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y;
    x[i] = y;
  }
}

// BS.1770 channel weights. WAV / WAVEFORMATEXTENSIBLE 5.1 order: L R C LFE Ls Rs.
export function channelWeights(n) {
  if (n === 6) return [1, 1, 1, 0, 1.41, 1.41];
  return new Array(n).fill(1);
}

const LOG = e => (e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity);

// ---------- True peak (estimate) ----------
// Oversampling with a polyphase windowed-sinc interpolator (Kaiser window). BS.1770-4 Annex 2
// describes 4x oversampling with an example filter; this design differs, so results can differ from
// other meters by a small amount. BENCHMARKS.md records how much, against a much finer reference.
function besselI0(x) { let s = 1, t = 1; for (let k = 1; k < 60; k++) { t *= (x / (2 * k)) ** 2; s += t; if (t < 1e-14 * s) break; } return s; }
export function makeTruePeak(tapsPerPhase, phases, beta = 7.5) {
  const N = tapsPerPhase * phases, h = new Float64Array(N), center = (N - 1) / 2;
  for (let n = 0; n < N; n++) {
    const t = (n - center) / phases;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const r = (n - center) / center;
    h[n] = sinc * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / besselI0(beta);
  }
  const bank = [];
  for (let p = 0; p < phases; p++) {
    const taps = new Float64Array(tapsPerPhase);
    let sum = 0;
    for (let k = 0; k < tapsPerPhase; k++) { taps[k] = h[p + k * phases]; sum += taps[k]; }
    for (let k = 0; k < tapsPerPhase; k++) taps[k] /= sum; // unity DC gain per phase
    bank.push(taps);
  }
  const phaseAt = (x, i, p) => {
    const taps = bank[p];
    let acc = 0;
    for (let k = 0; k < tapsPerPhase; k++) acc += taps[k] * x[i + tapsPerPhase - 1 - k];
    return acc < 0 ? -acc : acc;
  };
  // Two-pass: even phases everywhere, odd phases only where the signal is within 1 dB of the peak
  // found so far. A band-limited signal cannot rise more than that between neighbouring even phases,
  // so the result equals the exhaustive search (tested) at roughly half the cost.
  return function truePeak(x, { exhaustive = false } = {}) {
    let peak = 0;
    const n = x.length, T = tapsPerPhase, near = 10 ** (-1 / 20);
    for (let i = 0; i < n; i++) { const s = Math.abs(x[i]); if (s > peak) peak = s; }
    const step = exhaustive || phases % 2 ? 1 : 2;
    for (let i = 0; i + T <= n; i++) {
      let local = 0;
      for (let p = 0; p < phases; p += step) { const a = phaseAt(x, i, p); if (a > local) local = a; }
      if (step === 2 && local >= peak * near) for (let p = 1; p < phases; p += 2) { const a = phaseAt(x, i, p); if (a > local) local = a; }
      if (local > peak) peak = local;
    }
    return peak;
  };
}
export const TRUE_PEAK_DESIGN = { tapsPerPhase: 32, phases: 8 };
export const truePeak = makeTruePeak(TRUE_PEAK_DESIGN.tapsPerPhase, TRUE_PEAK_DESIGN.phases);

export const toDb = v => (v > 0 ? 20 * Math.log10(v) : -Infinity);

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ---------- Measurement ----------
// channels: array of Float32Array (one per channel, equal length), sampleRate in Hz.
export function measure(channels, sampleRate, { truePeak: wantTp = true, onProgress } = {}) {
  if (!Array.isArray(channels) || !channels.length) throw new Error('No audio channels');
  if (!(sampleRate >= 8000 && sampleRate <= 384000)) throw new Error('Unsupported sample rate');
  const len = channels[0].length;
  if (channels.some(c => c.length !== len)) throw new Error('Channels have different lengths');
  const weights = channelWeights(channels.length);
  const step = Math.round(sampleRate / 10); // 100 ms sub-blocks
  const nSub = Math.floor(len / step);
  const sub = new Float64Array(nSub); // weighted mean-square per 100 ms
  let samplePeak = 0, tp = 0;
  const filters = kWeighting(sampleRate);
  channels.forEach((ch, c) => {
    for (let i = 0; i < len; i++) { const s = Math.abs(ch[i]); if (s > samplePeak) samplePeak = s; }
    if (wantTp) tp = Math.max(tp, truePeak(ch));
    if (weights[c] === 0) return;
    const y = Float64Array.from(ch);
    biquadInPlace(y, filters[0]);
    biquadInPlace(y, filters[1]);
    for (let j = 0; j < nSub; j++) {
      let e = 0;
      for (let i = j * step, end = i + step; i < end; i++) e += y[i] * y[i];
      sub[j] += weights[c] * e / step;
    }
    onProgress?.((c + 1) / channels.length);
  });
  const windowEnergy = size => {
    const out = new Float64Array(Math.max(0, nSub - size + 1));
    let acc = 0;
    for (let j = 0; j < nSub; j++) {
      acc += sub[j];
      if (j >= size) acc -= sub[j - size];
      if (j >= size - 1) out[j - size + 1] = acc / size;
    }
    return out;
  };
  const momentary = windowEnergy(4); // 400 ms, 75 % overlap
  const shortTerm = windowEnergy(30); // 3 s, 100 ms step

  // Integrated loudness with absolute and relative gating (BS.1770-4).
  const absGated = [...momentary].filter(e => LOG(e) > -70);
  let integrated = -Infinity;
  if (absGated.length) {
    const rel = LOG(absGated.reduce((s, e) => s + e, 0) / absGated.length) - 10;
    const gated = absGated.filter(e => LOG(e) > rel);
    if (gated.length) integrated = LOG(gated.reduce((s, e) => s + e, 0) / gated.length);
  }

  // Loudness range (EBU Tech 3342).
  let lra = null;
  const stAbs = [...shortTerm].filter(e => LOG(e) > -70);
  if (stAbs.length) {
    const rel = LOG(stAbs.reduce((s, e) => s + e, 0) / stAbs.length) - 20;
    const vals = stAbs.map(LOG).filter(l => l > rel).sort((a, b) => a - b);
    if (vals.length) lra = percentile(vals, 0.95) - percentile(vals, 0.10);
  }

  const maxOf = arr => arr.length ? LOG(Math.max(...arr)) : -Infinity;
  return {
    integrated,
    momentaryMax: maxOf(momentary),
    shortTermMax: maxOf(shortTerm),
    lra,
    samplePeak: toDb(samplePeak),
    truePeak: wantTp ? toDb(tp) : null,
    duration: len / sampleRate,
    sampleRate,
    channels: channels.length,
    shortTermCurve: [...shortTerm].map(LOG) // one value per 100 ms after the first 3 s
  };
}

// ---------- WAV reader ----------
const FLOAT_GUID_TAIL = '000000001000800000aa00389b71';
export function parseWav(buffer) {
  const view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, buffer.byteOffset ?? 0, buffer.byteLength);
  const tag = o => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (view.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');
  let fmt = null, data = null, o = 12;
  while (o + 8 <= view.byteLength) {
    const id = tag(o), size = view.getUint32(o + 4, true), body = o + 8;
    if (body + size > view.byteLength) {
      if (id === 'data') { data = { offset: body, size: view.byteLength - body, truncated: true }; break; }
      throw new Error(`Chunk ${id} runs past the end of the file`);
    }
    if (id === 'fmt ') {
      if (size < 16) throw new Error('fmt chunk too small');
      let format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true), sampleRate = view.getUint32(body + 4, true);
      const blockAlign = view.getUint16(body + 12, true), bits = view.getUint16(body + 14, true);
      if (format === 0xfffe) {
        if (size < 40) throw new Error('Extensible fmt chunk too small');
        const sub = view.getUint16(body + 24, true);
        let tail = '';
        for (let i = 26; i < 40; i++) tail += view.getUint8(body + i).toString(16).padStart(2, '0');
        if (tail !== FLOAT_GUID_TAIL) throw new Error('Unknown WAVE_FORMAT_EXTENSIBLE subformat');
        format = sub;
      }
      fmt = { format, channels, sampleRate, blockAlign, bits };
    } else if (id === 'data') data = { offset: body, size };
    o = body + size + (size & 1);
  }
  if (!fmt) throw new Error('Missing fmt chunk');
  if (!data) throw new Error('Missing data chunk');
  const { format, channels, sampleRate, bits, blockAlign } = fmt;
  if (!channels || channels > 32) throw new Error('Unsupported channel count');
  const bytes = bits / 8;
  const ok = (format === 1 && [8, 16, 24, 32].includes(bits)) || (format === 3 && [32, 64].includes(bits));
  if (!ok) throw new Error(`Unsupported WAV encoding (format ${format}, ${bits}-bit). Use PCM 8/16/24/32-bit or float 32/64-bit.`);
  if (blockAlign !== bytes * channels) throw new Error('Block alignment does not match channels and bit depth');
  const frames = Math.floor(data.size / blockAlign);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  let p = data.offset;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++, p += bytes) {
      let v;
      if (format === 3) v = bits === 32 ? view.getFloat32(p, true) : view.getFloat64(p, true);
      else if (bits === 8) v = (view.getUint8(p) - 128) / 128;
      else if (bits === 16) v = view.getInt16(p, true) / 32768;
      else if (bits === 24) { let n = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16); if (n & 0x800000) n -= 0x1000000; v = n / 8388608; }
      else v = view.getInt32(p, true) / 2147483648;
      out[c][f] = v;
    }
  }
  return { sampleRate, channels: out, bits, float: format === 3, truncated: !!data.truncated };
}

// ---------- Platform targets ----------
// Spotify values are from Spotify's own artist documentation. The others are widely reported by
// mastering references but not published as specs by the platforms, so they are labelled as such.
export const TARGETS = [
  { id: 'spotify', name: 'Spotify', setting: 'Normal (default)', lufs: -14, source: 'official', raises: 'headroom' },
  { id: 'spotify-loud', name: 'Spotify', setting: 'Loud (Premium)', lufs: -11, source: 'official', raises: 'limiter' },
  { id: 'spotify-quiet', name: 'Spotify', setting: 'Quiet', lufs: -19, source: 'official', raises: 'headroom' },
  { id: 'apple', name: 'Apple Music', setting: 'Sound Check', lufs: -16, source: 'reported' },
  { id: 'youtube', name: 'YouTube', setting: 'Default', lufs: -14, source: 'reported' },
  { id: 'amazon', name: 'Amazon Music', setting: 'Default', lufs: -14, source: 'reported' },
  { id: 'tidal', name: 'TIDAL', setting: 'Default', lufs: -14, source: 'reported' },
  { id: 'deezer', name: 'Deezer', setting: 'Default', lufs: -15, source: 'reported' }
];

const round1 = x => Math.round(x * 10) / 10;
export function compareTargets(m) {
  if (!Number.isFinite(m.integrated)) return [];
  return TARGETS.map(t => {
    const delta = round1(t.lufs - m.integrated);
    let outcome, change = null;
    if (delta < 0) { outcome = 'down'; change = delta; }
    else if (delta === 0) outcome = 'match';
    else if (t.raises === 'headroom' && m.truePeak !== null) {
      // Spotify raises quiet tracks only as far as peak headroom allows, keeping 1 dB for lossy encoding.
      const room = round1(-1 - m.truePeak);
      change = Math.max(0, Math.min(delta, room));
      outcome = change < delta ? 'up-limited' : 'up';
    } else if (t.raises === 'limiter') { outcome = 'up-limiter'; change = delta; }
    else outcome = 'maybe-up';
    return { ...t, delta, outcome, change };
  });
}

export function advice(m) {
  const notes = [];
  if (m.truePeak !== null && Number.isFinite(m.truePeak)) {
    if (m.integrated > -14 && m.truePeak > -2) notes.push({ level: 'warn', text: `Louder than −14 LUFS with true peak at ${m.truePeak.toFixed(1)} dBTP. Spotify recommends keeping true peak below −2 dBTP for masters this loud.` });
    else if (m.truePeak > -1) notes.push({ level: 'warn', text: `True peak ${m.truePeak.toFixed(1)} dBTP is above Spotify's recommended −1 dBTP. Lossy encoding (Ogg, AAC) can clip.` });
    else notes.push({ level: 'ok', text: `True peak ${m.truePeak.toFixed(1)} dBTP is within Spotify's recommendation.` });
  }
  if (m.samplePeak >= -0.01) notes.push({ level: 'warn', text: 'Sample peak at or above 0 dBFS: the file may already be clipped.' });
  if (m.duration < 3) notes.push({ level: 'info', text: 'Under 3 seconds: short-term loudness and loudness range need at least 3 s.' });
  return notes;
}
