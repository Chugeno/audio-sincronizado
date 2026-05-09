// public/js/ws-client.js

export class WsClient {
  constructor() {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.listeners = new Map(); // evento -> array de callbacks
    this.role = 'musician';
    this.pingInterval = null;
  }

  connect(role = 'musician') {
    this.role = role;
    
    // En desarrollo local (LAN), construimos la URL basada en window.location
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    console.log(`[WS] Conectando a ${wsUrl} como ${role}...`);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[WS] Conectado.');
      this.reconnectAttempts = 0;
      
      // Enviar mensaje inicial de join
      this.send('join', { role: this.role });
      
      this.emit('open');
      this.startHeartbeat();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.emit(msg.type, msg.payload);
      } catch (e) {
        console.error('[WS] Error parseando mensaje', e);
      }
    };

    this.ws.onclose = () => {
      console.log('[WS] Desconectado.');
      this.stopHeartbeat();
      this.emit('close');
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Maximos intentos de reconexión alcanzados.');
      this.emit('max_reconnects');
      return;
    }

    // Backoff exponencial: 1s, 2s, 4s, 8s... max 10s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
    this.reconnectAttempts++;
    
    console.log(`[WS] Reconectando en ${delay}ms (Intento ${this.reconnectAttempts})...`);
    setTimeout(() => {
      this.connect(this.role);
    }, delay);
  }

  send(type, payload) {
    if (this.isConnected()) {
      this.ws.send(JSON.stringify({ type, payload }));
    } else {
      console.warn(`[WS] Intentando enviar '${type}' pero no está conectado.`);
    }
  }

  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  // --- Event Emitter simple ---
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(cb => cb(data));
    }
  }

  // --- Heartbeat ---
  // Mantiene la conexión viva a través de proxies y load balancers
  startHeartbeat() {
    this.stopHeartbeat();
    // Enviar un ping vacío para que el servidor registre lastSeen
    this.pingInterval = setInterval(() => {
      if (this.isConnected()) {
         // Se puede enviar un mensaje específico o usar el mecanismo a nivel de protocolo si se soporta.
         // El servidor de Express/ws soporta pings a nivel de protocolo, 
         // pero para la web api no tenemos control, enviamos un pong vacío.
         this.ws.send('pong');
      }
    }, 5000);
  }

  stopHeartbeat() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
