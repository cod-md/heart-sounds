// Cloudflare Pages limits individual files to 25 MiB.
const fetchAsset = window.fetch.bind(window);
window.fetch = async function (input, options) {
  const url = new URL(input instanceof Request ? input.url : input, location.href);
  if (url.href !== new URL('scummvm.wasm', location.href).href) return fetchAsset(input, options);
  const parts = await Promise.all(['engine-0.bin', 'engine-1.bin'].map(async name => {
    const response = await fetchAsset(new URL(name, url), options);
    if (!response.ok) throw Error('Could not load ' + name);
    return response.arrayBuffer();
  }));
  const engine = new Blob(parts, {type: 'application/wasm'});
  return new Response(engine, {headers: {'Content-Type': engine.type, 'Content-Length': String(engine.size)}});
};
let lessonAudio;
const statusLine = document.getElementById('status');
const stage = document.getElementById('canvas');
const returnToMenu = document.getElementById('return-to-menu');
returnToMenu.addEventListener('click', () => {
  window.location.reload();
});
async function fetchFile(path) {
  const response = await fetch(path);
  if (!response.ok) throw Error(path + ' returned ' + response.status);
  return new Uint8Array(await response.arrayBuffer());
}
async function mountPresentation() {
  const files = JSON.parse(new TextDecoder().decode(await fetchFile('movie-files.json')));
  FS.mkdirTree('/heart');
  for (const name of files) {
    if (name.includes('/')) FS.mkdirTree('/heart/' + name.split('/')[0]);
  }
  let completed = 0;
  const pending = files.slice();
  async function loadMovies() {
    while (pending.length) {
      const name = pending.shift();
      FS.writeFile('/heart/' + name, await fetchFile('../movies/' + name));
      statusLine.textContent = 'Loading presentation files ' + (++completed) + ' / ' + files.length;
    }
  }
  await Promise.all(Array.from({length: 5}, loadMovies));
  FS.mkdirTree('/support/plugins');
  for (const file of ['plugins/libdirector.so', 'classicmacfonts.dat', 'scummmodern.zip', 'fonts.dat', 'macgui.dat']) {
    const bytes = await fetchFile('data/' + file);
    if (file === 'plugins/libdirector.so') {
      // This projector keeps a mouse handler suspended while a child lesson plays.
      // Allow the next input event through the pinned engine's processEvents guard.
      const guard = [0x20, 0x15, 0x28, 0x02, 0x84, 0x4e, 0x21, 0x16, 0x20, 0x16, 0x0d, 0x02];
      const offset = 6387225;
      if (!guard.every((value, i) => bytes[offset + i] === value)) throw Error('Incompatible Director plugin.');
      bytes.set([0x41, 0x00], offset + 8);
    }
    FS.writeFile('/support/' + file, bytes);
  }
  FS.writeFile('/heart.ini', '[scummvm]\npluginspath=/support/plugins\nextrapath=/support\nthemepath=/support\nconfirm_exit=false\n[heart]\nengineid=director\ngameid=director\nplatform=windows\ntrue_color=true\npath=/heart\nstart_movie=HEARTSND.EXE@13\n');
}
var Module = {
  canvas: stage,
  preRun: [function () {
    addRunDependency('heart-files');
    mountPresentation().then(() => {
      const open = FS.open;
      FS.open = function (...args) {
        const stream = open.apply(this, args);
        lessonAudio.opened(stream.path);
        return stream;
      };
      statusLine.textContent = 'Opening the original presentation…';
      removeRunDependency('heart-files');
    }).catch(error => { statusLine.textContent = 'Loading failed. ' + error.message; });
  }],
  onRuntimeInitialized() {
    httpHideProgressBar();
    statusLine.textContent = '';
    returnToMenu.hidden = false;
    stage.focus();
  },
  onAbort(reason) { statusLine.textContent = 'Playback stopped. ' + reason; },
  print: console.log, printErr(message) { lessonAudio?.cue(message); console.warn(message); }
};
document.getElementById('start').onclick = async function () {
  this.hidden = true;
  const context = new AudioContext();
  await context.resume();
  const { createLessonAudio } = await import('./lesson-audio.js');
  lessonAudio = createLessonAudio(context);
  statusLine.textContent = 'Loading Director…';
  history.replaceState(null, '', '#--config=/heart.ini heart');
  const script = document.createElement('script');
  script.src = 'scummvm.js';
  script.onerror = () => { statusLine.textContent = 'Could not load the Director runtime.'; };
  document.body.append(script);
};

