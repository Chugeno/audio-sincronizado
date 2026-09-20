// public/js/rtc-host.js

export class HostRTCManager {
    constructor(signalingWs, roomId) {
        this.ws = signalingWs;
        this.roomId = roomId;
        this.peers = new Map(); // clientId -> RTCPeerConnection
        this.channels = new Map(); // clientId -> RTCDataChannel
        
        // Callbacks para que el UI pueda reaccionar
        this.onPeerConnected = (clientId) => {};
        this.onPeerDisconnected = (clientId) => {};
        this.onMessageReceived = (clientId, msg) => {};

        // Latencias (RTT) por cliente (medido vía WebRTC local)
        this.rtts = new Map();

        // Configuración mínima de WebRTC (sólo necesitamos red local, no requerimos TURN costosos)
        this.rtcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' } // Stun público solo para descubrir la IP local
            ]
        };
    }

    // Llamado cuando el servidor avisa que llegó un nuevo músico
    async createPeer(clientId) {
        console.log(`[HostRTC] Creando PeerConnection para músico: ${clientId}`);
        const pc = new RTCPeerConnection(this.rtcConfig);
        this.peers.set(clientId, pc);

        // Crear el DataChannel (fiable y ordenado por defecto)
        const dc = pc.createDataChannel('sync_channel');
        this.channels.set(clientId, dc);

        this._setupDataChannel(clientId, dc);
        this._setupPeerEvents(clientId, pc);

        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            
            // Enviar oferta al Músico vía el Signaling Server (WebSocket)
            this.ws.send(JSON.stringify({
                type: 'webrtc_offer',
                payload: { targetClientId: clientId, sdp: pc.localDescription }
            }));
        } catch (error) {
            console.error(`[HostRTC] Error creando oferta para ${clientId}:`, error);
        }
    }

    // Llamado cuando el servidor nos devuelve la Answer del Músico
    async handleAnswer(clientId, sdp) {
        const pc = this.peers.get(clientId);
        if (pc) {
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(sdp));
                console.log(`[HostRTC] Respuesta (Answer) aceptada de ${clientId}`);
            } catch (e) {
                console.error(`[HostRTC] Error seteando remote description para ${clientId}:`, e);
            }
        }
    }

    // Llamado cuando el servidor nos envía un ICE Candidate del Músico
    async handleIceCandidate(clientId, candidate) {
        const pc = this.peers.get(clientId);
        if (pc) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
                console.error(`[HostRTC] Error agregando ICE candidate de ${clientId}:`, e);
            }
        }
    }

    _setupPeerEvents(clientId, pc) {
        // Enviar nuestros ICE candidates al Músico vía Signaling
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.ws.send(JSON.stringify({
                    type: 'webrtc_ice_candidate',
                    payload: { targetClientId: clientId, candidate: event.candidate }
                }));
            }
        };

        pc.onconnectionstatechange = () => {
            console.log(`[HostRTC] Estado WebRTC de ${clientId}:`, pc.connectionState);
            if (pc.connectionState === 'connected') {
                this.onPeerConnected(clientId);
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                this.removePeer(clientId);
                this.onPeerDisconnected(clientId);
            }
        };
    }

    _setupDataChannel(clientId, dc) {
        dc.onopen = () => {
            console.log(`[HostRTC] DataChannel abierto con ${clientId} (Latencia 0ms esperada)`);
            this._startPingLoop(clientId);
        };

        dc.onmessage = (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch (e) { return; }

            // Medir ping/pong para calcular el RTT de WebRTC
            if (msg.type === 'pong') {
                const now = performance.now();
                const rtt = now - msg.timestamp;
                this.rtts.set(clientId, rtt);
                // Reportar telemetría
                this.onMessageReceived(clientId, { type: 'telemetry', rtt, tOffset: 0 }); // Simplificado
            } else {
                this.onMessageReceived(clientId, msg);
            }
        };
    }

    // Bucle para medir la latencia de la red local
    _startPingLoop(clientId) {
        const pingInterval = setInterval(() => {
            const dc = this.channels.get(clientId);
            if (dc && dc.readyState === 'open') {
                dc.send(JSON.stringify({ type: 'ping', timestamp: performance.now() }));
            } else {
                clearInterval(pingInterval);
            }
        }, 1000);
    }

    // Enviar un mensaje broadcast a todos los músicos a través del canal P2P
    broadcast(msgObj) {
        const msgStr = JSON.stringify(msgObj);
        this.channels.forEach((dc, clientId) => {
            if (dc.readyState === 'open') {
                dc.send(msgStr);
            }
        });
    }

    // Enviar mensaje a un solo músico
    sendTo(clientId, msgObj) {
        const dc = this.channels.get(clientId);
        if (dc && dc.readyState === 'open') {
            dc.send(JSON.stringify(msgObj));
        }
    }

    removePeer(clientId) {
        const pc = this.peers.get(clientId);
        if (pc) pc.close();
        this.peers.delete(clientId);
        this.channels.delete(clientId);
        this.rtts.delete(clientId);
    }
}
