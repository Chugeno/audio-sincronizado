// public/js/musician-app.js
import { WsClient } from './ws-client.js';
import { SyncEngine } from './sync-engine.js';
import { AudioEngine } from './audio-engine.js';
import { UIState } from './ui-state.js';
import { ClientRTCManager } from './rtc-client.js';

const ui = new UIState();
ui.registerElement('disconnected', 'view-disconnected');
ui.registerElement('load-prompt', 'view-load-prompt');
ui.registerElement('loading', 'view-loading');
ui.registerElement('syncing', 'view-syncing');
ui.registerElement('ready', 'view-ready');
ui.registerElement('playing', 'view-playing');

// URL params para la sala P2P
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('room');

if (!roomId) {
    document.getElementById('display-track-name').textContent = "⚠️ Link inválido: Falta la sala en la URL.";
    ui.transitionTo('load-prompt');
    document.getElementById('btn-load-audio').disabled = true;
    document.getElementById('btn-load-audio').textContent = 'Error';
}

const ws = new WsClient();
const rtc = new ClientRTCManager(ws, roomId);

// --- Adaptador P2P para el SyncEngine ---
// El SyncEngine original esperaba un WebSocket, le pasamos esto para que envíe sus
// paquetes NTP Huygens directamente por el DataChannel de WebRTC sin tocar su código.
const p2pSyncAdapter = {
    events: {},
    on: function(ev, cb) { this.events[ev] = cb; },
    send: function(type, payload) {
        if (type === 'sync_ping') {
            rtc.send({ type: 'ping_req', payload });
        } else if (type === 'status') {
            rtc.send({ type: 'telemetry', payload }); // Enviamos estado como telemetría general
        }
    },
    isConnected: () => rtc.dc && rtc.dc.readyState === 'open'
};

const sync = new SyncEngine(p2pSyncAdapter);
const audio = new AudioEngine(sync);

let currentAudioUrl = null;
let userOffsetMs = parseInt(localStorage.getItem('syncorchestra_user_offset'), 10) || 0;
let telemetryInterval = null;
let uiUpdateInterval = null;

// ---- Persistencia de correcciones ----
audio.onCorrection = (driftMs) => {
  userOffsetMs = (userOffsetMs || 0) - driftMs;
  localStorage.setItem('syncorchestra_user_offset', userOffsetMs);
  console.log(`[Calibración] Offset acumulado: ${userOffsetMs}ms`);
  rtc.send({ type: 'telemetry', payload: { userOffsetMs } });
};

// ---- Botones UI Generales ----
document.getElementById('btn-refresh').addEventListener('click', () => window.location.reload());
document.getElementById('btn-fullscreen').addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(()=>{}());
  else document.exitFullscreen();
});

// ---- Loop de UI Debug ----
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
    position: document.getElementById('dbg-position')
  };

  uiUpdateInterval = setInterval(() => {
    if (els.samples) els.samples.textContent = sync.samples.length;
    if (els.conf) els.conf.textContent = Math.round(sync.confidence * 100);
    if (els.rtt) els.rtt.textContent = sync.bestRtt === Infinity ? '?' : Math.round(sync.bestRtt);
    
    const total = (sync.pureCount || 0) + (sync.impureCount || 0);
    const purity = total > 0 ? Math.round((sync.pureCount / total) * 100) : 0;
    if (els.purity) {
      els.purity.textContent = purity + '%';
      els.purity.style.color = purity > 80 ? '#55efc4' : (purity > 50 ? '#fdcb6e' : '#ff7675');
    }

    if (audio.audioCtx) {
      if (els.ctxTime) els.ctxTime.textContent = audio.audioCtx.currentTime.toFixed(2);
      if (els.startAt) els.startAt.textContent = audio.playStartCtxTime.toFixed(2);
    }
    
    const pos = audio.getCurrentPosition();
    if (els.position) els.position.textContent = pos >= 0 ? pos.toFixed(2) : 'N/A';

    if (audio.isPlaying && audio.lastDriftMs !== undefined) {
      const d = Math.round(audio.lastDriftMs);
      if (els.drift) {
        els.drift.textContent = `drift: ${d > 0 ? '+' : ''}${d}ms`;
        els.drift.style.color = Math.abs(d) < 30 ? '#55efc4' : '#ff7675';
      }
    } else if (els.drift) els.drift.textContent = '';
  }, 300);
}

