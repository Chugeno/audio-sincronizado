// server/sync-clock.js
// Reloj monotónico de alta resolución para el servidor

// Guardamos el punto de inicio exacto
const startHrTime = process.hrtime.bigint();
const startEpoch = Date.now();

/**
 * Retorna el tiempo actual del servidor en milisegundos.
 * Combina un timestamp epoch base con process.hrtime.bigint() 
 * para garantizar que sea monotónico y de alta resolución (sub-milisegundo).
 */
export function getServerTime() {
  const elapsedNs = process.hrtime.bigint() - startHrTime;
  const elapsedMs = Number(elapsedNs) / 1_000_000;
  return startEpoch + elapsedMs;
}
