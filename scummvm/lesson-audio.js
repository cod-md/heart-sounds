import { readMovie } from '../director-audio.js';

// Director 4 stores cast-slot order in CAS* and links cast entries to sound chunks in KEY*.
function soundCast(bytes) {
  const movie = readMovie(bytes);
  const view = movie.view;
  const map = view.getUint32(24, true);
  const count = view.getUint32(map + 12, true);
  const stride = view.getUint16(map + 10, true);
  const first = map + 8 + view.getUint16(map + 8, true);
  const chunks = new Map();
  for (let i = 0; i < count; i++) {
    const p = first + i * stride;
    const tag = String.fromCharCode(...new Uint8Array(bytes, p, 4));
    if (tag === '*SAC' || tag === '*YEK') {
      chunks.set(tag, { start: view.getUint32(p + 8, true) + 8, length: view.getUint32(p + 4, true) });
    }
  }
  const slots = chunks.get('*SAC'), keys = chunks.get('*YEK');
  const members = new Map();
  if (!slots || !keys) return members;
  const clips = new Map(movie.clips.map(clip => [clip.id, clip]));
  const byCast = new Map();
  for (let p = keys.start + view.getUint16(keys.start, true); p + 12 <= keys.start + keys.length; p += view.getUint16(keys.start + 2, true)) {
    const clip = clips.get(view.getUint32(p, true));
    if (clip) byCast.set(view.getUint32(p + 4, true), clip);
  }
  for (let i = 0; i < slots.length / 4; i++) {
    const clip = byCast.get(view.getUint32(slots.start + i * 4));
    if (clip) members.set(i + 1, clip);
  }
  return members;
}

export function createLessonAudio(context) {
  const output = context.createGain();
  output.connect(context.destination);
  let moviePath, buffers, source;
  function stop() {
    if (source) { source.stop(); source.disconnect(); source = null; }
  }
  return {
    output,
    opened(path) {
      if (typeof path !== 'string' || !/^\/heart\/.*\.dxr$/i.test(path) || path === moviePath) return;
      stop();
      moviePath = path;
      buffers = null;
    },
    cue(message) {
      const match = /attempted to play a non-SoundCastMember member (\d+)!/.exec(message);
      if (!match || !moviePath) return;
      if (!buffers) {
        const bytes = FS.readFile(moviePath).buffer;
        buffers = new Map();
        const view = new DataView(bytes);
        for (const [slot, clip] of soundCast(bytes)) {
          const buffer = context.createBuffer(clip.channels, clip.frames, clip.rate);
          for (let channel = 0; channel < clip.channels; channel++) {
            const samples = buffer.getChannelData(channel);
            for (let i = 0; i < samples.length; i++) {
              samples[i] = view.getInt16(clip.offset + 2 * (i * clip.channels + channel)) / 32768;
            }
          }
          buffers.set(slot, buffer);
        }
      }
      const buffer = buffers.get(Number(match[1]));
      if (!buffer) return;
      stop();
      source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(output);
      source.start();
    }
  };
}
