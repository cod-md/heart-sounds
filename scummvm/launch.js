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
const supportFiles = ['plugins/libdirector.so', 'classicmacfonts.dat', 'scummmodern.zip', 'fonts.dat', 'macgui.dat'];
const projector = 'HEARTSND.EXE';
let startupAssets;

function mountMovie(name, size) {
  const path = '/heart/' + name;
  FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
  const node = FS.create(path, 0o444);
  node.usedBytes = size;
  const streamOps = node.stream_ops;
  function loadMovie() {
    if (node.contents.length === size) return;
    // Director reads movies synchronously. Keep their bytes in MEMFS after the first read.
    const request = new XMLHttpRequest();
    try {
      request.open('GET', '../movies/' + name, false);
      request.overrideMimeType('text/plain; charset=x-user-defined');
      request.send();
      const data = request.responseText;
      if (request.status !== 200 || data.length !== size) {
        throw Error('Unexpected status or file size');
      }
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = data.charCodeAt(i);
      node.contents = bytes;
      if (statusLine.textContent.startsWith('Could not load ' + name + '.')) {
        statusLine.textContent = '';
      }
    } catch (error) {
      console.warn('Could not load ' + name, error);
      statusLine.textContent = 'Could not load ' + name + '. Try opening the lesson again.';
      throw new FS.ErrnoError(29); // EIO
    }
  }
  node.stream_ops = {
    ...streamOps,
    read(...args) {
      loadMovie();
      return streamOps.read(...args);
    },
    mmap(...args) {
      loadMovie();
      return streamOps.mmap(...args);
    }
  };
}

async function loadStartupAssets() {
  return Promise.all([
    fetch('movie-sizes.json').then(response => {
      if (!response.ok) throw Error('Could not load the presentation file list.');
      return response.json();
    }),
    fetchFile('../movies/' + projector),
    Promise.all(supportFiles.map(file => fetchFile('data/' + file)))
  ]);
}

async function mountPresentation() {
  const [movies, projectorBytes, supportBytes] = await startupAssets;
  FS.mkdirTree('/heart');
  FS.writeFile('/heart/' + projector, projectorBytes);
  for (const [name, size] of Object.entries(movies)) {
    if (name !== projector) mountMovie(name, size);
  }
  FS.mkdirTree('/support/plugins');
  for (const [index, file] of supportFiles.entries()) {
    const bytes = supportBytes[index];
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
  statusLine.textContent = 'Loading Director…';
  startupAssets = loadStartupAssets();
  // The runtime consumes this promise in preRun. Handle an early rejection until then.
  startupAssets.catch(() => {});
  try {
    const context = new AudioContext();
    const [, { createLessonAudio }] = await Promise.all([
      context.resume(), import('./lesson-audio.js')
    ]);
    lessonAudio = createLessonAudio(context);
    history.replaceState(null, '', '#--config=/heart.ini heart');
    const script = document.createElement('script');
    script.src = 'scummvm.js';
    script.onerror = () => { statusLine.textContent = 'Could not load the Director runtime.'; };
    document.body.append(script);
  } catch (error) {
    statusLine.textContent = 'Could not start playback. ' + error.message;
    this.hidden = false;
  }
};

