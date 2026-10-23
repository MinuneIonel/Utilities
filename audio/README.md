# Audio Lab

Convert, compress, resample and trim audio in the browser. Nothing is uploaded: encoding runs locally in [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), and the waveform and trim selection come from [wavesurfer.js](https://github.com/katspaugh/wavesurfer.js) with its Regions plugin.

- **Inputs:** anything ffmpeg reads, including MP3, WAV, FLAC, AAC/M4A, Ogg, Opus, AIFF, WMA, and the audio track of videos (MP4, MOV, MKV, WebM). Drop several files at once.
- **Outputs:** MP3, AAC (M4A), Opus, Ogg Vorbis, FLAC, WAV.
- **Compress:** pick a bitrate, sample rate and mono/stereo; the size estimate updates as you go.
- **Trim:** drag on the waveform or type start and end times (`1:23.5` or seconds). Each file keeps its own selection, so "Convert all" trims each one differently.
- **Shape:** fade in and out, gain, and loudness normalization to −16 LUFS.

## Run

```sh
npm install
npm run dev     # http://localhost:5173
npm run build   # static site in dist/ (includes the 31 MB ffmpeg core, served locally)
npm test        # engine tests; needs a native ffmpeg + ffprobe on PATH
```

## Engine

`src/engine` has no DOM code, so it can become a pipeline stage later:

```ts
convertAudio(ff: FfmpegLike, input: AudioInput, settings: AudioSettings): Promise<AudioOutput>
```

- `AudioInput` is `{ name, bytes, duration? }` and `AudioOutput` is `{ name, bytes, mime }`.
- `FfmpegLike` is the four methods of ffmpeg.wasm's `FFmpeg` class the engine uses. The tests pass a shim over native ffmpeg, so the exact argument lists the browser sends are checked against a real encoder.
- `buildArgs()` is the pure part: settings in, ffmpeg arguments out.
