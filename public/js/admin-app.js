// public/js/admin-app.js
import { WsClient } from './ws-client.js';
import { HostRTCManager } from './rtc-host.js';

const roomId = 'sala' + Math.floor(Math.random() * 10000);
const ws = new WsClient();
const hostRtc = new HostRTCManager(ws, roomId);

// UI Elements
const statusEl = document.getElementById('connection-status');
const tbody = document.getElementById('clients-tbody');
const btnPlay = document.getElementById('btn-play');
const btnStop = document.getElementById('btn-stop');
const btnDisableAutoAll = document.getElementById('btn-disable-auto-all');
const btnSyncAllNow = document.getElementById('btn-sync-all-now');

const roomStatusInd = document.getElementById('room-status-indicator');
const delaySlider = document.getElementById('delay-slider');
const delayVal = document.getElementById('delay-val');
const currentAudio = document.getElementById('current-audio');
const fileInput = document.getElementById('file-input');
const dropZone = document.getElementById('drop-zone');
const uploadStatus = document.getElementById('upload-status');
const playTimeline = document.getElementById('play-timeline');
const timelineContent = document.getElementById('timeline-content');
const eventLog = document.getElementById('event-log');
const btnClearLog = document.getElementById('btn-clear-log');

// State P2P Local
let roomData = { clients: [], state: 'idle' };
let playAcks = new Map();   // clientId → play_ack telemetry
let telemetryData = new Map(); // clientId → latest telemetry

// Generar estado de sala simulando al servidor anterior
setInterval(() => {
  const clients = [];
  telemetryData.forEach((data, id) => {
    clients.push({
      id: id,
      state: data.state || 'connecting',
      syncOffset: data.syncOffset || 0,
      bestRtt: hostRtc.rtts.get(id) || 0,
      confidence: data.confidence || 0,
      samples: data.samples || 0,
      isPlaying: data.isPlaying || false,
      currentPositionSec: data.currentPositionSec || 0,
      currentSample: data.currentSample || 0,
      lastDriftMs: data.lastDriftMs || 0,
      userOffsetMs: data.userOffsetMs || 0,
      autoSync: data.autoSync !== false,
      lastSeen: Date.now()
    });
  });
  roomData.clients = clients;
  updateDashboard();
}, 500);

// --- WebSocket Events (Señalización) ---
ws.on('open', () => {
  statusEl.textContent = '🟢 Conectado al Signaling';
  statusEl.style.color = '#2ecc71';
  ws.send('join_room', { roomId, role: 'director' });
});

ws.on('close', () => {
  statusEl.textContent = '🔴 Desconectado';
  statusEl.style.color = '#e74c3c';
  btnPlay.disabled = true;
  btnStop.disabled = true;
});

