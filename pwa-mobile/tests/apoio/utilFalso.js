// Substitui pdv-util.js e pdv-servidor.js nos testes de tela.
export const toasts = [];
export function mostrarToast(texto, tipo = 'info') { toasts.push({ texto, tipo }); }
export async function consultar(_installId, tipo, parametros) {
  if (tipo === 'pix') return { valor: parametros.valor, qr: { size: 1, bits: '1' }, payload: 'PIX' };
  throw new Error('consulta não esperada no teste');
}
