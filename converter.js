// Minimal, batch-friendly TS->MP4 converter using ffmpeg.wasm with worker offload.

const drop = document.getElementById('drop');
const fileInput = document.getElementById('file');
const go = document.getElementById('go');
const prog = document.getElementById('prog');
const logEl = document.getElementById('log');
const statusPill = document.getElementById('status');
const crfInput = document.getElementById('crf');
const presetSelect = document.getElementById('preset');
const audioSelect = document.getElementById('abitrate');

let files = [];
let activeJob = null;
let workerIsReady = false;
let workerReadyResolve;
let workerReadyReject;

function log(msg){
  const t = new Date().toLocaleTimeString();
  logEl.textContent += `[${t}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function pick(){ fileInput.click(); }
drop.addEventListener('click', pick);
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop.addEventListener('drop', e => {
  e.preventDefault(); drop.classList.remove('dragover');
  const list = Array.from(e.dataTransfer.files || []);
  setFiles(list);
});
fileInput.addEventListener('change', e => setFiles(Array.from(e.target.files || [])));

function setFiles(list){
  const ts = list.filter(f => /\.ts$/i.test(f.name) || f.type === 'video/mp2t');
  if (!ts.length){ alert('Pick .ts files'); return; }
  files = ts;
  drop.querySelector('div').innerHTML = `${files.length} file(s) selected`;
  log(`Selected ${files.length} file(s).`);
  updateGoState();
}

function updateGoState(){
  go.disabled = activeJob !== null || !files.length || !workerIsReady;
}

function ui(busy){
  drop.style.pointerEvents = busy ? 'none' : 'auto';
  prog.style.display = busy ? 'block' : 'none';
  if (!busy) prog.value = 0;
  updateGoState();
}

// ---- ffmpeg worker orchestration ----
const worker = new Worker('libs/ffmpeg-worker.js');
const workerReady = new Promise((resolve, reject) => {
  workerReadyResolve = resolve;
  workerReadyReject = reject;
});

function resolveWorkerReady(){
  if (!workerIsReady){
    workerIsReady = true;
    workerReadyResolve?.();
    workerReadyResolve = null;
    workerReadyReject = null;
    updateGoState();
  }
}

function rejectWorkerReady(err){
  workerReadyReject?.(err);
  workerReadyResolve = null;
  workerReadyReject = null;
  updateGoState();
}

worker.addEventListener('message', event => {
  const { type, message, progress, outputs, error } = event.data || {};
  switch(type){
    case 'ready':
      resolveWorkerReady();
      statusPill.textContent = 'ffmpeg: ready';
      log('ffmpeg loaded.');
      break;
    case 'init-error':
      console.error('ffmpeg worker init failed:', error);
      statusPill.textContent = 'ffmpeg: failed to load';
      log(`ffmpeg failed to load: ${error}`);
      rejectWorkerReady(new Error(error));
      break;
    case 'log':
      if (message) log(message);
      break;
    case 'progress':
      if (activeJob){
        const pct = Math.max(0, Math.min(1, Number(progress) || 0));
        prog.value = Math.round(pct * 100);
      }
      break;
    case 'convert-complete':
      handleWorkerSuccess(outputs || []).catch(err => handleWorkerError(err.message || String(err)));
      break;
    case 'convert-error':
      handleWorkerError(error);
      break;
    default:
      if (type && message) log(`${type}: ${message}`);
      break;
  }
});

worker.addEventListener('error', evt => {
  const msg = evt.message || evt.error?.message || 'Unknown worker error';
  console.error('ffmpeg worker crashed:', evt);
  statusPill.textContent = 'ffmpeg: worker error';
  log(`Worker error: ${msg}`);
  rejectWorkerReady(new Error(msg));
  if (activeJob) handleWorkerError(msg);
});

worker.postMessage({ type: 'init' });

async function ensureWorkerReady(){
  if (workerIsReady) return;
  await workerReady;
}

async function filesToPayload(list){
  const payload = [];
  const transfers = [];
  for (const f of list){
    const buffer = await f.arrayBuffer();
    payload.push({ name: f.name, buffer });
    transfers.push(buffer);
  }
  return { payload, transfers };
}

async function handleWorkerSuccess(outputs){
  try{
    if (!outputs.length){
      log('Conversion finished but produced no outputs.');
      statusPill.textContent = 'done ✔';
      return;
    }
    if (outputs.length === 1){
      const { name, buffer } = outputs[0];
      const blob = new Blob([buffer], { type: 'video/mp4' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
      log(`Done. Saved ${name}`);
    } else {
      const zip = new JSZip();
      for (const o of outputs) zip.file(o.name, o.buffer);
      const blob = await zip.generateAsync({ type: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'converted_videos.zip'; a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
      log('Done. Saved converted_videos.zip');
    }
    statusPill.textContent = 'done ✔';
  }catch(err){
    console.error(err);
    statusPill.textContent = 'error';
    log('Conversion post-processing failed. See console for details.');
    alert('Conversion failed. Open DevTools console for details.');
  } finally {
    activeJob = null;
    ui(false);
  }
}

function handleWorkerError(err){
  const msg = err || 'Unknown error';
  console.error('Conversion failed:', msg);
  statusPill.textContent = 'error';
  log(`Conversion failed: ${msg}`);
  alert('Conversion failed. Open DevTools console for details.');
  activeJob = null;
  ui(false);
}

go.addEventListener('click', async () => {
  if (!files.length) return;
  try{
    await ensureWorkerReady();
  }catch(err){
    console.error(err);
    alert('ffmpeg failed to initialize. Check logs for details.');
    return;
  }
  activeJob = { started: Date.now() };
  ui(true);
  prog.value = 0;
  statusPill.textContent = 'converting…';
  log('Starting conversion…');

  try{
    const crf = String(crfInput.value || 20);
    const preset = presetSelect.value || 'medium';
    const abitrate = audioSelect.value || '192k';
    const { payload, transfers } = await filesToPayload(files);
    worker.postMessage({
      type: 'convert',
      payload: {
        files: payload,
        options: { crf, preset, abitrate }
      }
    }, transfers);
  }catch(err){
    handleWorkerError(err.message || String(err));
  }
});

// Ensure button reflects initial readiness
updateGoState();
