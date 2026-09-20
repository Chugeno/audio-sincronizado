// server/signaling.js
import { nanoid } from 'nanoid';

// Estado global de salas
// rooms = { [roomId]: { director: WebSocket, musicians: Map<clientId, WebSocket> } }
const rooms = new Map();

export function setupWsHandler(ws, req) {
  const clientId = nanoid(10);
  let currentRoomId = null;
  let currentRole = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }

    const { type, payload } = msg;

    switch (type) {
      case 'join_room': {
        const { roomId, role } = payload;
        currentRoomId = roomId;
        currentRole = role;

        if (!rooms.has(roomId)) {
          rooms.set(roomId, { director: null, musicians: new Map() });
        }

        const room = rooms.get(roomId);

        if (role === 'director') {
          // Si ya había un director, lo podríamos desconectar, pero asumimos 1 por sala
          room.director = ws;
          console.log(`🎬 Director se unió a la sala: ${roomId}`);
        } else if (role === 'musician') {
          room.musicians.set(clientId, ws);
          console.log(`📱 Músico ${clientId} se unió a la sala: ${roomId}`);
          
          // Notificamos al director que llegó un músico nuevo para que inicie la oferta WebRTC
          if (room.director && room.director.readyState === 1) {
            room.director.send(JSON.stringify({
              type: 'musician_joined',
              payload: { clientId }
            }));
          }
        }
        break;
      }

      // El Director le envía una Oferta WebRTC (SDP) a un Músico específico
      case 'webrtc_offer': {
        const { targetClientId, sdp } = payload;
        const room = rooms.get(currentRoomId);
        if (room && room.musicians.has(targetClientId)) {
          const targetWs = room.musicians.get(targetClientId);
          if (targetWs.readyState === 1) {
            targetWs.send(JSON.stringify({
              type: 'webrtc_offer',
              payload: { sdp, fromClientId: 'director' }
            }));
          }
        }
        break;
      }

      // El Músico le responde (Answer SDP) al Director
      case 'webrtc_answer': {
        const { sdp } = payload;
        const room = rooms.get(currentRoomId);
        if (room && room.director && room.director.readyState === 1) {
          room.director.send(JSON.stringify({
            type: 'webrtc_answer',
            payload: { sdp, fromClientId: clientId }
          }));
        }
        break;
      }

      // Intercambio de ICE Candidates para que descubran cómo conectarse en la red local
      case 'webrtc_ice_candidate': {
        const { targetClientId, candidate } = payload;
        const room = rooms.get(currentRoomId);
        if (!room) return;

        if (currentRole === 'director') {
          // Director envía a Músico
          const targetWs = room.musicians.get(targetClientId);
          if (targetWs && targetWs.readyState === 1) {
            targetWs.send(JSON.stringify({
              type: 'webrtc_ice_candidate',
              payload: { candidate, fromClientId: 'director' }
            }));
          }
        } else if (currentRole === 'musician') {
          // Músico envía a Director
          if (room.director && room.director.readyState === 1) {
            room.director.send(JSON.stringify({
              type: 'webrtc_ice_candidate',
              payload: { candidate, fromClientId: clientId }
            }));
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentRoomId && rooms.has(currentRoomId)) {
      const room = rooms.get(currentRoomId);
      if (currentRole === 'director' && room.director === ws) {
        room.director = null;
        console.log(`🎬 Director salió de la sala: ${currentRoomId}`);
        // Avisar a músicos que el director se fue
        room.musicians.forEach(musicianWs => {
          if (musicianWs.readyState === 1) {
            musicianWs.send(JSON.stringify({ type: 'director_left' }));
          }
        });
      } else if (currentRole === 'musician') {
        room.musicians.delete(clientId);
        console.log(`📱 Músico ${clientId} salió de la sala: ${currentRoomId}`);
        // Avisar al director
        if (room.director && room.director.readyState === 1) {
          room.director.send(JSON.stringify({
            type: 'musician_left',
            payload: { clientId }
          }));
        }
      }
      
      // Limpiar sala si está vacía
      if (!room.director && room.musicians.size === 0) {
        rooms.delete(currentRoomId);
      }
    }
  });

  ws.send(JSON.stringify({ type: 'welcome', payload: { clientId } }));
}
