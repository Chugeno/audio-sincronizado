// server/ws-handler.js
import { nanoid } from 'nanoid';
import os from 'os';
import { room, addClient, removeClient, updateClientState, broadcastToDirectors, broadcastToMusicians } from './room.js';
import { getServerTime } from './sync-clock.js';

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Filtrar IPv4 y no interna (localhost)
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

export function setupWsHandler(ws, req) {
  const clientId = nanoid(10);

  addClient(clientId, ws, 'musician');
  // Auto-sync del servidor desactivado por defecto.
  // El cliente se auto-corrige vía median filter. El servidor es sólo respaldo de emergencia.
  const clientState = room.clients.get(clientId);
  if (clientState) clientState.autoSync = false;

  ws.on('pong', () => {
    updateClientState(clientId, { lastSeen: Date.now() });
  });

  ws.on('message', (data) => {
    const message = data.toString();
    if (message === 'pong' || message === 'ping') {
      updateClientState(clientId, { lastSeen: Date.now() });
      return;
    }
    try {
      const parsed = JSON.parse(message);
      handleMessage(clientId, ws, parsed);
    } catch (e) {
      // ignore
    }
  });

  ws.on('close', () => {
    removeClient(clientId);
    broadcastRoomStateToDirectors();
  });

  ws.send(JSON.stringify({
    type: 'welcome',
    payload: {
      clientId,
      audioFile: room.audioFile,
      audioDisplayName: room.audioDisplayName,
      serverTime: getServerTime(),
      serverIp: getLocalIp()
    }
  }));
}

