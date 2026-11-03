const $ = id => document.getElementById(id);
const els = Object.fromEntries(['file', 'drop', 'progress', 'bar', 'status', 'error', 'results', 'tiles', 'meta', 'advice', 'curve', 'targets', 'download', 'again', 'file-tag'].map(k => [k, $(k)]));
const MAX_BYTES = 1024 * 1024 * 1024;
let reading = null;

const fmt = (v, unit, digits = 1) => (v === null || v === undefined ? '–' : Number.isFinite(v) ? `${v.toFixed(digits)}${unit ? ' ' + unit : ''}` : '−∞');
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const showError = msg => { els.error.textContent = msg; els.error.hidden = !msg; };
const setProgress = (v, text) => { els.progress.hidden = false; els.bar.style.width = `${Math.round(v * 100)}%`; els.status.textContent = text; };

els.drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.file.click(); } });
for (const ev of ['dragenter', 'dragover']) els.drop.addEventListener(ev, e => { e.preventDefault(); els.drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) els.drop.addEventListener(ev, () => els.drop.classList.remove('over'));
els.drop.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) analyse(f); });
els.file.addEventListener('change', () => { const f = els.file.files[0]; if (f) analyse(f); els.file.value = ''; });
els.again.addEventListener('click', () => { els.results.hidden = true; els.drop.focus(); els.drop.scrollIntoView({ behavior: 'smooth', block: 'center' }); });

const isWav = (file, bytes) => {
  const v = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
  return String.fromCharCode(...v.slice(0, 4)) === 'RIFF' && String.fromCharCode(...v.slice(8, 12)) === 'WAVE';
};

async function analyse(file) {
  showError('');
  els.results.hidden = true;
  if (file.size > MAX_BYTES) return showError('That file is over 1 GB. Export a shorter or compressed copy to check.');
  setProgress(0.05, `Reading ${file.name}…`);
  let buffer;
  try { buffer = await file.arrayBuffer(); } catch { return showError('Could not read that file.'); }
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const started = performance.now();
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') setProgress(0.2 + data.value * 0.75, `Measuring… ${Math.round(data.value * 100)}%`);
    else if (data.type === 'error') { worker.terminate(); els.progress.hidden = true; showError(`Could not measure this file: ${data.message}`); }
    else if (data.type === 'result') {
      worker.terminate();
      els.progress.hidden = true;
      reading = { schema: 'loudness-lens.reading.v1', file: { name: file.name, bytes: file.size }, measuredAt: new Date().toISOString(), seconds: Math.round(performance.now() - started) / 1000, ...data };
      delete reading.type;
      render(reading);
    }
  };
  worker.onerror = e => { worker.terminate(); els.progress.hidden = true; showError(`Measurement failed: ${e.message ?? 'worker error'}`); };
  if (isWav(file, buffer)) {
    setProgress(0.15, 'Reading WAV samples…');
    worker.postMessage({ type: 'wav', buffer }, [buffer]);
    return;
  }
  try {
    setProgress(0.1, 'Decoding with your browser…');
    const ctx = new OfflineAudioContext(2, 1, 48000);
    const audio = await ctx.decodeAudioData(buffer);
    const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c).slice());
    worker.postMessage({ type: 'pcm', channels, sampleRate: audio.sampleRate }, channels.map(c => c.buffer));
  } catch {
    worker.terminate();
    els.progress.hidden = true;
    showError('Your browser could not decode this file. Try exporting a WAV.');
  }
}

function tile(label, value, sub, cls) {
  const t = el('div', `tile ${cls ?? ''}`);
  t.append(el('span', 'tile-label', label), el('strong', null, value), el('span', 'tile-sub', sub));
  return t;
}

function outcomeText(t) {
  switch (t.outcome) {
    case 'down': return [`Turned down ${Math.abs(t.change).toFixed(1)} dB`, 'down'];
    case 'match': return ['Plays as is', 'ok'];
    case 'up': return [`Raised ${t.change.toFixed(1)} dB`, 'ok'];
    case 'up-limited': return [t.change > 0 ? `Raised ${t.change.toFixed(1)} dB of ${t.delta.toFixed(1)} (peaks limit it)` : `${t.delta.toFixed(1)} dB under target; peaks leave no room to raise it`, 'warn'];
    case 'up-limiter': return [`Raised ${t.delta.toFixed(1)} dB through a limiter`, 'warn'];
    default: return [`${t.delta.toFixed(1)} dB under target; may be raised or left as is`, 'muted'];
  }
}

