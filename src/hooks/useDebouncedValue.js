import { useEffect, useState } from 'react';

/**
 * Devolve uma versão "atrasada" do valor — só atualiza depois que o
 * valor parar de mudar pelo tempo definido. Usado nas buscas pra não
 * disparar uma consulta ao banco a cada tecla digitada; em PCs mais
 * fracos, isso reduz bastante o trabalho enquanto a pessoa ainda está
 * digitando.
 *
 * @param {any} value
 * @param {number} delayMs
 */
export function useDebouncedValue(value, delayMs = 200) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
