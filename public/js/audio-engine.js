// public/js/audio-engine.js
//
// Motor de audio con AudioWorklet (sample-accurate) + fallback a BufferSourceNode.
// El worklet cuenta samples desde el hilo de audio → posición con precisión 0.02ms.
// Las correcciones de drift usan seek_to con crossfade interno → sin clicks, sin nodos nuevos.

export class AudioEngine {
  constructor(syncEngine) {
    this.syncEngine = syncEngine;
    this.audioCtx = null;
    this.audioBuffer = null;
    this.calibrationBuffer = null;
    this.gainNode = null;
    this.wakeLock = null;
    this._hasVisListener = false;

    // === Worklet (motor principal — sample-accurate) ===
    this.workletNode = null;
    this.workletReady = false;   // true cuando el worklet confirma buffer cargado
    this.usingWorklet = false;   // true durante una sesión de reproducción con worklet

    // Última telemetría del worklet (posición sample-accurate)
    this._workletPosSec = -1;    // posición reportada por el worklet (en segundos)
    this._workletCtxTime = 0;    // audioCtx.currentTime en el momento del reporte

    // === Fallback (BufferSourceNode para navegadores sin AudioWorklet) ===
    this.sourceNode = null;

    // === Estado general ===
    this.isPlaying = false;
    this.lastDriftMs = 0;
    this.driftCorrectionCount = 0;
    this.playStartCtxTime = 0;
    this.playStartAudioOffset = 0;
    this.lastScheduledTargetTime = 0;
    this.playTargetServerTime = null;
    this.telemetry = {};

    // Callback para persistir correcciones en localStorage (lo configura musician-app.js)
    this.onCorrection = null;
  }

  // ---------------------------------------------------------------------------
  // INIT
  // ---------------------------------------------------------------------------

  async init() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

      this.gainNode = this.audioCtx.createGain();
      this.gainNode.connect(this.audioCtx.destination);

      // DAC Keep-Alive — oscilador inaudible que mantiene el hilo de audio activo
      const silentOsc = this.audioCtx.createOscillator();
      const silentGain = this.audioCtx.createGain();
      silentGain.gain.value = 0.0001;
      silentOsc.connect(silentGain);
      silentGain.connect(this.audioCtx.destination);
      silentOsc.start();
      console.log('[Audio] DAC Keep-Alive activado.');

