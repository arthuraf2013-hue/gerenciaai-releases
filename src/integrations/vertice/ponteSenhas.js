// Ponte senhas do GerenciaAI -> Vértice (TVs da loja).
//
// O processo principal avisa 'chamada:mudou' a cada mudança de senha
// (chamadaService.js); aqui lemos a lista (chamada.listar) e mandamos ao
// Vértice só o que mudou desde o último envio. Também reenvia tudo a cada
// minuto e ao abrir: se a janela recarregou ou ficou sem internet, o Vértice
// se acerta sozinho (o envio é idempotente, mesmo id de pedido).
//
// Pedido no Vértice: id = id da senha; number = número da senha; nome = o
// primeiro nome que a senha já guarda (o módulo do Vértice ainda reduz para
// "Maria S." por padrão); readyAt = hora em que a senha foi CHAMADA. A TV
// avisa uma vez por (pedido, readyAt): reenviar a mesma chamada (app reaberto,
// sincronização a cada minuto) não repete o aviso; "De novo" muda a hora e repete.

const isoUtc = (s) => (s ? `${String(s).replace(' ', 'T')}${/Z$/.test(String(s)) ? '' : 'Z'}` : undefined);

/** Ações para levar o Vértice ao estado atual. Pura -- exportada pra teste. */
export function acoesParaVertice(lista, enviados) {
  const acoes = [];
  const atual = new Map();
  const add = (c, status) => atual.set(c.id, { c, status });
  // "Pronto" muda a cada vez que a senha é chamada (De novo): a chave inclui o horário da chamada,
  // para o Vértice receber de novo e a TV repetir o aviso.
  const chaveDe = (status, c) => (status === 'ready' ? `ready|${c.chamadoEm || ''}|${c.vezesChamada || 0}` : status);
  for (const c of lista?.preparando || []) add(c, 'preparing');
  for (const c of lista?.prontas || []) add(c, 'ready');
  for (const c of lista?.entregues || []) add(c, 'delivered');
  for (const [id, { c, status }] of atual) {
    const chave = chaveDe(status, c);
    if (enviados.get(id) === chave) continue;
    const venda = { id, number: c.numero, customerName: c.nome || null, createdAt: isoUtc(c.criadoEm) };
    if (status === 'ready' && c.chamadoEm) venda.readyAt = isoUtc(c.chamadoEm);
    acoes.push({ tipo: status, chave, venda });
  }
  for (const id of lista?.canceladas || []) {
    if (enviados.get(id) && enviados.get(id) !== 'cancelled') acoes.push({ tipo: 'cancelled', chave: 'cancelled', venda: { id } });
  }
  return acoes;
}

export function iniciarPonteSenhas(vx) {
  const enviados = new Map();
  let agendado = null;
  let parado = false;

  async function sincronizar() {
    agendado = null;
    if (parado || !vx.isPaired()) return;
    let lista;
    try { lista = await window.pdv.chamada.listar(); } catch { return; }
    if (!lista || lista.ok === false) return;
    for (const a of acoesParaVertice(lista, enviados)) {
      try {
        if (a.tipo === 'preparing') vx.orderPreparing(a.venda);
        else if (a.tipo === 'ready') vx.orderReady(a.venda);
        else if (a.tipo === 'delivered') vx.orderDelivered(a.venda);
        else if (a.tipo === 'cancelled') vx.orderCancelled(a.venda);
        enviados.set(a.venda.id, a.chave);
      } catch (err) {
        console.warn('[vertice] pedido não enviado', err?.message || err);
      }
    }
  }
  const agendar = () => { if (!agendado) agendado = setTimeout(sincronizar, 300); };

  const pararEvento = window.pdv.chamada?.onMudou?.(agendar) || (() => {});
  const pararEstado = vx.onState((s) => { if (s.status === 'paired') agendar(); });
  // A cada minuto reenvia o que estiver diferente; a cada 30 min esquece o
  // cache (o Vértice apaga pedido com 24 h e pode ter sido removido no painel).
  const ciclo = setInterval(agendar, 60000);
  const limpeza = setInterval(() => enviados.clear(), 30 * 60000);
  agendar();
  return () => { parado = true; pararEvento(); pararEstado(); clearInterval(ciclo); clearInterval(limpeza); clearTimeout(agendado); };
}
