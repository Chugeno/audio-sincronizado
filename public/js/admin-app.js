// public/js/admin-app.js
import { WsClient } from './ws-client.js';

const ws = new WsClient();

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

// State
let roomData = { clients: [], state: 'idle' };
let playAcks = new Map();   // clientId → play_ack telemetry
let telemetryData = new Map(); // clientId → latest telemetry

// --- WebSocket Events ---
ws.on('open', () => {
  statusEl.textContent = '🟢 Conectado';
  statusEl.style.color = '#2ecc71';
});

ws.on('close', () => {
  statusEl.textContent = '🔴 Desconectado';
  statusEl.style.color = '#e74c3c';
  btnPlay.disabled = true;
  btnStop.disabled = true;
});

ws.on('room_state', (payload) => {
  roomData = payload;
  updateDashboard();
});

ws.on('play_dispatched', (payload) => {
  // Server tells us: "I sent play at this time with this target"
  playAcks.clear();
  addLogEntry('🎬 DIRECTOR', `PLAY enviado. Target: +${payload.delayMs}ms en el futuro`, 'good');
  addLogEntry('🎬 DIRECTOR', `Server timestamp al enviar: ${payload.serverSentAt.toFixed(2)}`, '');
  addLogEntry('🎬 DIRECTOR', `Target timestamp: ${payload.targetTime.toFixed(2)}`, '');
  renderTimeline(payload);
});

ws.on('play_ack', (payload) => {
  playAcks.set(payload.clientId, payload);
  const delayStr = payload.delayToTargetMs.toFixed(1);
  const rttStr = payload.syncRttBest >= 0 ? payload.syncRttBest.toFixed(1) : '?';
  const hwStr = payload.hwLatencyMs.toFixed(1);
  const offsetStr = payload.syncOffset.toFixed(1);
  const confStr = (payload.syncConfidence * 100).toFixed(0);

  addLogEntry(`📱 ${payload.clientId}`, `ACK recibido`, 'good');
  addLogEntry(`📱 ${payload.clientId}`, `  Delay hasta target: ${delayStr}ms | Mejor RTT: ${rttStr}ms`, '');
  addLogEntry(`📱 ${payload.clientId}`, `  HW Latency: ${hwStr}ms | User Offset: ${payload.userOffsetMs}ms`, '');
  addLogEntry(`📱 ${payload.clientId}`, `  Sync Offset: ${offsetStr}ms | Confianza: ${confStr}%`, '');
  addLogEntry(`📱 ${payload.clientId}`, `  Scheduled AudioCtx time: ${payload.scheduledCtxTime.toFixed(4)}s`, '');

  updateTimelineWithAcks();
});

ws.on('telemetry', (payload) => {
  telemetryData.set(payload.clientId, payload);
  // Update table is handled by room_state + merge
});

// --- Delay slider ---
delaySlider.addEventListener('input', (e) => {
  delayVal.textContent = e.target.value;
});

// --- Control Buttons ---
btnPlay.addEventListener('click', () => {
  const delayMs = parseInt(delaySlider.value, 10);
  ws.send('cmd_play', { delayMs });
});

btnStop.addEventListener('click', () => {
  ws.send('cmd_stop', {});
  telemetryData.clear();
  addLogEntry('🎬 DIRECTOR', 'STOP enviado', 'warn');
});

// Global Sync Controls
btnDisableAutoAll?.addEventListener('click', () => {
  if (confirm('¿Seguro que querés desactivar el auto-ajuste para todos los músicos?')) {
    ws.send('disable_auto_sync_all', {});
    addLogEntry('🎬 DIRECTOR', 'Enviado comando: Apagar Auto-Sync global', 'warn');
  }
});