function render(r) {
  const m = r.m;
  els['file-tag'].textContent = r.file.name.length > 40 ? r.file.name.slice(0, 37) + '…' : r.file.name;
  const tpCls = m.truePeak > -1 ? 'warn' : 'good';
  els.tiles.replaceChildren(
    tile('Integrated', fmt(m.integrated), 'LUFS', 'hero-tile'),
    tile('True peak', fmt(m.truePeak), 'dBTP', tpCls),
    tile('Loudness range', fmt(m.lra), 'LU'),
    tile('Short-term max', fmt(m.shortTermMax), 'LUFS'),
    tile('Sample peak', fmt(m.samplePeak), 'dBFS')
  );
  const mins = Math.floor(m.duration / 60), secs = Math.round(m.duration % 60).toString().padStart(2, '0');
  els.meta.textContent = `${mins}:${secs} · ${m.sampleRate.toLocaleString()} Hz · ${m.channels === 1 ? 'mono' : m.channels === 2 ? 'stereo' : m.channels + ' channels'} · ${r.source.decoder}${r.source.bits ? `, ${r.source.bits}-bit ${r.source.float ? 'float' : 'PCM'}` : ''}${r.source.truncated ? ' · file looks truncated' : ''} · measured in ${r.seconds.toFixed(1)} s`;
  els.advice.replaceChildren(...r.advice.map(a => el('li', a.level, a.text)));
  const tbody = els.targets.tBodies[0];
  tbody.replaceChildren(...r.targets.map(t => {
    const tr = el('tr');
    const [text, cls] = outcomeText(t);
    tr.append(el('td', null, t.name), el('td', 'muted', t.setting), el('td', 'num', `${t.lufs} LUFS`), el('td', cls, text));
    const src = el('td'); src.append(el('span', `src ${t.source}`, t.source === 'official' ? 'Official' : 'Reported')); tr.append(src);
    return tr;
  }));
  els.results.hidden = false;
  drawCurve(m.shortTermCurve);
  els.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function drawCurve(values) {
  const c = els.curve, dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = 180;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const line = css.getPropertyValue('--line').trim(), accent = css.getPropertyValue('--accent').trim(), muted = css.getPropertyValue('--muted').trim(), amber = css.getPropertyValue('--amber').trim();
  g.clearRect(0, 0, w, h);
  const finite = values.filter(Number.isFinite);
  if (!finite.length) { g.fillStyle = muted; g.font = '12px system-ui'; g.fillText('Too short or silent for a short-term curve.', 12, h / 2); return; }
  const top = Math.min(0, Math.ceil(Math.max(...finite) / 6) * 6), bottom = Math.max(-60, Math.floor(Math.min(...finite) / 6) * 6 - 6);
  const pad = { l: 40, r: 8, t: 8, b: 20 };
  const x = i => pad.l + (i / Math.max(1, values.length - 1)) * (w - pad.l - pad.r);
  const y = v => pad.t + ((top - v) / (top - bottom)) * (h - pad.t - pad.b);
  g.font = '11px system-ui'; g.fillStyle = muted; g.strokeStyle = line; g.lineWidth = 1;
  for (let v = top; v >= bottom; v -= 6) { g.beginPath(); g.moveTo(pad.l, y(v)); g.lineTo(w - pad.r, y(v)); g.stroke(); g.fillText(String(v), 6, y(v) + 4); }
  if (-14 <= top && -14 >= bottom) { g.setLineDash([4, 4]); g.strokeStyle = amber; g.beginPath(); g.moveTo(pad.l, y(-14)); g.lineTo(w - pad.r, y(-14)); g.stroke(); g.setLineDash([]); }
  g.strokeStyle = accent; g.lineWidth = 1.75; g.beginPath();
  const stepPx = Math.max(1, Math.floor(values.length / (w * 2)));
  let started = false;
  for (let i = 0; i < values.length; i += stepPx) {
    const v = values[i];
    if (!Number.isFinite(v) || v < bottom) { started = false; continue; }
    started ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v));
    started = true;
  }
  g.stroke();
  const total = (values.length + 29) / 10;
  g.fillStyle = muted;
  g.fillText('0:00', pad.l, h - 4);
  const end = `${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')}`;
  g.fillText(end, w - pad.r - g.measureText(end).width, h - 4);
}
window.addEventListener('resize', () => { if (reading && !els.results.hidden) drawCurve(reading.m.shortTermCurve); });

els.download.addEventListener('click', () => {
  const out = { ...reading, m: { ...reading.m } };
  delete out.m.shortTermCurve;
  const blob = new Blob([JSON.stringify(out, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: reading.file.name.replace(/\.[^.]+$/, '') + '.loudness.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
