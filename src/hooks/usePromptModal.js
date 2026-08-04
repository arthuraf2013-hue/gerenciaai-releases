import { useCallback, useRef, useState } from 'react';

/**
 * Substituto de `window.prompt()` — que não funciona no Electron (o
 * Chromium embutido não suporta esse diálogo síncrono nativo, dá erro
 * "prompt() is and will not be supported" e nada acontece). Usa um
 * modal React de verdade, mas com a MESMA forma de uso do prompt()
 * original: `const valor = await promptAsync('Pergunta:', 'padrão')`
 * — devolve `null` se cancelar, ou o texto digitado se confirmar.
 *
 * Uso:
 *   const { promptState, promptAsync, confirmarPrompt, cancelarPrompt } = usePromptModal();
 *   // no JSX: {promptState && <PromptModal {...promptState} onConfirmar={confirmarPrompt} onCancelar={cancelarPrompt} />}
 *   // no handler: const motivo = await promptAsync('Motivo?', '');
 */
export function usePromptModal() {
  const [promptState, setPromptState] = useState(null);
  const resolverRef = useRef(null);

  const promptAsync = useCallback((titulo, valorInicial = '', opcoes = {}) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setPromptState({ titulo, valorInicial: valorInicial || '', placeholder: opcoes.placeholder || '' });
    });
  }, []);

  const confirmarPrompt = useCallback((valor) => {
    resolverRef.current?.(valor);
    resolverRef.current = null;
    setPromptState(null);
  }, []);

  const cancelarPrompt = useCallback(() => {
    resolverRef.current?.(null);
    resolverRef.current = null;
    setPromptState(null);
  }, []);

  return { promptState, promptAsync, confirmarPrompt, cancelarPrompt };
}
