// Botão "voltar" do Android fecha o modal de cima primeiro (em vez de
// minimizar o app no meio de uma venda).
const pilha = [];

export function registrarFechavel(fn) {
  pilha.push(fn);
  return () => { const i = pilha.lastIndexOf(fn); if (i >= 0) pilha.splice(i, 1); };
}

export function fecharDoTopo() {
  const fn = pilha[pilha.length - 1];
  if (!fn) return false;
  fn();
  return true;
}