btnSyncAllNow?.addEventListener('click', () => {
  ws.send('force_sync_all', {});
  addLogEntry('🎬 DIRECTOR', 'Enviado comando: Forzar ajuste a todos los músicos', 'good');
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
  uploadStatus.textContent = '⏳ Subiendo audio...';
  uploadStatus.style.color = '#f39c12';

  const formData = new FormData();
  formData.append('audioFile', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (res.ok) {
      uploadStatus.textContent = '✅ Subido. Notificando...';
      uploadStatus.style.color = '#2ecc71';
      ws.send('cmd_set_audio', { 
        filename: data.filename, 
        displayName: data.displayName 
      });
      addLogEntry('🎬 DIRECTOR', `Audio subido: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`, 'good');
    } else {
      throw new Error(data.error);
    }
  } catch (e) {
    uploadStatus.textContent = `❌ Error: ${e.message}`;
    uploadStatus.style.color = '#e74c3c';
  }
}

// --- Log ---
btnClearLog.addEventListener('click', () => {
  eventLog.innerHTML = '';
});

function addLogEntry(client, message, type) {
  const now = new Date();
  const ts = now.toLocaleTimeString('es-AR', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
  const typeClass = type === 'good' ? 'style="color:#55efc4"' :
                    type === 'warn' ? 'style="color:#fdcb6e"' :
                    type === 'bad'  ? 'style="color:#ff7675"' : '';

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-ts">${ts}</span> <span class="log-client">${client}</span> <span class="log-msg" ${typeClass}>${message}</span>`;
  eventLog.prepend(entry);

  // Limitar a 200 entradas
  while (eventLog.children.length > 200) {
    eventLog.removeChild(eventLog.lastChild);
  }
}

function updateDashboard() {
  const displayName = roomData.audioDisplayName || 'Ninguno';
  currentAudio.textContent = `Track: ${displayName}`;

  if (roomData.clients.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; opacity: 0.5;">Sin músicos conectados</td></tr>';
    roomStatusInd.className = 'status-badge state-connecting';
    roomStatusInd.textContent = 'Esperando Músicos...';
    btnPlay.disabled = true;
    btnStop.disabled = true;
    return;
  }

  let allReady = true;
  let anyPlaying = false;

  roomData.clients.forEach(c => {
    const timeSinceLastPing = Date.now() - c.lastSeen;
    const isStale = timeSinceLastPing > 10000;

    let stateClass = `state-${c.state}`;
    let stateLabel = c.state ? c.state.toUpperCase() : 'UNKNOWN';
    if (isStale) { stateClass = 'state-connecting'; stateLabel = 'ZOMBIE'; }
    
    if (c.state !== 'ready' && c.state !== 'playing') allReady = false;
    if (c.state === 'playing') anyPlaying = true;

    // Buscar o crear la fila del cliente
    let tr = tbody.querySelector(`tr[data-id="${c.id}"]`);
    if (!tr) {
      tr = document.createElement('tr');
      tr.dataset.id = c.id;
      // Estructura base de celdas
      tr.innerHTML = `
        <td class="cell-id"></td>
        <td class="cell-state"></td>
        <td class="cell-offset"></td>
        <td class="cell-rtt"></td>
        <td class="cell-conf"></td>
        <td class="cell-samples"></td>
        <td class="cell-drift"></td>
        <td class="cell-pos"></td>
        <td class="cell-adjust"></td>
        <td class="cell-auto"></td>
      `;
      tbody.appendChild(tr);

      // Agregar eventos una sola vez al crear la fila
      const adjustCell = tr.querySelector('.cell-adjust');
      adjustCell.innerHTML = `
        <div style="display:flex; gap:2px;">
           <input type="number" class="seek-input" value="0" style="width:40px; font-size:0.7em; background:#222; color:#fff; border:1px solid #444; border-radius:3px; padding:2px;">
           <button class="btn-seek-manual" style="font-size:0.7em; padding:2px 4px; cursor:pointer; background:#bb86fc; color:#000; border:none; border-radius:3px; font-weight:bold;">Seek</button>
        </div>
      `;
      
      const autoCell = tr.querySelector('.cell-auto');
      autoCell.innerHTML = `<input type="checkbox" class="toggle-auto" title="Auto-Sync Drift">`;

      // Evento Seek
      adjustCell.querySelector('.btn-seek-manual').addEventListener('click', () => {
        const input = adjustCell.querySelector('.seek-input');
        const deltaMs = parseInt(input.value, 10);
        if (isNaN(deltaMs)) return;
        ws.send('manual_seek', { targetClientId: c.id, deltaMs });
      });

      // Evento Auto-Sync
      autoCell.querySelector('.toggle-auto').addEventListener('change', (e) => {
        ws.send('toggle_auto_sync', { targetClientId: c.id });
      });
    }

    // ACTUALIZACIÓN QUIRÚRGICA DE CELDAS
    tr.querySelector('.cell-id').innerHTML = `<pre>${c.id.substring(0,6)}</pre>`;
    tr.querySelector('.cell-state').innerHTML = `<span class="status-badge ${stateClass}">${stateLabel}</span>`;
    tr.querySelector('.cell-offset').innerHTML = `<pre>${c.syncOffset.toFixed(1)}ms</pre>`;
    tr.querySelector('.cell-rtt').innerHTML = `<pre>${c.bestRtt.toFixed(1)}ms</pre>`;
    tr.querySelector('.cell-conf').textContent = `${(c.confidence * 100).toFixed(0)}%`;
    tr.querySelector('.cell-samples').textContent = c.samples || 0;

    // Drift
    const driftVal = c.lastDriftMs || 0;
    const absDrift = Math.abs(driftVal);
    let driftColor = absDrift < 15 ? '#55efc4' : (absDrift < 100 ? '#fdcb6e' : '#ff7675');
    let driftLabel = absDrift < 15 ? 'OK' : `${driftVal > 0 ? '+' : ''}${driftVal}ms`;
    tr.querySelector('.cell-drift').innerHTML = c.isPlaying 
      ? `<span style="color:${driftColor}; font-weight: bold;">${driftLabel}</span>` 
      : '<span style="opacity:0.3">—</span>';

    // Posición
    const rawPos = c.currentPositionSec || 0;
    const rawSample = c.currentSample || 0;
    tr.querySelector('.cell-pos').innerHTML = c.isPlaying
      ? `<span style="font-size:0.85em">${rawPos.toFixed(2)}s<br><span style="opacity:0.5">s${rawSample}</span></span>`
      : '<span style="opacity:0.3">—</span>';

    // Inputs (Solo actualizar si NO tienen el foco y el valor cambió)
    const seekInput = tr.querySelector('.seek-input');
    if (document.activeElement !== seekInput && !c.isPlaying) {
      seekInput.value = 0; // Reset si no está reproduciendo
    }
    
    const autoCheckbox = tr.querySelector('.cell-auto .toggle-auto');
    const serverAutoSync = c.autoSync !== false;
    if (autoCheckbox.checked !== serverAutoSync) {
      autoCheckbox.checked = serverAutoSync;
    }
  });

  // Limpiar filas de clientes que ya no están
  const currentIds = roomData.clients.map(c => c.id);
  tbody.querySelectorAll('tr').forEach(tr => {
    if (tr.dataset.id && !currentIds.includes(tr.dataset.id)) {
      tr.remove();
    }
  });

  // Room indicator & buttons
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
    // Allow play even if not all ready (might want to test)
    btnPlay.disabled = false;
    btnStop.disabled = true;
  }
}

// --- Timeline ---
function renderTimeline(playData) {
  playTimeline.style.display = 'block';
  timelineContent.innerHTML = `
    <div class="timeline-event">
      <span class="ts">T+0ms</span>
      <span class="label">Servidor envía PLAY</span>
      <span class="value">(margen: ${playData.delayMs}ms)</span>
    </div>
    <div class="timeline-event">
      <span class="ts">T+${playData.delayMs}ms</span>
      <span class="label">🎯 TARGET: Todos deben sonar aquí</span>
      <span class="value good">↓</span>
    </div>
    <div id="timeline-acks"></div>
  `;
}

function updateTimelineWithAcks() {
  const container = document.getElementById('timeline-acks');
  if (!container) return;

  let html = '<hr style="border-color: rgba(255,255,255,0.1); margin: 8px 0;">';
  html += '<div style="color: #bb86fc; margin-bottom: 4px;">Respuestas de músicos:</div>';

  for (const [clientId, ack] of playAcks.entries()) {
    const quality = ack.delayToTargetMs > 100 ? 'good' :
                    ack.delayToTargetMs > 0 ? 'warn' : 'bad';
    const icon = quality === 'good' ? '✅' : quality === 'warn' ? '⚠️' : '❌';

    html += `
      <div class="timeline-event ${quality}">
        <span class="ts">${icon} ${clientId.substring(0, 6)}</span>
        <span class="label">Recibió orden con</span>
        <span class="value">${ack.delayToTargetMs.toFixed(0)}ms de margen</span>
      </div>
      <div class="timeline-event">
        <span class="ts"></span>
        <span class="label" style="font-size:0.75rem; opacity:0.6;">
          sync: ${ack.syncOffset.toFixed(1)}ms | rtt: ${ack.syncRttBest >= 0 ? ack.syncRttBest.toFixed(1) : '?'}ms | hw: ${ack.hwLatencyMs.toFixed(1)}ms | user: ${ack.userOffsetMs}ms
        </span>
      </div>
    `;
  }

  container.innerHTML = html;
}

// --- Helpers ---
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// --- Init ---
ws.connect('director');
