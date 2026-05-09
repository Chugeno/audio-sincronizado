// public/js/musician-app.js
import { WsClient } from './ws-client.js';
import { SyncEngine } from './sync-engine.js';
import { AudioEngine } from './audio-engine.js';
import { UIState } from './ui-state.js';

// Inicialización de componentes
const ui = new UIState();
const ws = new WsClient();
const sync = new SyncEngine(ws);
const audio = new AudioEngine(sync);

let currentAudioUrl = null;
let userOffsetMs = 0; // Slider eliminado, valor por defecto
let telemetryInterval = null;
let uiUpdateInterval = null;

// Registro de vistas UI
ui.registerElement('disconnected', 'view-disconnected');
ui.registerElement('load-prompt', 'view-load-prompt');
ui.registerElement('loading', 'view-loading');
ui.registerElement('syncing', 'view-syncing');
ui.registerElement('ready', 'view-ready');
ui.registerElement('playing', 'view-playing');

// Botón de Refrescar
document.getElementById('btn-refresh').addEventListener('click', () => {
  window.location.reload();
});

// Botón de Pantalla Completa
document.getElementById('btn-fullscreen').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(err => {
      console.warn(`Error al intentar entrar en pantalla completa: ${err.message}`);
    });
  } else {
    document.exitFullscreen();
  }
});

// ---- Loop de actualización de UI de Debug (Permanente) ----
function startUIUpdateLoop() {
  if (uiUpdateInterval) return;
  
  const els = {
    samples: document.getElementById('sync-samples-count'),
    conf: document.getElementById('sync-confidence'),
    rtt: document.getElementById('sync-rtt'),
    purity: document.getElementById('sync-purity'),
    drift: document.getElementById('display-drift-live'),
    ctxTime: document.getElementById('dbg-ctx-time'),
    startAt: document.getElementById('dbg-start-at'),
    position: document.getElementById('dbg-position'),
    sample: document.getElementById('dbg-sample'),
    corrections: document.getElementById('dbg-corrections')
  };

  uiUpdateInterval = setInterval(() => {
    // Sync Stats
    if (els.samples) els.samples.textContent = sync.samples.length;
    if (els.conf) els.conf.textContent = Math.round(sync.confidence * 100);
    if (els.rtt) els.rtt.textContent = sync.bestRtt === Infinity ? '?' : Math.round(sync.bestRtt);
    
    const total = (sync.pureCount || 0) + (sync.impureCount || 0);
    const purity = total > 0 ? Math.round((sync.pureCount / total) * 100) : 0;
    if (els.purity) {
      els.purity.textContent = purity + '%';
      els.purity.style.color = purity > 80 ? '#55efc4' : (purity > 50 ? '#fdcb6e' : '#ff7675');
    }

    // Audio Engine raw values
    if (audio.audioCtx) {
      if (els.ctxTime) els.ctxTime.textContent = audio.audioCtx.currentTime.toFixed(2);
      if (els.startAt) els.startAt.textContent = audio.playStartCtxTime.toFixed(2);
    }
    
    const pos = audio.getCurrentPosition();
    if (els.position) els.position.textContent = pos >= 0 ? pos.toFixed(2) : 'N/A';
    if (els.sample) els.sample.textContent = audio.getCurrentSample();
    if (els.corrections) els.corrections.textContent = audio.driftCorrectionCount || 0;

    // Drift Live
    if (audio.isPlaying && audio.lastDriftMs !== undefined) {
      const d = Math.round(audio.lastDriftMs);
      if (els.drift) {
        els.drift.textContent = `drift: ${d > 0 ? '+' : ''}${d}ms`;
        els.drift.style.color = Math.abs(d) < 30 ? '#55efc4' : '#ff7675';
      }
    } else if (els.drift) {
      els.drift.textContent = '';
    }
  }, 300);
}

