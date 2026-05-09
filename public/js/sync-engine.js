// public/js/sync-engine.js

/**
 * SyncEngine v3: Protocolo NTP con filtro Huygens (Coded Probe Pairs).
 * 
 * Técnica adaptada de Beatsync (MIT): en vez de mandar un ping suelto,
 * manda PARES de pings separados por PROBE_GAP_MS. Si el gap en el
 * servidor difiere del gap en el cliente por más de PROBE_GAP_TOLERANCE_MS,
 * la muestra se descarta como "impura" (afectada por jitter WiFi, GC, etc.)
 * 
 * Esto es crítico para dispositivos Android viejos con WiFi inestable.
 */
export class SyncEngine {
  constructor(wsClient) {
    this.wsClient = wsClient;
    this.samples = [];
    this.offset = 0;
    this.confidence = 0;
    this.bestRtt = Infinity;

    this.MAX_SAMPLES = 20;
    this.FAST_INTERVAL = 300;   // Cada 300ms durante la ráfaga inicial
    this.SLOW_INTERVAL = 2000;  // Cada 2s una vez estabilizado
    this.FAST_COUNT = 20;       // 20 pings rápidos primero (6 segundos)

    // Huygens Coded Probes
    this.PROBE_GAP_MS = 25;             // Gap entre las dos probes del par
    this.PROBE_GAP_TOLERANCE_MS = 5;    // Tolerancia de drift aceptable
    this.probeGroupCounter = 0;
    this.pendingFirstProbe = null;       // Almacena la 1ra probe del par
    this.pendingFirstProbeGroupId = null;
    this.pureCount = 0;
    this.impureCount = 0;

    this.pingInterval = null;
    this.pingCount = 0;

    this.wsClient.on('sync_pong', this.handlePong.bind(this));
  }

  start() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingCount = 0;
    this.samples = [];
    this.pureCount = 0;
    this.impureCount = 0;
    this.probeGroupCounter = 0;