function handleMessage(clientId, ws, msg) {
  const { type, payload } = msg;

  switch (type) {
    case 'join':
      if (payload.role === 'director') {
        updateClientState(clientId, { role: 'director' });
      } else {
        updateClientState(clientId, { userOffsetMs: payload.userOffsetMs || 0 });
      }
      broadcastRoomStateToDirectors();
      break;

    case 'sync_ping': {
      const t2 = getServerTime();
      ws.send(JSON.stringify({
        type: 'sync_pong',
        payload: {
          t1: payload.t1,
          t2: t2,
          t3: getServerTime(),
          // Huygens: echo back probe pair identifiers
          probeGroupId: payload.probeGroupId,
          probeGroupIndex: payload.probeGroupIndex,
        }
      }));
      break;
    }

    case 'audio_loaded':
      updateClientState(clientId, { state: 'ready' });
      broadcastRoomStateToDirectors();
      break;

    case 'status':
      updateClientState(clientId, {
        state: payload.state,
        syncOffset: payload.syncOffset,
        confidence: payload.confidence,
        bestRtt: payload.bestRtt || 0,
        samples: payload.samples || 0,
      });
      broadcastRoomStateToDirectors();
      break;

    // --- Telemetría de los músicos ---
    case 'play_ack':
      // El músico confirma que recibió el play con detalles
      updateClientState(clientId, {
        state: 'playing',
        playTelemetry: payload,
      });
      broadcastToDirectors({
        type: 'play_ack',
        payload: { clientId, ...payload }
      });
      break;

    case 'telemetry':
      // Reporte periódico de posición de reproducción
      updateClientState(clientId, {
        currentPositionSec: payload.currentPositionSec,
        currentSample: payload.currentSample,
        isPlaying: payload.isPlaying,
      });

      // LOG EN TERMINAL para debugging
      const shortId = clientId.substring(0, 6);
      console.log(`📱 ${shortId} | pos=${payload.currentPositionSec?.toFixed(2)}s | sample=${payload.currentSample} | ctxTime=${payload.audioCtxTime?.toFixed(2)} | ctxState=${payload.audioCtxState} | playing=${payload.isPlaying}`);

      // Forward al director
      broadcastToDirectors({
        type: 'telemetry',
        payload: { clientId, ...payload }
      });

      // --- DRIFT CORRECTION ---
      if (room.state === 'playing' && room.playTargetTime && payload.isPlaying && payload.currentPositionSec > 0) {
        const serverNow = getServerTime();
        const client = room.clients.get(clientId);
        
        // Si el cliente nos manda su hora local sincornizada exacta (clientNow), no hay latencia de red.
        // Si no (código viejo), usamos la hora del servidor menos el RTT de viaje.
        const snapshotTime = payload.clientNow || (serverNow - ((client?.bestRtt || 10) / 2));
        const expectedSpeakerPosSec = (snapshotTime - room.playTargetTime) / 1000;
        
        const hwLatencySec = (payload.hwLatencyMs || 0) / 1000;
        const actualSpeakerPosSec = payload.currentPositionSec - hwLatencySec;
        const driftMs = Math.round((actualSpeakerPosSec - expectedSpeakerPosSec) * 1000);

        updateClientState(clientId, { lastDriftMs: driftMs });

        console.log(`  ↳ DRIFT ${shortId}: actual=${actualSpeakerPosSec.toFixed(3)}s expected=${expectedSpeakerPosSec.toFixed(3)}s drift=${driftMs}ms hwLat=${(hwLatencySec*1000).toFixed(0)}ms`);

        // Auto-Sync Inicial: a los 500ms de arrancar el tema, forzamos un ajuste automático una sola vez
        // para que el celular aprenda su delay inmediatamente sin necesidad de usar el botón manual.
        if (actualSpeakerPosSec >= 0.5 && !client.initialSyncDone && Math.abs(driftMs) > 10 && ws.readyState === 1) {
          console.log(`  🚀 AUTO-SYNC INICIAL ${shortId} a los ${actualSpeakerPosSec.toFixed(2)}s: ${driftMs}ms`);
          client.initialSyncDone = true;
          client.lastCorrectionTime = serverNow;
          ws.send(JSON.stringify({
            type: 'drift_correct',
            payload: { driftMs }
          }));
        }

        // Auto-sync del servidor: respaldo de emergencia (500ms)
        // El auto-corrector del cliente (median filter) maneja drifts pequeños.
        // El servidor solo interviene si hay una desviación catastrófica.
        const timeSinceLastCorrect = serverNow - (client.lastCorrectionTime || 0);
          
        if (Math.abs(driftMs) > 500 && timeSinceLastCorrect > 5000 && ws.readyState === 1) {
          console.log(`  ⚡ EMERGENCIA ${shortId}: ${driftMs}ms`);
          client.lastCorrectionTime = serverNow;
          ws.send(JSON.stringify({
            type: 'drift_correct',
            payload: { driftMs }
          }));
        }
      } else if (room.state === 'playing' && payload.isPlaying) {
        console.log(`  ⚠️ ${shortId}: pos=${payload.currentPositionSec} (no drift calc: pos<=0 o sin playTargetTime)`);
      }
      break;

    case 'toggle_auto_sync': {
      const targetClientId = payload.targetClientId;
      const targetClient = room.clients.get(targetClientId);
      if (targetClient) {
        // Si no está definido, asumimos que era true. Lo invertimos.
        const currentVal = targetClient.autoSync !== false;
        targetClient.autoSync = !currentVal;
        console.log(`⚙️ AUTO-SYNC ${targetClientId.substring(0,6)}: ${targetClient.autoSync}`);
        broadcastRoomStateToDirectors();
      }
      break;
    }

    case 'manual_seek': {
      const targetClientId = payload.targetClientId;
      const seekDeltaMs = payload.deltaMs;
      const targetClient = room.clients.get(targetClientId);
      if (targetClient && targetClient.ws && targetClient.ws.readyState === 1) {
        console.log(`🎛️ MANUAL SEEK → ${targetClientId.substring(0,6)}: ${seekDeltaMs}ms`);
        targetClient.ws.send(JSON.stringify({
          type: 'drift_correct',
          payload: { driftMs: seekDeltaMs }
        }));
      }
      break;
    }

    case 'disable_auto_sync_all': {
      console.log(`🛑 APAGANDO AUTO-SYNC PARA TODOS LOS CLIENTES`);
      room.clients.forEach(c => {
        if (c.role === 'musician') {
          c.autoSync = false;
        }
      });
      broadcastRoomStateToDirectors();
      break;
    }

    case 'set_calibration': {
      const targetClientId = payload.targetClientId;
      const offsetMs = payload.offsetMs;
      const targetClient = room.clients.get(targetClientId);
      
      if (targetClient) {
        targetClient.userOffsetMs = offsetMs; // Guardar en el servidor para que el Admin lo vea
        console.log(`🔧 SET CALIBRATION → ${targetClientId.substring(0,6)}: ${offsetMs}ms`);
        
        if (targetClient.ws && targetClient.ws.readyState === 1) {
          targetClient.ws.send(JSON.stringify({
            type: 'set_calibration',
            payload: { offsetMs }
          }));
        }
        broadcastRoomStateToDirectors();
      }
      break;
    }

    case 'cmd_auto_calibrate': {
      const targetClientId = payload.targetClientId;
      const targetClient = room.clients.get(targetClientId);
      
      if (targetClient && targetClient.ws && targetClient.ws.readyState === 1) {
        // Schedule 2 seconds in the future
        const delayMs = 2000;
        const serverSentAt = getServerTime();
        const targetTime = serverSentAt + delayMs;
        
        // Command the client to play the calibration mp3
        targetClient.ws.send(JSON.stringify({
          type: 'play_calibration_mp3',
          payload: { targetTime, serverSentAt }
        }));
        
        // Notify the admin to start listening for that target time
        ws.send(JSON.stringify({
          type: 'calibration_started',
          payload: { targetClientId, targetTime }
        }));
      }
      break;
    }

    case 'force_sync_all': {
      console.log(`⚡ FORZANDO AJUSTE DE SINCRONIZACIÓN GLOBAL`);
      room.clients.forEach(c => {
        if (c.role === 'musician' && c.isPlaying && c.lastDriftMs && Math.abs(c.lastDriftMs) > 10) {
          if (c.ws && c.ws.readyState === 1) {
            console.log(`  → Enviando seek a ${c.ws._clientId || 'client'} de ${c.lastDriftMs}ms`);
            c.lastCorrectionTime = getServerTime(); // Reseteamos su cooldown también
            c.ws.send(JSON.stringify({
              type: 'drift_correct',
              payload: { driftMs: c.lastDriftMs }
            }));
          }
        }
      });
      break;
    }

    // --- COMANDOS DEL DIRECTOR ---
    case 'cmd_play': {
      const delayMs = payload.delayMs || 2000;
      const serverSentAt = getServerTime();
      room.playTargetTime = serverSentAt + delayMs;
      room.state = 'playing';
      room.lastPlaySentAt = serverSentAt;

      room.clients.forEach(c => {
        if (c.role === 'musician') {
          c.initialSyncDone = false;
        }
      });

      broadcastToMusicians({
        type: 'play',
        payload: {
          targetTime: room.playTargetTime,
          serverSentAt: serverSentAt,
        }
      });

      // También notificar al director sobre los timestamps del server
      broadcastToDirectors({
        type: 'play_dispatched',
        payload: {
          serverSentAt: serverSentAt,
          targetTime: room.playTargetTime,
          delayMs: delayMs,
        }
      });
      broadcastRoomStateToDirectors();
      break;
    }

    case 'cmd_stop':
      room.state = 'ready';
      room.playTargetTime = null;
      broadcastToMusicians({ type: 'stop', payload: {} });
      broadcastRoomStateToDirectors();
      break;

    case 'cmd_set_audio':
      room.audioFile = payload.filename;
      room.audioDisplayName = payload.displayName || payload.filename;
      room.state = 'loading';
      broadcastToMusicians({
        type: 'load_audio',
        payload: { 
          url: `/audio/${payload.filename}`,
          displayName: room.audioDisplayName 
        }
      });
      broadcastRoomStateToDirectors();
      break;
  }
}

