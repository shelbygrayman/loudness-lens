import { measure, parseWav, compareTargets, advice, TRUE_PEAK_DESIGN } from './loudness.js';

self.onmessage = ({ data }) => {
  try {
    let channels, sampleRate, source;
    if (data.type === 'wav') {
      const wav = parseWav(data.buffer);
      ({ channels, sampleRate } = wav);
      source = { decoder: 'Loudness Lens WAV reader (exact samples)', bits: wav.bits, float: wav.float, truncated: wav.truncated };
    } else {
      ({ channels, sampleRate } = data);
      source = { decoder: 'Browser decoder, resampled to ' + sampleRate + ' Hz' };
    }
    const m = measure(channels, sampleRate, { onProgress: v => self.postMessage({ type: 'progress', value: v }) });
    self.postMessage({ type: 'result', m, targets: compareTargets(m), advice: advice(m), source, truePeakDesign: TRUE_PEAK_DESIGN });
  } catch (e) {
    self.postMessage({ type: 'error', message: e.message });
  }
};