    // Fase rápida: pings cada 300ms
    this.pingInterval = setInterval(() => {
      this.sendProbePair();
      this.pingCount++;

      // Después de FAST_COUNT pings, pasar a modo lento
      if (this.pingCount >= this.FAST_COUNT && this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => this.sendProbePair(), this.SLOW_INTERVAL);
      }
    }, this.FAST_INTERVAL);

    this.sendProbePair(); // El primero inmediatamente
  }

  stop() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Envía un par de probes (Huygens).
   * La primera se envía inmediatamente, la segunda después de PROBE_GAP_MS.
   */
  sendProbePair() {
    if (!this.wsClient.isConnected()) return;

    const probeGroupId = this.probeGroupCounter++;

    // Probe 1: inmediata
    const t1_a = performance.now();
    this.wsClient.send('sync_ping', {
      t1: t1_a,
      probeGroupId,
      probeGroupIndex: 0,
    });

    // Probe 2: después de PROBE_GAP_MS
    setTimeout(() => {
      if (!this.wsClient.isConnected()) return;
      const t1_b = performance.now();
      this.wsClient.send('sync_ping', {
        t1: t1_b,
        probeGroupId,
        probeGroupIndex: 1,
      });
    }, this.PROBE_GAP_MS);
  }

  handlePong({ t1, t2, t3, probeGroupId, probeGroupIndex }) {
    const t4 = performance.now();
    const rtt = (t4 - t1) - (t3 - t2);
    const offset = ((t2 - t1) + (t3 - t4)) / 2;

    // Descartar muestras con RTT excesivo
    if (rtt > 500) {
      console.warn(`[Sync] RTT muy alto (${rtt.toFixed(1)}ms), descartando.`);
      return;
    }

    const measurement = { t1, t2, t3, t4, rtt, offset, timestamp: Date.now() };

    // Si no hay datos de probeGroup (compatibilidad), aceptar directamente
    if (probeGroupId === undefined || probeGroupIndex === undefined) {
      this.samples.push(measurement);
      if (this.samples.length > this.MAX_SAMPLES) this.samples.shift();
      this.recalculate();
      return;
    }

    // --- Validación Huygens ---
    const validMeasurement = this.validateProbePair(measurement, probeGroupId, probeGroupIndex);
    if (validMeasurement) {
      this.samples.push(validMeasurement);
      if (this.samples.length > this.MAX_SAMPLES) this.samples.shift();
      this.recalculate();
    }
  }

  /**
   * Valida un par de probes. Guarda la primera, cuando llega la segunda
   * compara los gaps y retorna la mejor (menor RTT) si es "pura".
   */
  validateProbePair(measurement, probeGroupId, probeGroupIndex) {
    if (probeGroupIndex === 0) {
      // Es la primera probe — guardarla y esperar la segunda
      this.pendingFirstProbe = measurement;
      this.pendingFirstProbeGroupId = probeGroupId;
      return null;
    }

    // Es la segunda probe (index === 1): intentar completar el par
    const first = this.pendingFirstProbe;
    const firstGroupId = this.pendingFirstProbeGroupId;

    if (!first || firstGroupId !== probeGroupId) {
      // No hay primera probe o los IDs no coinciden
      return null;
    }

    // Limpiar estado pendiente
    this.pendingFirstProbe = null;
    this.pendingFirstProbeGroupId = null;

    // Validar pureza del gap
    const clientGap = measurement.t1 - first.t1;  // Gap en el cliente
    const serverGap = measurement.t2 - first.t2;  // Gap en el servidor
    const gapDrift = Math.abs(serverGap - clientGap);
    const isPure = gapDrift <= this.PROBE_GAP_TOLERANCE_MS;

    if (isPure) {
      this.pureCount++;
    } else {
      this.impureCount++;
    }

    const total = this.pureCount + this.impureCount;
    const pureRate = total > 0 ? ((this.pureCount / total) * 100).toFixed(0) : '0';

    if (!isPure) {
      console.log(
        `[Sync] IMPURE #${probeGroupId} | cGap=${clientGap.toFixed(1)}ms sGap=${serverGap.toFixed(1)}ms drift=${gapDrift.toFixed(1)}ms | pure: ${this.pureCount}/${total} (${pureRate}%)`
      );
      return null;
    }

    // Par puro: elegir la probe con menor RTT
    const best = first.rtt <= measurement.rtt ? first : measurement;

    console.log(
      `[Sync] PURE #${probeGroupId} | bestRTT=${best.rtt.toFixed(1)}ms offset=${best.offset.toFixed(1)}ms | pure: ${this.pureCount}/${total} (${pureRate}%)`
    );

    return best;
  }

  recalculate() {
    if (this.samples.length === 0) return;

    // Offset = el de la muestra con MENOR RTT (RFC 5905 §10)
    const bestSample = this.samples.reduce((min, s) => s.rtt < min.rtt ? s : min);
    this.offset = bestSample.offset;
    this.bestRtt = bestSample.rtt;

    // Confianza basada en estabilidad
    if (this.samples.length > 3) {
      const offsets = this.samples.map(s => s.offset);
      const mean = offsets.reduce((a, b) => a + b) / offsets.length;
      const variance = offsets.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / offsets.length;
      const stdDev = Math.sqrt(variance);
      this.confidence = Math.max(0, 1 - (stdDev / 50));
    } else {
      this.confidence = this.samples.length / 10; // sube gradualmente
    }

    // Enviar estado al servidor
    this.wsClient.send('status', {
      state: window.uiState ? window.uiState.getCurrent() : 'connecting',
      syncOffset: this.offset,
      confidence: this.confidence,
      bestRtt: this.bestRtt,
      samples: this.samples.length,
      probeStats: {
        pure: this.pureCount,
        impure: this.impureCount,
        pureRate: (this.pureCount + this.impureCount) > 0
          ? this.pureCount / (this.pureCount + this.impureCount)
          : 0,
      },
    });
  }

  serverToLocal(serverTime) {
    return serverTime - this.offset;
  }

  now() {
    return performance.now() + this.offset;
  }
}
