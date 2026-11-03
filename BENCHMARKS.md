# Accuracy

Two kinds of evidence: the standard test signals in `loudness.test.js`, and a side-by-side comparison with ffmpeg's `ebur128` filter in `bench/`.

## Standard test signals (`npm test`, 22 tests)

| Check | Requirement | Result |
| --- | --- | --- |
| K-weighting coefficients at 48 kHz | match the BS.1770 table | within 1e-8 |
| 0 dBFS 1 kHz sine, one channel | −3.01 LKFS (BS.1770) | within 0.05 |
| EBU Tech 3341 cases 1 to 5 (stereo sines, gating) | ±0.1 LU | pass |
| Steady sine at 44.1 kHz and 96 kHz | ±0.1 LU | pass |
| EBU Tech 3342 cases 1 and 2 (loudness range) | ±1 LU | pass |
| fs/4 sine at 45° (sample peak −3.01 dBFS) | true peak 0 dBTP | within 0.2 |
| Two-pass true-peak search | identical to exhaustive search | identical |

Plus WAV reading (8/16/24/32-bit PCM, 32/64-bit float, WAVE_FORMAT_EXTENSIBLE, odd chunk padding, rejection of junk), 5.1 channel weights and the platform maths.

## Comparison with ffmpeg

`npm run compare` (needs ffmpeg) generates each signal as a 32-bit float WAV at 48 kHz, measures it with Loudness Lens and with `ffmpeg -af ebur128=peak=true`, and computes a **reference true peak**: 64x windowed-sinc interpolation with ±128 taps around the loudest 20,000 sample intervals per channel. The ≤20 kHz reference band-limits that reconstruction to 20 kHz.

Run on 3 November 2026, Node 22.23.4, ffmpeg 6.1.1. Raw output: [`bench/ffmpeg-comparison.json`](bench/ffmpeg-comparison.json).

| Case | Integrated (ours / ffmpeg) | LRA (ours / ffmpeg) | True peak ours | True peak ffmpeg | Reference | Reference ≤20 kHz |
| --- | --- | --- | --- | --- | --- | --- |
| sine 1 kHz −23 dBFS (EBU 3341 #1) | -23.0 / -23.0 | 0.0 / 0.0 | -23.0 | -23.0 | -23.0 | -23.0 |
| stepped −26/−20/−26 (EBU 3341 #5) | -23.0 / -23.0 | 6.0 / 6.0 | -20.0 | -20.0 | -20.0 | -20.0 |
| low-passed noise | -21.6 / -21.6 | 0.0 / 0.0 | -12.4 | -12.4 | -12.4 | -12.5 |
| intersample peak, fs/4 at 45° | 3.3 / 3.3 | 0.0 / 0.0 | -0.1 | 0.5 | -0.1 | -0.1 |
| synthetic song, gentle master | -10.3 / -10.3 | 10.0 / 10.0 | 1.6 | 1.4 | 1.7 | 1.5 |
| synthetic song, loud master | -2.7 / -2.7 | 6.5 / 6.5 | 6.6 | 6.5 | 6.2 | 5.6 |

**Integrated loudness and loudness range match ffmpeg to 0.1 LU on every case.**

True peak:

- On the classic intersample test (a sine whose samples sit at ±0.707 of its peak) Loudness Lens matches the reference. ffmpeg reads 0.6 dB high.
- On the synthetic songs, which are soft-clipped and carry energy right up to Nyquist, Loudness Lens reads 0.1 dB under the full-band reference on the gentle master and 0.4 dB over it on the loud one. Reading high is the safer direction for a "will this clip" check.
- 4x oversampling with a 16-tap-per-phase filter (the first design tried) read up to 1.1 dB low on the loud song. Filter length mattered more than oversampling factor, so the shipped design is 8x with 32 taps per phase. `TP_VARIANTS=16x4,32x8 npm run compare` reproduces the comparison.

## Limits of this evidence

- The songs are synthetic. Real masters, limiters and dither behave differently.
- The reference is itself a finite interpolator evaluated near the loudest samples, not an analog measurement.
- ffmpeg is one implementation, not a ground truth. Agreement shows consistency, not correctness on its own.
- Browser decoding of MP3, AAC, FLAC or Ogg is not covered here; those go through the browser's decoder and a 48 kHz resample.
