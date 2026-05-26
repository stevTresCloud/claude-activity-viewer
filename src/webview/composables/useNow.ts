/* ================================================================
 * useNow.ts — Tick reactivo del wall-clock.
 *
 * Devuelve un `Ref<number>` que se actualiza cada `intervalMs`
 * con `Date.now()`. Sirve para que computeds derivados (ej.
 * `elapsedMs = now - startedAt`) re-renderen automáticamente sin
 * postMessage extra desde el extension host.
 *
 * Por qué un singleton de módulo:
 *   Si cada card running creara su propio interval, tendríamos N
 *   setIntervals corriendo en paralelo. Un solo tick global +
 *   reactividad de Vue propaga al resto.
 *
 * Por qué startear el interval lazy:
 *   Al importar el módulo no hay agentes; arrancar el tick
 *   pre-emptivo gastaría CPU sin razón. El interval arranca en la
 *   primera invocación de `useNow()` y se queda vivo (sin
 *   cleanup) — el costo de 1 timer cada segundo es despreciable
 *   y simplifica el ciclo de vida (no hay que contar referencias
 *   entre componentes).
 * ================================================================ */

import { ref } from 'vue';

const TICK_MS = 1000;

const now = ref(Date.now());
let started = false;

export function useNow(): typeof now {
  if (!started) {
    started = true;
    setInterval(() => {
      now.value = Date.now();
    }, TICK_MS);
  }
  return now;
}
