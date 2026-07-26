import { useEffect, useRef } from 'react';

/**
 * Leitores de código de barras USB/Bluetooth quase sempre se comportam
 * como um teclado (HID keyboard wedge): eles "digitam" o código muito
 * rápido e terminam com Enter. Este hook escuta o teclado inteiro,
 * acumula os caracteres enquanto o intervalo entre teclas for curto
 * (digitação humana normal é bem mais lenta) e dispara onScan quando
 * detecta o padrão de rajada + Enter.
 *
 * Isso funciona com qualquer leitor plug-and-play, sem SDK/driver
 * específico — e não interfere em inputs de texto normais porque só
 * age quando o padrão de "rajada" é detectado.
 *
 * @param {(code: string) => void} onScan
 * @param {{ enabled?: boolean, maxIntervalMs?: number, minLength?: number }} options
 */
export function useBarcodeScanner(onScan, options = {}) {
  const { enabled = true, maxIntervalMs = 40, minLength = 4 } = options;
  const buffer = useRef('');
  const lastKeyTime = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(e) {
      const now = Date.now();
      const gap = now - lastKeyTime.current;
      lastKeyTime.current = now;

      // Se o intervalo desde a última tecla foi muito grande, é digitação
      // humana normal (ou início de uma nova leitura) — reinicia o buffer.
      if (gap > maxIntervalMs) {
        buffer.current = '';
      }

      if (e.key === 'Enter') {
        if (buffer.current.length >= minLength) {
          onScan(buffer.current);
        }
        buffer.current = '';
        return;
      }

      // Ignora teclas de controle/modificadoras
      if (e.key.length === 1) {
        buffer.current += e.key;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, onScan, maxIntervalMs, minLength]);
}