export function broadcastRoomStateToDirectors() {
  const clientsData = Array.from(room.clients.entries())
    .filter(([_, c]) => c.role === 'musician')
    .map(([id, c]) => ({
      id,
      state: c.state,
      syncOffset: c.syncOffset || 0,
      confidence: c.confidence || 0,
      bestRtt: c.bestRtt || 0,
      samples: c.samples || 0,
      lastSeen: c.lastSeen,
      currentPositionSec: c.currentPositionSec || 0,
      currentSample: c.currentSample || 0,
      isPlaying: c.isPlaying || false,
      lastDriftMs: c.lastDriftMs || 0,
      autoSync: c.autoSync !== false,
      userOffsetMs: c.userOffsetMs || 0,
    }));

  broadcastToDirectors({
    type: 'room_state',
    payload: {
      roomState: room.state,
      audioFile: room.audioFile,
      audioDisplayName: room.audioDisplayName,
      playTargetTime: room.playTargetTime,
      lastPlaySentAt: room.lastPlaySentAt || 0,
      clients: clientsData
    }
  });
}

// Limpieza de clientes inactivos
setInterval(() => {
  const now = Date.now();
  for (const [clientId, client] of room.clients.entries()) {
    if (now - client.lastSeen > 15000) {
      client.ws.terminate();
      removeClient(clientId);
      broadcastRoomStateToDirectors();
    } else {
      if (client.ws.readyState === 1) {
        client.ws.ping();
      }
    }
  }
}, 5000);