// ---- Telemetría hacia el Director (Vía WebRTC P2P) ----
function startTelemetryReporting() {
  stopTelemetryReporting();
  telemetryInterval = setInterval(() => {
    if (!audio.isPlaying) return;
    const snap = audio.getTelemetrySnapshot();
    snap.clientNow = sync.now();
    snap.state = window.uiState ? window.uiState.getCurrent() : 'connecting';
    rtc.send({ type: 'telemetry', payload: snap });

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

// ===============================================
// EVENTOS SIGNALING (NUBE) - Solo para Conectar
// ===============================================
ws.on('open', () => {
  if (!roomId) return;
  startUIUpdateLoop();
  ws.send('join_room', { roomId, role: 'musician' });
  ui.transitionTo('load-prompt');
  document.getElementById('display-track-name').textContent = "Esperando Director P2P...";
  document.getElementById('btn-load-audio').disabled = true;
});

ws.on('welcome', (payload) => {
  document.getElementById('display-client-id').textContent = payload.clientId;
});

ws.on('webrtc_offer', async (payload) => await rtc.handleOffer(payload.sdp));
ws.on('webrtc_ice_candidate', async (payload) => await rtc.handleIceCandidate(payload.candidate));

ws.on('close', () => {
  sync.stop();
  audio.stop();
  stopTelemetryReporting();
  ui.transitionTo('disconnected');
});

// ===============================================
// EVENTOS WEBRTC (P2P DIRECTO CERO LATENCIA)
// ===============================================
rtc.onConnected = () => {
  console.log('[Musician] Conectado P2P con el Director!');
  document.getElementById('display-track-name').textContent = "P2P Conectado. Esperando Audio...";
  
  // Enviamos telemetría inicial
  rtc.send({ type: 'telemetry', payload: { userOffsetMs, state: ui.getCurrent() } });
};

rtc.onDisconnected = () => {
  console.log('[Musician] P2P Desconectado!');
  sync.stop();
  audio.stop();
  ui.transitionTo('load-prompt');
  document.getElementById('display-track-name').textContent = "Director desconectado...";
};

rtc.onMessageReceived = (msg) => {
  const { type, payload } = msg;

  if (type === 'sync_pong') {
    // Pasar directo al adaptador que escucha el SyncEngine
    if (p2pSyncAdapter.events['sync_pong']) p2pSyncAdapter.events['sync_pong'](payload);
  } 
  else if (type === 'cmd_set_audio') {
    currentAudioUrl = `/audio/${payload.filename}`; // Se descarga desde el servidor clásico temporalmente
    const btn = document.getElementById('btn-load-audio');
    btn.disabled = false;
    btn.textContent = 'Cargar Audio';
    document.getElementById('display-track-name').textContent = payload.displayName;
    
    if (ui.getCurrent() === 'ready' || ui.getCurrent() === 'playing') {
      audio.stop();
      stopTelemetryReporting();
      ui.transitionTo('load-prompt');
    }
  }
  else if (type === 'cmd_play') {
    if (ui.getCurrent() !== 'ready') return;
    ui.transitionTo('playing');
    const telemetry = audio.schedulePlay(payload.targetTime, userOffsetMs);
    rtc.send({ type: 'play_ack', payload: { ...telemetry, serverSentAt: payload.serverSentAt } });
    startTelemetryReporting();
  }
  else if (type === 'cmd_stop') {
    audio.stop();
    stopTelemetryReporting();
    if (ui.getCurrent() === 'playing') ui.transitionTo('ready');
  }
  else if (type === 'play_calibration_mp3') {
    audio.scheduleCalibrationPlay(payload.targetTime, userOffsetMs);
  }
  else if (type === 'drift_correct') {
    if (audio.isPlaying) audio.correctDrift(payload.driftMs);
  }
  else if (type === 'set_calibration') {
    userOffsetMs = payload.offsetMs;
    localStorage.setItem('syncorchestra_user_offset', userOffsetMs);
    sync.recalculate();
  }
  else if (type === 'disable_auto_sync_all' || type === 'toggle_auto_sync') {
    // audio-engine no maneja esto como variable global directamente en este código,
    // asumo que lo manejarán o se pasaba por WS
    // Si queremos apagarlo, la app anterior solo paraba las correcciones.
  }
  else if (type === 'manual_seek' || type === 'force_sync_all') {
     // A implementar o delegar
     if (type === 'manual_seek') audio.correctDrift(payload.deltaMs);
  }
};

// ---- Botón de carga ----
document.getElementById('btn-load-audio').addEventListener('click', async () => {
  if (!currentAudioUrl) return;

  ui.transitionTo('loading');
  const bar = document.getElementById('loading-bar');
  const text = document.getElementById('loading-text');

  try {
    await audio.init();
    audio.loadCalibrationAudio();

    const duration = await audio.loadAudio(currentAudioUrl, (progress) => {
      bar.style.width = `${progress * 100}%`;
      if (progress === 1) text.textContent = 'Decodificando audio...';
    });
    
    rtc.send({ type: 'telemetry', payload: { state: 'syncing', duration } });

    ui.transitionTo('syncing');
    sync.start(); // Esto ahora envía pings por WebRTC

    const checkReady = setInterval(() => {
      if (sync.confidence > 0.7 && sync.samples.length >= 5) {
        clearInterval(checkReady);
        ui.transitionTo('ready');
        window.uiState = ui;
        rtc.send({ type: 'telemetry', payload: { state: 'ready' } });
        const wlEl = document.getElementById('wake-lock-status');
        if (wlEl && audio.wakeLock) wlEl.style.display = 'inline';
      }
    }, 500);

  } catch (err) {
    text.textContent = 'Error al cargar. Toca para reintentar.';
    ui.transitionTo('load-prompt');
  }
});

// Iniciar WebSocket de Señalización
ws.connect('musician');
