// server/ws-handler.js
import { nanoid } from 'nanoid';
import { room, addClient, removeClient, updateClientState, broadcastToDirectors, broadcastToMusicians } from './room.js';
import { getServerTime } from './sync-clock.js';

export function setupWsHandler(ws, req) {
  const clientId = nanoid(10);

  addClient(clientId, ws, 'musician');

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
      serverTime: getServerTime()
    }
  }));
}

function handleMessage(clientId, ws, msg) {
  const { type, payload } = msg;

  switch (type) {
    case 'join':
      if (payload.role === 'director') {
        updateClientState(clientId, { role: 'director' });
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
        const halfRttSec = ((client?.bestRtt || 10) / 2) / 1000;

        const expectedSpeakerPosSec = (serverNow - room.playTargetTime) / 1000 - halfRttSec;
        const hwLatencySec = (payload.hwLatencyMs || 0) / 1000;
        const actualSpeakerPosSec = payload.currentPositionSec - hwLatencySec;
        const driftMs = Math.round((actualSpeakerPosSec - expectedSpeakerPosSec) * 1000);

        updateClientState(clientId, { lastDriftMs: driftMs });

        console.log(`  ↳ DRIFT ${shortId}: actual=${actualSpeakerPosSec.toFixed(3)}s expected=${expectedSpeakerPosSec.toFixed(3)}s drift=${driftMs}ms hwLat=${(hwLatencySec*1000).toFixed(0)}ms`);

        if (client.autoSync !== false) {
          // Cooldown: no corregir si corregimos hace menos de 2 segundos
          const timeSinceLastCorrect = serverNow - (client.lastCorrectionTime || 0);
          
          if (Math.abs(driftMs) > 30 && timeSinceLastCorrect > 2000 && ws.readyState === 1) {
            console.log(`  ⚡ CORREGIR ${shortId}: ${driftMs}ms`);
            client.lastCorrectionTime = serverNow; // Guardar tiempo local del server
            ws.send(JSON.stringify({
              type: 'drift_correct',
              payload: { driftMs }
            }));
          }
        } else {
          console.log(`  ⏸️ ${shortId}: Auto-sync desactivado (drift=${driftMs}ms)`);
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
      // El admin envía un ajuste manual para un dispositivo específico
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

    // --- COMANDOS DEL DIRECTOR ---
    case 'cmd_play': {
      const delayMs = payload.delayMs || 2000;
      const serverSentAt = getServerTime();
      room.playTargetTime = serverSentAt + delayMs;
      room.state = 'playing';
      room.lastPlaySentAt = serverSentAt;

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
