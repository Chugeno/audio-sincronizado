// public/js/worklets/sync-player-processor.js

class SyncPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.audioData = []; // Array of Float32Arrays (one per channel)
    this.numChannels = 0;
    this.bufferLength = 0;
    
    this.state = 'stopped'; // 'stopped', 'scheduled', 'playing'
    this.startTimeCtx = 0;
    this.startAudioOffset = 0;
    
    this.readPos = 0; // Posición de lectura en samples
    
    // Estado para crossfade (corrección de drift sin clicks)
    this.isCrossfading = false;
    this.crossfadeReadPos = 0;
    this.crossfadeDurationSamples = 128; // Por defecto
    this.crossfadeElapsed = 0;

    // Frecuencia de reporte
    this.blocksSinceLastReport = 0;
    this.reportIntervalBlocks = 30; // ~100ms a 44.1kHz (30 bloques de 128 frames)

    this.port.onmessage = this.handleMessage.bind(this);
  }

  handleMessage(event) {
    const { type, payload } = event.data;
    
    if (type === 'load_buffer') {
      this.audioData = payload.channels;
      this.numChannels = this.audioData.length;
      this.bufferLength = this.audioData[0].length;
      this.crossfadeDurationSamples = Math.floor(sampleRate * 0.005); // 5ms crossfade
      this.port.postMessage({ type: 'buffer_loaded', payload: { length: this.bufferLength, channels: this.numChannels } });
    } 
    else if (type === 'schedule_play') {
      this.startTimeCtx = payload.startTime;
      this.startAudioOffset = payload.offset || 0;
      this.readPos = this.startAudioOffset * sampleRate;
      this.state = 'scheduled';
      this.isCrossfading = false;
    }
    else if (type === 'stop') {
      this.state = 'stopped';
      this.port.postMessage({ type: 'ended' });
    }
    else if (type === 'seek_to') {
      if (this.state === 'playing') {
        const targetPos = payload.targetTime * sampleRate;
        const targetSample = Math.floor(targetPos);
        
        // Si el salto es minúsculo (ej. 1 sample), simplemente corregimos readPos
        if (Math.abs(this.readPos - targetSample) < 5) {
          this.readPos = targetSample;
        } else {
          // Salto mayor: crossfade para evitar click
          this.isCrossfading = true;
          this.crossfadeReadPos = targetSample;
          this.crossfadeElapsed = 0;
        }
      }
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const channelCount = output.length;
    const blockSize = output[0].length;

    if (this.state === 'stopped' || this.bufferLength === 0) {
      return true; // Mantener vivo, salida será silencio (ceros)
    }

    let i = 0;

    // Chequear si estamos programados y debemos empezar en este bloque
    if (this.state === 'scheduled') {
      const blockEndTime = currentTime + (blockSize / sampleRate);
      
      if (this.startTimeCtx >= blockEndTime) {
        // Aún no es el momento
        return true; 
      } else if (this.startTimeCtx >= currentTime) {
        // Empieza DENTRO de este bloque (sample accurate delay)
        const delaySeconds = this.startTimeCtx - currentTime;
        const delaySamples = Math.floor(delaySeconds * sampleRate);
        i = delaySamples;
        this.state = 'playing';
      } else {
        // La hora ya pasó, empezar ya mismo
        this.state = 'playing';
      }
    }

    if (this.state === 'playing') {
      for (; i < blockSize; i++) {
        // Fin del archivo
        if (Math.floor(this.readPos) >= this.bufferLength) {
          this.state = 'stopped';
          this.port.postMessage({ type: 'ended' });
          break;
        }

        // Generar output
        for (let channel = 0; channel < channelCount; channel++) {
          const sourceChannel = channel % this.numChannels;
          let sample = this.audioData[sourceChannel][Math.floor(this.readPos)];

          if (this.isCrossfading) {
            // Asegurar que el target no se pase del buffer
            const safeTargetPos = Math.min(Math.floor(this.crossfadeReadPos), this.bufferLength - 1);
            const targetSample = this.audioData[sourceChannel][safeTargetPos];
            
            // Crossfade lineal simple
            const fadeOutVol = 1.0 - (this.crossfadeElapsed / this.crossfadeDurationSamples);
            const fadeInVol = this.crossfadeElapsed / this.crossfadeDurationSamples;
            
            sample = (sample * fadeOutVol) + (targetSample * fadeInVol);
          }
          
          output[channel][i] = sample;
        }

        // Avanzar punteros
        if (this.isCrossfading) {
          this.crossfadeReadPos++;
          this.crossfadeElapsed++;
          if (this.crossfadeElapsed >= this.crossfadeDurationSamples) {
            // Termina el crossfade
            this.isCrossfading = false;
            this.readPos = this.crossfadeReadPos;
          }
        }

        this.readPos++;
      }

      // Enviar reporte de telemetría a JS principal
      this.blocksSinceLastReport++;
      if (this.blocksSinceLastReport >= this.reportIntervalBlocks) {
        this.blocksSinceLastReport = 0;
        this.port.postMessage({
          type: 'telemetry',
          payload: {
            currentPositionSec: this.readPos / sampleRate,
            currentSample: Math.floor(this.readPos),
            workletCurrentTime: currentTime
          }
        });
      }
    }

    return true; // Mantener el worklet activo
  }
}

registerProcessor('sync-player-processor', SyncPlayerProcessor);