// ---- Telemetría: reporte periódico de posición al director ----
function startTelemetryReporting() {
  stopTelemetryReporting();
  telemetryInterval = setInterval(() => {
    if (!audio.isPlaying) return;
    const snap = audio.getTelemetrySnapshot();
    ws.send('telemetry', snap);

    // Update position display on this device
    const posEl = document.getElementById('playing-position');
    if (posEl && snap.currentPositionSec >= 0) {
      const m = Math.floor(snap.currentPositionSec / 60);
      const s = Math.floor(snap.currentPositionSec % 60);
      const ms = Math.floor((snap.currentPositionSec % 1) * 1000);
      posEl.textContent = `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    }
  }, 100);
}

function stopTelemetryReporting() {
  if (telemetryInterval) {
    clearInterval(telemetryInterval);
    telemetryInterval = null;
  }
}

// ---- Eventos de WebSocket ----
ws.on('open', () => {
  startUIUpdateLoop();
  if (!currentAudioUrl) {
    ui.transitionTo('load-prompt');
  }
});

ws.on('close', () => {
  sync.stop();
  audio.stop();
  stopTelemetryReporting();
  ui.transitionTo('disconnected');
});

ws.on('welcome', (payload) => {
  // Mostrar ID del dispositivo
  document.getElementById('display-client-id').textContent = payload.clientId;

  if (payload.audioFile) {
    currentAudioUrl = `/audio/${payload.audioFile}`;
    ui.transitionTo('load-prompt');
    const displayName = payload.audioDisplayName || payload.audioFile;
    document.getElementById('display-track-name').textContent = displayName;
  } else {
    ui.transitionTo('load-prompt');
    document.getElementById('btn-load-audio').disabled = true;
    document.getElementById('btn-load-audio').textContent = 'Esperando track...';
    document.getElementById('display-track-name').textContent = 'Esperando Track...';
  }
});

ws.on('load_audio', (payload) => {
  currentAudioUrl = payload.url;
  const btn = document.getElementById('btn-load-audio');
  btn.disabled = false;
  btn.textContent = 'Cargar Audio';
  
  const displayName = payload.displayName || payload.url.split('/').pop();
  document.getElementById('display-track-name').textContent = displayName;

  if (ui.getCurrent() === 'ready' || ui.getCurrent() === 'playing') {
    audio.stop();
    stopTelemetryReporting();
    ui.transitionTo('load-prompt');
  }
});

ws.on('play', (payload) => {
  if (ui.getCurrent() !== 'ready') return;
  ui.transitionTo('playing');
  const telemetry = audio.schedulePlay(payload.targetTime, userOffsetMs);
  ws.send('play_ack', { ...telemetry, serverSentAt: payload.serverSentAt || 0 });
  startTelemetryReporting();
});

ws.on('stop', () => {
  audio.stop();
  stopTelemetryReporting();
  if (ui.getCurrent() === 'playing') {
    ui.transitionTo('ready');
  }
});

ws.on('drift_correct', (payload) => {
  console.log(`[WS] Drift correct received: ${payload.driftMs}ms`);
  if (audio.isPlaying) {
    audio.correctDrift(payload.driftMs);
  }
});

// ---- Botón de carga ----
document.getElementById('btn-load-audio').addEventListener('click', async () => {
  if (!currentAudioUrl) return;

  ui.transitionTo('loading');
  const bar = document.getElementById('loading-bar');
  const text = document.getElementById('loading-text');

  try {
    await audio.init();

    const duration = await audio.loadAudio(currentAudioUrl, (progress) => {
      bar.style.width = `${progress * 100}%`;
      if (progress === 1) text.textContent = 'Decodificando audio...';
    });
    ws.send('audio_loaded', { duration });

    // Iniciar sync
    ui.transitionTo('syncing');
    sync.start();

    // Monitorear para pasar a READY
    const checkReady = setInterval(() => {
      if (sync.confidence > 0.7 && sync.samples.length >= 5) {
        clearInterval(checkReady);
        ui.transitionTo('ready');
        const wlEl = document.getElementById('wake-lock-status');
        if (wlEl && audio.wakeLock) wlEl.style.display = 'inline';
      }
    }, 500);

  } catch (err) {
    console.error('Error cargando audio:', err);
    text.textContent = 'Error al cargar. Toca para reintentar.';
    ui.transitionTo('load-prompt');
  }
});

// Iniciar conexión
ws.connect('musician');
