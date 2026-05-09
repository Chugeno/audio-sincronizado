// public/js/audio-engine.js

export class AudioEngine {
  constructor(syncEngine) {
    this.syncEngine = syncEngine;
    this.audioCtx = null;
    this.audioBuffer = null;
    this.sourceNode = null;
    this.gainNode = null;
    this.wakeLock = null;
    this._hasVisListener = false;

    // Telemetry
    this.isPlaying = false;
    this.lastDriftMs = 0;
    this.driftCorrectionCount = 0;
    this.playStartCtxTime = 0;
    this.playStartAudioOffset = 0;
    this.lastScheduledTargetTime = 0;
    this.telemetry = {};
  }

  async init() {
    if (!this.audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContext();
    }
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
      console.log('[Audio] AudioContext desbloqueado:', this.audioCtx.state);
    }
    this.requestWakeLock();
  }

  async loadAudio(url, onProgress) {
    console.log(`[Audio] Descargando ${url}...`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Error HTTP: ${response.status}`);

    const contentLength = response.headers.get('content-length');
    let arrayBuffer;

    if (contentLength && onProgress) {
      const total = parseInt(contentLength, 10);
      let loaded = 0;
      const reader = response.body.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onProgress(loaded / total);
      }
      arrayBuffer = new Uint8Array(loaded);
      let position = 0;
      for (let chunk of chunks) {
        arrayBuffer.set(chunk, position);
        position += chunk.length;
      }
      arrayBuffer = arrayBuffer.buffer;
    } else {
      arrayBuffer = await response.arrayBuffer();
    }

    console.log('[Audio] Decodificando...');
    if (onProgress) onProgress(1.0);

    this.audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);
    console.log(`[Audio] Listo. Duración: ${this.audioBuffer.duration}s, SampleRate: ${this.audioBuffer.sampleRate}`);
    return this.audioBuffer.duration;
  }

  /**
   * Puente de relojes: convierte un timestamp de performance.now()
   * a audioCtx.currentTime usando getOutputTimestamp().
   */
  perfTimeToAudioTime(perfTimeMs) {
    if (!this.audioCtx) return perfTimeMs / 1000;
    const ts = this.audioCtx.getOutputTimestamp();
    if (!ts || !ts.contextTime || !ts.performanceTime) {
      return this.audioCtx.currentTime + (perfTimeMs - performance.now()) / 1000;
    }
    return ts.contextTime + (perfTimeMs - ts.performanceTime) / 1000;
  }

  schedulePlay(serverTargetTime, userOffsetMs = 0) {
    if (!this.audioBuffer) {
      console.error('[Audio] Intento de reproducir sin buffer cargado');
      return null;
    }

    const receiveLocalTime = performance.now();
    const receiveServerTime = this.syncEngine.now();

    // 1. Convertir target del servidor a escala local
    const targetLocalPerfTime = this.syncEngine.serverToLocal(serverTargetTime);
    const delayMs = targetLocalPerfTime - performance.now();

    // 2. Recrear nodo de audio
    this.stop();
    this.sourceNode = this.audioCtx.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;

    this.gainNode = this.audioCtx.createGain();
    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.audioCtx.destination);

    // 3. Compensaciones
    const hwLatency = this.audioCtx.outputLatency || 0;
    const userOffsetSec = userOffsetMs / 1000;

    // 4. Puente de relojes para convertir target → audioCtx.currentTime
    const targetPerfTime = performance.now() + delayMs;
    const targetAudioTime = this.perfTimeToAudioTime(targetPerfTime);
    const rawStartAt = targetAudioTime - hwLatency - userOffsetSec;
    const startAt = Math.max(0, rawStartAt);

    // 5. Estado
    this.playStartCtxTime = startAt;
    this.playStartAudioOffset = 0;
    this.lastScheduledTargetTime = serverTargetTime;
    this.isPlaying = true;
    this.driftCorrectionCount = 0;

    console.log(`[Audio] Programando play: delay=${delayMs.toFixed(1)}ms, hwLatency=${(hwLatency*1000).toFixed(1)}ms, startAt=${startAt.toFixed(4)}s`);
    this.sourceNode.start(startAt);

    // Media Session API
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: document.getElementById('display-track-name')?.textContent || 'Coro Playback',
        artist: 'SyncOrchestra',
        album: 'Grabación en Vivo'
      });
      navigator.mediaSession.playbackState = 'playing';
    }

    const currentSource = this.sourceNode;
    currentSource.onended = () => { 
      if (this.sourceNode === currentSource) this.isPlaying = false; 
    };

    // Construir telemetría
    const ots = this.audioCtx.getOutputTimestamp();
    this.telemetry = {
      playReceivedAt: receiveLocalTime,
      playReceivedServerTime: receiveServerTime,
      serverTargetTime,
      delayToTargetMs: delayMs,
      hwLatencyMs: hwLatency * 1000,
      userOffsetMs,
      syncOffset: this.syncEngine.offset,
      syncConfidence: this.syncEngine.confidence,
      syncRttBest: this.syncEngine.samples.length > 0
        ? this.syncEngine.samples.reduce((a, b) => a.rtt < b.rtt ? a : b).rtt
        : -1,
      scheduledCtxTime: startAt,
      rawScheduledCtxTime: rawStartAt,
      audioCtxCurrentTime: this.audioCtx.currentTime,
      sampleRate: this.audioBuffer.sampleRate,
      audioDuration: this.audioBuffer.duration,
      clockBridge: {
        contextTime: ots?.contextTime || 0,
        performanceTime: ots?.performanceTime || 0,
        usedBridge: !!(ots?.contextTime && ots?.performanceTime),
      },
    };

    return this.telemetry;
  }

  /**
   * Obtiene la posición actual de reproducción en segundos.
   */
  getCurrentPosition() {
    if (!this.isPlaying) return -1;
    const elapsed = this.audioCtx.currentTime - this.playStartCtxTime;
    return this.playStartAudioOffset + Math.max(0, elapsed);
  }

  /**
   * Obtiene la posición actual en samples.
   */
  getCurrentSample() {
    const pos = this.getCurrentPosition();
    if (pos < 0 || !this.audioBuffer) return -1;
    return Math.floor(pos * this.audioBuffer.sampleRate);
  }

  /**
   * Obtiene un snapshot de telemetría incluyendo posición actual.
   */
  getTelemetrySnapshot() {
    return {
      ...this.telemetry,
      currentPositionSec: this.getCurrentPosition(),
      currentSample: this.getCurrentSample(),
      isPlaying: this.isPlaying,
      audioCtxTime: this.audioCtx ? this.audioCtx.currentTime : 0,
      audioCtxState: this.audioCtx ? this.audioCtx.state : 'closed',
    };
  }

  /**
   * Corrección de drift comandada por el servidor.
   * Micro-seek con crossfade via GainNode (sin cambio de afinación).
   */
  correctDrift(driftMs) {
    if (!this.isPlaying || !this.audioBuffer || !this.sourceNode) return;

    const absDrift = Math.abs(driftMs);
    this.lastDriftMs = driftMs;

    // Ya no ignoramos drifts pequeños si vienen del servidor o manual
    const currentPos = this.getCurrentPosition();
    if (currentPos < 0) return;

    const targetPos = currentPos - (driftMs / 1000);
    const safePos = Math.max(0, Math.min(targetPos, this.audioBuffer.duration - 0.01));

    this.driftCorrectionCount++;
    console.log(`[Audio] Drift #${this.driftCorrectionCount}: drift=${driftMs}ms | from ${currentPos.toFixed(3)}s to ${safePos.toFixed(3)}s`);

    // Crossfade via GainNode:
    const now = this.audioCtx.currentTime;
    const fadeTime = 0.005; // 5ms para ser más seguro
    
    try {
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
      this.gainNode.gain.linearRampToValueAtTime(0.0, now + fadeTime);
    } catch (e) {
      console.warn('[Audio] Error en fade out:', e);
    }

    setTimeout(() => {
      if (!this.isPlaying) return;

      try {
        const oldSource = this.sourceNode;
        const newSource = this.audioCtx.createBufferSource();
        newSource.buffer = this.audioBuffer;
        newSource.connect(this.gainNode);

        // Actualizar el "ancla" del tiempo
        this.playStartCtxTime = this.audioCtx.currentTime;
        this.playStartAudioOffset = safePos;

        // Guardar referencia ANTES de asignar
        this.sourceNode = newSource;
        newSource.start(0, safePos);

        // Solo este nodo específico puede terminar la reproducción
        newSource.onended = () => {
          if (this.sourceNode === newSource) this.isPlaying = false;
        };

        // Parar el viejo después de arrancar el nuevo para evitar baches
        try { oldSource.onended = null; oldSource.stop(); oldSource.disconnect(); } catch (e) {}

        // Fade in
        const fadeInStart = this.audioCtx.currentTime;
        this.gainNode.gain.setValueAtTime(0.0, fadeInStart);
        this.gainNode.gain.linearRampToValueAtTime(1.0, fadeInStart + fadeTime);
        
        console.log(`[Audio] Seek completado a ${safePos.toFixed(3)}s`);
      } catch (e) {
        console.error('[Audio] Error durante seek:', e);
      }
    }, Math.ceil(fadeTime * 1000) + 1);
  }

  stop() {
    this.isPlaying = false;
    if (this.sourceNode) {
      try { this.sourceNode.stop(); } catch (e) {}
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
  }

  setVolume(vol) {
    if (this.gainNode) this.gainNode.gain.value = vol;
  }

  async requestWakeLock() {
    // 1. Wake Lock API
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        console.log('[WakeLock] API adquirida.');
        this.wakeLock.addEventListener('release', () => {
          this.wakeLock = null;
        });
      }
    } catch (err) {
      console.warn(`[WakeLock] API falló: ${err.name}`);
    }

    // 2. NoSleep Video Hack — Canvas → MediaStream → <video>
    const video = document.getElementById('no-sleep-video');
    if (video && !video.srcObject) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 2;
        const ctx = canvas.getContext('2d');
        ctx.fillRect(0, 0, 2, 2);

        const stream = canvas.captureStream(1);
        video.srcObject = stream;
        await video.play();
        console.log('[WakeLock] NoSleep video stream activo.');
      } catch (e) {
        console.warn('[WakeLock] Video hack no soportado:', e.message);
      }
    }

    // Listener de visibilidad
    if (!this._hasVisListener) {
      this._hasVisListener = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this.requestWakeLock();
        }
      });
    }
  }
}
