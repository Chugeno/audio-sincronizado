// public/js/rtc-client.js

export class ClientRTCManager {
    constructor(signalingWs, roomId) {
        this.ws = signalingWs;
        this.roomId = roomId;
        this.pc = null;
        this.dc = null;
        
        this.onConnected = () => {};
        this.onDisconnected = () => {};
        this.onMessageReceived = (msg) => {};

        this.rtcConfig = {
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        };
    }

    async init() {
        console.log(`[ClientRTC] Inicializando PeerConnection...`);
        this.pc = new RTCPeerConnection(this.rtcConfig);

        this.pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.ws.send(JSON.stringify({
                    type: 'webrtc_ice_candidate',
                    payload: { targetClientId: 'director', candidate: event.candidate }
                }));
            }
        };

        this.pc.onconnectionstatechange = () => {
            console.log(`[ClientRTC] Estado:`, this.pc.connectionState);
            if (this.pc.connectionState === 'connected') {
                this.onConnected();
            } else if (this.pc.connectionState === 'disconnected' || this.pc.connectionState === 'failed') {
                this.onDisconnected();
            }
        };

        this.pc.ondatachannel = (event) => {
            this.dc = event.channel;
            this.dc.onopen = () => console.log(`[ClientRTC] DataChannel ABIERTO con Latencia 0ms`);
            
            this.dc.onmessage = (e) => {
                let msg;
                try {
                    msg = JSON.parse(e.data);
                } catch (err) { return; }

                // Responder pings inmediatamente para calcular RTT P2P
                if (msg.type === 'ping') {
                    this.send({ type: 'pong', timestamp: msg.timestamp });
                } else {
                    this.onMessageReceived(msg);
                }
            };
        };
    }

    async handleOffer(sdp) {
        if (!this.pc) await this.init();
        try {
            await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);
            
            this.ws.send(JSON.stringify({
                type: 'webrtc_answer',
                payload: { sdp: this.pc.localDescription }
            }));
            console.log(`[ClientRTC] Offer aceptada, enviando Answer...`);
        } catch (e) {
            console.error(`[ClientRTC] Error procesando Offer:`, e);
        }
    }

    async handleIceCandidate(candidate) {
        if (!this.pc) return;
        try {
            await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            console.error(`[ClientRTC] Error en ICE candidate:`, e);
        }
    }

    send(msgObj) {
        if (this.dc && this.dc.readyState === 'open') {
            this.dc.send(JSON.stringify(msgObj));
        }
    }
}