ws.on('welcome', (payload) => {
  addLogEntry('ADMIN', `Señalización lista. Sala: ${roomId}`, 'ok');

  const currentHost = window.location.hostname;
  const protocol = window.location.protocol;
  const port = window.location.port ? `:${window.location.port}` : '';
  const connectionUrl = `${protocol}//${currentHost}${port}/?room=${roomId}`;

  const linkEl = document.getElementById('connection-link');
  if (linkEl) {
    linkEl.href = connectionUrl;
    linkEl.textContent = connectionUrl.replace(/^https?:\/\//, '');
  }

  const qrContainer = document.getElementById('qrcode');
  if (qrContainer) {
    qrContainer.innerHTML = ''; 
    try {
      new QRCode(qrContainer, {
        text: connectionUrl,
        width: 120,
        height: 120,
        colorDark: "#1a1a2e",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
      });
    } catch (e) {
      console.error("Error QR:", e);
    }
  }
});

// Eventos del Signaling para WebRTC
ws.on('musician_joined', (payload) => hostRtc.createPeer(payload.clientId));
ws.on('webrtc_answer', (payload) => hostRtc.handleAnswer(payload.fromClientId, payload.sdp));
ws.on('webrtc_ice_candidate', (payload) => hostRtc.handleIceCandidate(payload.fromClientId, payload.candidate));
ws.on('musician_left', (payload) => {
    hostRtc.removePeer(payload.clientId);
    telemetryData.delete(payload.clientId);
});

// Eventos de los DataChannels WebRTC
hostRtc.onPeerConnected = (clientId) => {
  addLogEntry('P2P', `Conexión Directa OK con Músico ${clientId.substring(0,6)}`, 'good');
};
hostRtc.onPeerDisconnected = (clientId) => {
  addLogEntry('P2P', `Músico desconectado: ${clientId.substring(0,6)}`, 'err');
};
hostRtc.onMessageReceived = (clientId, msg) => {
  if (msg.type === 'telemetry') {
    // Merge con data existente
    const existing = telemetryData.get(clientId) || {};
    telemetryData.set(clientId, { ...existing, ...msg.payload, lastSeen: Date.now() });
  } else if (msg.type === 'play_ack') {
    playAcks.set(clientId, msg.payload);
    addLogEntry(`📱 ${clientId.substring(0,6)}`, `ACK: ${msg.payload.delayToTargetMs.toFixed(1)}ms de margen.`, 'ok');
    updateTimelineWithAcks();
  } else if (msg.type === 'ping_req') {
     // El músico nos pide la hora exacta para sincronizar (NTP Huygens protocol)
     const t2 = performance.now();
     hostRtc.sendTo(clientId, {
         type: 'sync_pong',
         payload: {
             t1: msg.payload.t1,
             probeGroupId: msg.payload.probeGroupId,
             probeGroupIndex: msg.payload.probeGroupIndex,
             t2: t2,
             t3: performance.now()
         }
     });
  }
};

// --- Delay slider ---
delaySlider.addEventListener('input', (e) => {
  delayVal.textContent = e.target.value;
});

// --- Control Buttons ---
btnPlay.addEventListener('click', () => {
  const delayMs = parseInt(delaySlider.value, 10);
  const now = performance.now();
  const playCmd = {
      type: 'cmd_play',
      payload: { delayMs, serverSentAt: now, targetTime: now + delayMs }
  };
  
  hostRtc.broadcast(playCmd);
  
  playAcks.clear();
  addLogEntry('🎬 DIRECTOR', `PLAY enviado. Target: +${delayMs}ms en el futuro`, 'good');
  renderTimeline(playCmd.payload);
});

btnStop.addEventListener('click', () => {
  hostRtc.broadcast({ type: 'cmd_stop', payload: {} });
  addLogEntry('🎬 DIRECTOR', 'STOP enviado (WebRTC)', 'warn');
});

// Global Sync Controls
btnDisableAutoAll?.addEventListener('click', () => {
  if (confirm('¿Seguro?')) {
    hostRtc.broadcast({ type: 'disable_auto_sync_all', payload: {} });
  }
});

btnSyncAllNow?.addEventListener('click', () => {
  hostRtc.broadcast({ type: 'force_sync_all', payload: {} });
  addLogEntry('🎬 DIRECTOR', 'Comando: Forzar ajuste P2P a todos', 'good');
});

// --- File Upload ---
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = '#8ab4f8'; });
dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = 'rgba(255,255,255,0.15)'; });
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.style.borderColor = 'rgba(255,255,255,0.15)';
  if (e.dataTransfer.files.length) handleFileUpload(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', (e) => {
  if (e.target.files.length) handleFileUpload(e.target.files[0]);
});