      // Cargar AudioWorklet (sample-accurate playback)
      try {
        await this.audioCtx.audioWorklet.addModule('/js/worklets/sync-player-processor.js');
        this.workletNode = new AudioWorkletNode(this.audioCtx, 'sync-player-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        this.workletNode.connect(this.gainNode);
        this.workletNode.port.onmessage = this._onWorkletMessage.bind(this);
        console.log('[Audio] ✅ AudioWorklet activo — precisión de sample garantizada.');
      } catch (e) {
        console.warn('[Audio] ⚠️ AudioWorklet no disponible, usando BufferSourceNode:', e.message);
        this.workletNode = null;
      }
    }

    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
      console.log('[Audio] AudioContext desbloqueado:', this.audioCtx.state);
    }
    this.requestWakeLock();
  }

  // ---------------------------------------------------------------------------
  // MENSAJES DEL WORKLET
  // ---------------------------------------------------------------------------

  _onWorkletMessage(event) {
    const { type, payload } = event.data;
    switch (type) {
      case 'buffer_loaded':
        this.workletReady = true;
        console.log(`[Worklet] ✅ Buffer listo: ${payload.length} samples, ${payload.channels}ch`);
        break;

      case 'telemetry':
        // Posición sample-accurate (readPos / sampleRate dentro del hilo de audio)
        this._workletPosSec = payload.currentPositionSec;
        this._workletCtxTime = payload.workletCurrentTime;
        break;

      case 'ended':
        this.isPlaying = false;
        this.usingWorklet = false;
        this._workletPosSec = -1;
        console.log('[Audio] Reproducción terminada (worklet).');
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // CARGA DE AUDIO
  // ---------------------------------------------------------------------------

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

    if (onProgress) onProgress(1.0);
    console.log('[Audio] Decodificando...');

    this.audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);
    console.log(`[Audio] Listo. Duración: ${this.audioBuffer.duration.toFixed(2)}s, SampleRate: ${this.audioBuffer.sampleRate}`);

    // Transferir datos al worklet (copiamos para mantener this.audioBuffer válido)
    if (this.workletNode) {
      this.workletReady = false; // Resetear hasta confirmar buffer_loaded
      const channelData = [];
      for (let i = 0; i < this.audioBuffer.numberOfChannels; i++) {
        // new Float32Array(...) = copia, NO transfer → audioBuffer sigue intacto
        channelData.push(new Float32Array(this.audioBuffer.getChannelData(i)));
      }
      // Transferimos las copias al worklet (zero-copy entre threads)
      this.workletNode.port.postMessage(
        { type: 'load_buffer', payload: { channels: channelData } },
        channelData.map(c => c.buffer)
      );
      console.log('[Worklet] Datos de audio transferidos, esperando confirmación...');
    }

    return this.audioBuffer.duration;
  }

  async loadCalibrationAudio() {
    try {
      console.log('[Audio] Cargando audio de calibración...');
      const response = await fetch('/audio/calibracion.mp3');
      const arrayBuffer = await response.arrayBuffer();
      this.calibrationBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);
      console.log('[Audio] Audio de calibración cargado.');
    } catch (e) {
      console.error('[Audio] Fallo al cargar el audio de calibración:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // PUENTE DE RELOJES (performance.now → audioCtx.currentTime)
  // Toma la mediana de 5 lecturas de getOutputTimestamp() para reducir jitter.
  // ---------------------------------------------------------------------------

  perfTimeToAudioTime(perfTimeMs) {
    if (!this.audioCtx) return perfTimeMs / 1000;

    const samples = [];
    for (let i = 0; i < 5; i++) {
      const ts = this.audioCtx.getOutputTimestamp();
      if (ts?.contextTime && ts?.performanceTime) {
        samples.push(ts.contextTime + (perfTimeMs - ts.performanceTime) / 1000);
      }
    }

    if (samples.length === 0) {
      return this.audioCtx.currentTime + (perfTimeMs - performance.now()) / 1000;
    }

    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)]; // mediana
  }

  // ---------------------------------------------------------------------------
  // REPRODUCCIÓN
  // ---------------------------------------------------------------------------

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

    // 2. Parar reproducción previa
    this.stop();

    // 3. Compensaciones
    const hwLatency = this.audioCtx.outputLatency || 0;
    const userOffsetSec = userOffsetMs / 1000;

    // 4. Puente de relojes (mediana de 5 muestras → reduce jitter de getOutputTimestamp)
    const targetPerfTime = performance.now() + delayMs;
    const targetAudioTime = this.perfTimeToAudioTime(targetPerfTime);
    const rawStartAt = targetAudioTime - hwLatency - userOffsetSec;
    // Garantizar mínimo 10ms de margen para que el worklet pueda agendar correctamente
    const startAt = Math.max(this.audioCtx.currentTime + 0.01, rawStartAt);

    // 5. Estado
    this.playStartCtxTime = startAt;
    this.playStartAudioOffset = 0;
    this.lastScheduledTargetTime = serverTargetTime;
    this.playTargetServerTime = serverTargetTime; // IMPORTANTE: después de stop() que lo limpia
    this.isPlaying = true;
    this.driftCorrectionCount = 0;
    this._workletPosSec = -1; // Resetear hasta que el worklet reporte

    console.log(`[Audio] Programando play: delay=${delayMs.toFixed(1)}ms, hwLatency=${(hwLatency*1000).toFixed(1)}ms, startAt=${startAt.toFixed(4)}s`);

    if (this.workletNode && this.workletReady) {
      // ── MODO WORKLET (sample-accurate) ──────────────────────────────────────
      this.workletNode.port.postMessage({
        type: 'schedule_play',
        payload: { startTime: startAt, offset: 0 },
      });
      this.usingWorklet = true;
      console.log('[Audio] ▶️ Reproducción via AudioWorklet (sample-accurate).');
    } else {
      // ── MODO FALLBACK: BufferSourceNode ──────────────────────────────────────
      this.usingWorklet = false;
      this.sourceNode = this.audioCtx.createBufferSource();
      this.sourceNode.buffer = this.audioBuffer;

      const fbGain = this.audioCtx.createGain();
      this.sourceNode.connect(fbGain);
      fbGain.connect(this.audioCtx.destination);
      this.sourceNode.start(startAt);

      const currentSource = this.sourceNode;
      currentSource.onended = () => {
        if (this.sourceNode === currentSource) {
          this.isPlaying = false;
          console.log('[Audio] Reproducción terminada (fallback BufferSourceNode).');
          if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
        }
      };
      console.log('[Audio] ▶️ Reproducción via BufferSourceNode (fallback).');
    }

    // Media Session API
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: document.getElementById('display-track-name')?.textContent || 'SyncOrchestra',
        artist: 'SyncOrchestra',
        album: 'Grabación en Vivo',
      });
      navigator.mediaSession.playbackState = 'playing';
    }

    // Telemetría para play_ack
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
      usingWorklet: this.usingWorklet,
      clockBridge: {
        contextTime: ots?.contextTime || 0,
        performanceTime: ots?.performanceTime || 0,
        usedBridge: !!(ots?.contextTime && ots?.performanceTime),
      },
    };

    return this.telemetry;
  }

  // ---------------------------------------------------------------------------
  // POSICIÓN ACTUAL (sample-accurate si worklet activo, interpolada entre reportes)
  // ---------------------------------------------------------------------------

  getCurrentPosition() {
    if (!this.isPlaying) return -1;

    if (this.usingWorklet && this._workletPosSec >= 0 && this._workletCtxTime > 0) {
      // Interpolamos desde la última telemetría del worklet con audioCtx.currentTime
      // → precisión sub-quantum entre reportes (~87ms)
      const elapsed = this.audioCtx.currentTime - this._workletCtxTime;
      return this._workletPosSec + Math.max(0, elapsed);
    }

    // Fallback: cálculo desde audioCtx.currentTime (granularidad ±2.9ms)
    const elapsed = this.audioCtx.currentTime - this.playStartCtxTime;
    return this.playStartAudioOffset + Math.max(0, elapsed);
  }

  getCurrentSample() {
    const pos = this.getCurrentPosition();
    if (pos < 0 || !this.audioBuffer) return -1;
    return Math.floor(pos * this.audioBuffer.sampleRate);
  }

  getTelemetrySnapshot() {
    return {
      ...this.telemetry,
      currentPositionSec: this.getCurrentPosition(),
      currentSample: this.getCurrentSample(),
      isPlaying: this.isPlaying,
      audioCtxTime: this.audioCtx ? this.audioCtx.currentTime : 0,
      audioCtxState: this.audioCtx ? this.audioCtx.state : 'closed',
      hwLatencyMs: this.audioCtx ? (this.audioCtx.outputLatency || 0) * 1000 : 0,
      usingWorklet: this.usingWorklet,
    };
  }

  // ---------------------------------------------------------------------------
  // CALIBRACIÓN
  // ---------------------------------------------------------------------------

  scheduleCalibrationPlay(serverTargetTime, userOffsetMs = 0) {
    if (!this.calibrationBuffer) {
      console.error('[Audio] Intento de reproducir calibración sin buffer cargado');
      return;
    }

    const targetLocalPerfTime = this.syncEngine.serverToLocal(serverTargetTime);
    const delayMs = targetLocalPerfTime - performance.now();

    if (this.calibrationSourceNode) {
      try { this.calibrationSourceNode.stop(); } catch (e) {}
    }

    this.calibrationSourceNode = this.audioCtx.createBufferSource();
    this.calibrationSourceNode.buffer = this.calibrationBuffer;
    this.calibrationSourceNode.connect(this.audioCtx.destination);

    const hwLatency = this.audioCtx.outputLatency || 0;
    const userOffsetSec = userOffsetMs / 1000;
    const targetAudioTime = this.perfTimeToAudioTime(performance.now() + delayMs);
    const startAt = Math.max(0, targetAudioTime - hwLatency - userOffsetSec);

    console.log(`[Audio-Calib] Programando beep: delay=${delayMs.toFixed(1)}ms, startAt=${startAt.toFixed(4)}s`);
    this.calibrationSourceNode.start(startAt);
  }

  // ---------------------------------------------------------------------------
  // CORRECCIÓN DE DRIFT
  // Con worklet: seek_to con crossfade dentro del hilo de audio (sin clicks, sin nodos nuevos)
  // Sin worklet: crossfade via GainNode (comportamiento anterior)
  // ---------------------------------------------------------------------------

  correctDrift(driftMs) {
    if (!this.isPlaying) return;

    this.lastDriftMs = driftMs;
    const currentPos = this.getCurrentPosition();
    if (currentPos < 0) return;

    const targetPos = currentPos - (driftMs / 1000);
    const safePos = Math.max(0, Math.min(targetPos, (this.audioBuffer?.duration || 0) - 0.01));

    this.driftCorrectionCount++;
    console.log(`[Audio] Corrección #${this.driftCorrectionCount}: ${driftMs > 0 ? '+' : ''}${driftMs}ms | ${currentPos.toFixed(3)}s → ${safePos.toFixed(3)}s`);

    if (this.usingWorklet && this.workletNode) {
      // ── WORKLET: crossfade en el hilo de audio (inaudible, sin nuevo nodo) ──
      this.workletNode.port.postMessage({
        type: 'seek_to',
        payload: { targetTime: safePos },
      });
      // Actualizar ancla local para que getCurrentPosition() sea coherente
      this._workletPosSec = safePos;
      this._workletCtxTime = this.audioCtx.currentTime;
    } else {
      // ── FALLBACK: crossfade via GainNode ─────────────────────────────────────
      const now = this.audioCtx.currentTime;
      const fadeTime = 0.005; // 5ms

      try {
        this.gainNode.gain.cancelScheduledValues(now);
        this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
        this.gainNode.gain.linearRampToValueAtTime(0.0, now + fadeTime);
      } catch (e) {}

      setTimeout(() => {
        if (!this.isPlaying) return;
        try {
          const oldSource = this.sourceNode;
          const newSource = this.audioCtx.createBufferSource();
          newSource.buffer = this.audioBuffer;
          newSource.connect(this.gainNode);

          this.playStartCtxTime = this.audioCtx.currentTime;
          this.playStartAudioOffset = safePos;
          this.sourceNode = newSource;
          newSource.start(0, safePos);
          newSource.onended = () => {
            if (this.sourceNode === newSource) this.isPlaying = false;
          };

          try { oldSource.onended = null; oldSource.stop(); oldSource.disconnect(); } catch (e) {}

          const fadeInStart = this.audioCtx.currentTime;
          this.gainNode.gain.setValueAtTime(0.0, fadeInStart);
          this.gainNode.gain.linearRampToValueAtTime(1.0, fadeInStart + fadeTime);
        } catch (e) {
          console.error('[Audio] Error durante seek fallback:', e);
        }
      }, Math.ceil(fadeTime * 1000) + 1);
    }

    // Notificar a la capa de app para persistir en localStorage
    if (typeof this.onCorrection === 'function') {
      this.onCorrection(driftMs);
    }
  }

  // ---------------------------------------------------------------------------
  // STOP
  // ---------------------------------------------------------------------------

  stop() {
    this.isPlaying = false;
    this.playTargetServerTime = null;
    this._workletPosSec = -1;

    if (this.workletNode && this.usingWorklet) {
      this.workletNode.port.postMessage({ type: 'stop', payload: {} });
      this.usingWorklet = false;
    }

    if (this.sourceNode) {
      try { this.sourceNode.stop(); } catch (e) {}
      try { this.sourceNode.disconnect(); } catch (e) {}
      this.sourceNode = null;
    }
  }

  setVolume(vol) {
    if (this.gainNode) this.gainNode.gain.value = vol;
  }

  // ---------------------------------------------------------------------------
  // WAKE LOCK (evita que la pantalla/CPU duerman)
  // ---------------------------------------------------------------------------

  async requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        console.log('[WakeLock] API adquirida.');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      }
    } catch (err) {
      console.warn(`[WakeLock] API falló: ${err.name}`);
    }

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

    if (!this._hasVisListener) {
      this._hasVisListener = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.requestWakeLock();
      });
    }
  }
}
