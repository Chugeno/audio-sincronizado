// server/room.js
// Estructura en memoria para gestionar el estado de la sala

export const room = {
  audioFile: null,
  audioDisplayName: null,
  audioDuration: 0,
  clients: new Map(),
  state: 'idle',
  playTargetTime: null,
  lastPlaySentAt: 0,
};

export function addClient(clientId, ws, role) {
  room.clients.set(clientId, {
    ws,
    role,
    state: 'connecting',
    syncOffset: 0,
    confidence: 0,
    bestRtt: 0,
    samples: 0,
    currentPositionSec: 0,
    currentSample: 0,
    isPlaying: false,
    lastSeen: Date.now()
  });
}

export function updateClientState(clientId, updates) {
  const client = room.clients.get(clientId);
  if (client) {
    Object.assign(client, updates);
    client.lastSeen = Date.now();
  }
}

export function removeClient(clientId) {
  room.clients.delete(clientId);
}

export function getMusicians() {
  return Array.from(room.clients.values()).filter(c => c.role === 'musician');
}

export function getDirectors() {
  return Array.from(room.clients.values()).filter(c => c.role === 'director');
}

export function broadcastToMusicians(message) {
  const msgStr = JSON.stringify(message);
  getMusicians().forEach(client => {
    if (client.ws.readyState === 1 /* WebSocket.OPEN */) {
      client.ws.send(msgStr);
    }
  });
}

export function broadcastToDirectors(message) {
  const msgStr = JSON.stringify(message);
  getDirectors().forEach(client => {
    if (client.ws.readyState === 1 /* WebSocket.OPEN */) {
      client.ws.send(msgStr);
    }
  });
}