async function handleFileUpload(file) {
  if (!file.type.includes('audio')) {
    uploadStatus.textContent = '❌ Error: Sube un archivo MP3.';
    uploadStatus.style.color = '#e74c3c';
    return;
  }
  uploadStatus.textContent = '⏳ Subiendo audio al servidor de archivos...';
  uploadStatus.style.color = '#f39c12';

  const formData = new FormData();
  formData.append('audioFile', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (res.ok) {
      uploadStatus.textContent = '✅ Subido. Transmitiendo info...';
      uploadStatus.style.color = '#2ecc71';
      roomData.audioDisplayName = file.name;
      
      // Enviar la ruta del MP3 a los músicos para que lo descarguen
      hostRtc.broadcast({
          type: 'cmd_set_audio',
          payload: { filename: data.filename, displayName: file.name }
      });
      addLogEntry('🎬 DIRECTOR', `Track listo para P2P: ${file.name}`, 'good');
    } else {
      throw new Error(data.error);
    }
  } catch (e) {
    uploadStatus.textContent = `❌ Error: ${e.message}`;
    uploadStatus.style.color = '#e74c3c';
  }
}

// --- Dashboard Render ---
function updateDashboard() {
  const displayName = roomData.audioDisplayName || 'Ninguno';
  currentAudio.textContent = `Track: ${displayName}`;

  if (roomData.clients.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; opacity: 0.5;">Sin músicos conectados P2P</td></tr>';
    roomStatusInd.className = 'status-badge state-connecting';
    roomStatusInd.textContent = 'Esperando Músicos...';
    btnPlay.disabled = true;
    btnStop.disabled = true;
    return;
  }

  let allReady = true;
  let anyPlaying = false;

  roomData.clients.forEach(c => {
    let stateClass = `state-${c.state}`;
    let stateLabel = c.state ? c.state.toUpperCase() : 'UNKNOWN';
    
    if (c.state !== 'ready' && c.state !== 'playing') allReady = false;
    if (c.state === 'playing') anyPlaying = true;

    let tr = tbody.querySelector(`tr[data-id="${c.id}"]`);
    if (!tr) {
      tr = document.createElement('tr');
      tr.dataset.id = c.id;
      tr.innerHTML = `
        <td class="cell-id"></td>
        <td class="cell-state"></td>
        <td class="cell-offset"></td>
        <td class="cell-rtt"></td>
        <td class="cell-conf"></td>
        <td class="cell-samples"></td>
        <td class="cell-drift"></td>
        <td class="cell-pos"></td>
        <td class="cell-calib"></td>
        <td class="cell-adjust"></td>
        <td class="cell-auto"></td>
      `;
      tbody.appendChild(tr);

      const calibCell = tr.querySelector('.cell-calib');
      calibCell.innerHTML = `<input type="number" class="calib-input" value="0" step="10" style="width:45px;" title="Offset manual (ms)">`;
      const adjustCell = tr.querySelector('.cell-adjust');
      adjustCell.innerHTML = `
        <div style="display:flex; gap:2px;">
           <input type="number" class="seek-input" value="0" style="width:40px;">
           <button class="btn-seek-manual">Seek</button>
        </div>`;
      const autoCell = tr.querySelector('.cell-auto');
      autoCell.innerHTML = `<input type="checkbox" class="toggle-auto" title="Auto-Sync Drift">`;

      calibCell.querySelector('.calib-input').addEventListener('change', (e) => {
        const offsetMs = parseInt(e.target.value, 10);
        if (!isNaN(offsetMs)) hostRtc.sendTo(c.id, { type: 'set_calibration', payload: { offsetMs } });
      });
      adjustCell.querySelector('.btn-seek-manual').addEventListener('click', () => {
        const deltaMs = parseInt(tr.querySelector('.seek-input').value, 10);
        if (!isNaN(deltaMs)) hostRtc.sendTo(c.id, { type: 'manual_seek', payload: { deltaMs } });
      });
      autoCell.querySelector('.toggle-auto').addEventListener('change', () => {
        hostRtc.sendTo(c.id, { type: 'toggle_auto_sync', payload: {} });
      });
    }

    tr.querySelector('.cell-id').innerHTML = `<pre>${c.id.substring(0,6)}</pre>`;
    tr.querySelector('.cell-state').innerHTML = `<span class="status-badge ${stateClass}">${stateLabel}</span>`;
    tr.querySelector('.cell-offset').innerHTML = `<pre>${c.syncOffset.toFixed(1)}ms</pre>`;
    tr.querySelector('.cell-rtt').innerHTML = `<pre>${c.bestRtt.toFixed(1)}ms</pre>`;
    tr.querySelector('.cell-conf').textContent = `${(c.confidence * 100).toFixed(0)}%`;
    tr.querySelector('.cell-samples').textContent = c.samples || 0;

    const driftVal = c.lastDriftMs || 0;
    const absDrift = Math.abs(driftVal);
    let driftColor = absDrift < 15 ? '#55efc4' : (absDrift < 100 ? '#fdcb6e' : '#ff7675');
    tr.querySelector('.cell-drift').innerHTML = c.isPlaying 
      ? `<span style="color:${driftColor}; font-weight: bold;">${driftVal}ms</span>` 
      : '<span style="opacity:0.3">—</span>';

    const rawPos = c.currentPositionSec || 0;
    tr.querySelector('.cell-pos').innerHTML = c.isPlaying
      ? `<span style="font-size:0.85em">${rawPos.toFixed(2)}s</span>`
      : '<span style="opacity:0.3">—</span>';
  });

  const currentIds = roomData.clients.map(c => c.id);
  tbody.querySelectorAll('tr').forEach(tr => {
    if (tr.dataset.id && !currentIds.includes(tr.dataset.id)) tr.remove();
  });

  if (anyPlaying) {
    roomStatusInd.className = 'status-badge state-playing';
    roomStatusInd.textContent = '▶ EN EL AIRE';
    btnPlay.disabled = true;
    btnStop.disabled = false;
  } else if (allReady) {
    roomStatusInd.className = 'status-badge state-ready';
    roomStatusInd.textContent = '✅ SALA LISTA';
    btnPlay.disabled = false;
    btnStop.disabled = true;
  } else {
    roomStatusInd.className = 'status-badge state-syncing';
    roomStatusInd.textContent = '⏳ PREPARÁNDOSE...';
    btnPlay.disabled = false;
    btnStop.disabled = true;
  }
}

