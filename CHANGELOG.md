# Changelog

## 0.1.0

- Integrated loudness (ITU-R BS.1770-4), momentary and short-term maxima (EBU R128) and loudness range (EBU Tech 3342).
- True peak with 8x oversampling and a 256-tap interpolator, two-pass search.
- Exact WAV reader; other formats through the browser decoder. Measurement runs in a Web Worker.
- Platform table with Spotify's documented targets and widely reported targets for Apple Music, YouTube, Amazon Music, TIDAL and Deezer.
- 22 tests including EBU Tech 3341 and 3342 cases; comparison with ffmpeg in BENCHMARKS.md.