// --- Log Utilities ---
btnClearLog.addEventListener('click', () => { eventLog.innerHTML = ''; });
function addLogEntry(client, message, type) {
  const now = new Date();
  const ts = now.toLocaleTimeString('es-AR', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
  const typeClass = type === 'good' ? 'color:#55efc4' : type === 'warn' ? 'color:#fdcb6e' : type === 'err' ? 'color:#ff7675' : '';
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-ts">${ts}</span> <span class="log-client">${client}</span> <span class="log-msg" style="${typeClass}">${message}</span>`;
  eventLog.prepend(entry);
  if (eventLog.children.length > 200) eventLog.removeChild(eventLog.lastChild);
}

// --- Timeline Render ---
function renderTimeline(playData) {
  playTimeline.style.display = 'block';
  timelineContent.innerHTML = `
    <div class="timeline-event"><span class="ts">T+0ms</span> <span class="label">Director P2P PLAY</span></div>
    <div class="timeline-event"><span class="ts">T+${playData.delayMs}ms</span> <span class="label">🎯 TARGET P2P</span></div>
    <div id="timeline-acks"></div>
  `;
}
function updateTimelineWithAcks() {
  const container = document.getElementById('timeline-acks');
  if (!container) return;
  let html = '<hr style="border-color: rgba(255,255,255,0.1); margin: 8px 0;"><div style="color: #bb86fc;">Acks P2P:</div>';
  for (const [clientId, ack] of playAcks.entries()) {
    html += `<div class="timeline-event good"><span class="ts">✅ ${clientId.substring(0, 6)}</span> <span class="value">Margen: ${ack.delayToTargetMs.toFixed(0)}ms</span></div>`;
  }
  container.innerHTML = html;
}

ws.connect('director');
