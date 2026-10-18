// Parte "modo terminal" da nuvem, em memória -- mesmo contrato do que
// está em nuvem.js (Firestore). Usada pela nuvem simulada da demonstração
// do navegador e pela nuvem falsa dos testes, pra as duas não divergirem.
//
// Também traz um "computador" simulado (`computador`), que faz no papel o
// que electron/services/pdvMobileTerminalService.js faz de verdade:
// publica o catálogo e confirma os eventos.

export const ITENS_POR_PARTE_PRODUTOS = 1000;
export const ITENS_POR_PARTE_CLIENTES = 2000;

/** Divide o catálogo em partes (doc do Firestore tem limite de 1 MiB). Mesma regra do desktop. */
export function partirCatalogo({ produtos, clientes }) {
  const partes = {};
  const fatiar = (lista, tam, prefixo) => {
    const n = Math.ceil(lista.length / tam);
    for (let i = 0; i < n; i++) partes[`${prefixo}${i}`] = lista.slice(i * tam, (i + 1) * tam);
    return n;
  };
  return { partes, partesProdutos: fatiar(produtos, ITENS_POR_PARTE_PRODUTOS, 'p'), partesClientes: fatiar(clientes, ITENS_POR_PARTE_CLIENTES, 'c') };
}

/** Junta as partes lidas, recusando mistura de versões (o computador estava no meio de uma atualização). */
export function juntarCatalogo(meta, docs) {
  const produtos = [];
  const clientes = [];
  for (let i = 0; i < (meta.partesProdutos || 0); i++) {
    const d = docs[`p${i}`];
    if (!d || d.versao !== meta.versao) throw new Error('catálogo em atualização no computador');
    produtos.push(...JSON.parse(d.itensJson));
  }
  for (let i = 0; i < (meta.partesClientes || 0); i++) {
    const d = docs[`c${i}`];
    if (!d || d.versao !== meta.versao) throw new Error('catálogo em atualização no computador');
    clientes.push(...JSON.parse(d.itensJson));
  }
  let eventosAplicados = [];
  try { eventosAplicados = meta.eventosAplicadosJson ? JSON.parse(meta.eventosAplicadosJson) : []; } catch { eventosAplicados = []; }
  return { produtos, clientes, eventosAplicados };
}

export function criarTerminalEmMemoria({ checarRede = () => {}, adiar = (fn) => fn() } = {}) {
  const eventos = new Map(); // installId -> Map(id -> ev)
  const acks = new Map(); // installId -> Map(id -> ack)
  const catalogos = new Map(); // installId -> { meta, docs }
  const ouvAcks = new Map();
  const ouvCatalogo = new Map();
  const mapa = (m, id) => { if (!m.has(id)) m.set(id, new Map()); return m.get(id); };
  const conj = (m, id) => { if (!m.has(id)) m.set(id, new Set()); return m.get(id); };
  const notificarAcks = (id) => { const lista = [...mapa(acks, id).entries()].map(([k, v]) => ({ id: k, ...v })); for (const cb of conj(ouvAcks, id)) adiar(() => cb(lista)); };
  const notificarCatalogo = (id) => { const c = catalogos.get(id); for (const cb of conj(ouvCatalogo, id)) adiar(() => cb(c ? { ...c.meta } : null)); };

  const metodos = {
    async enviarEventoTerminal(installId, ev) { checarRede(); mapa(eventos, installId).set(ev.id, { ...ev, status: 'novo' }); },
    escutarAcksTerminal(installId, cb) {
      conj(ouvAcks, installId).add(cb);
      if (mapa(acks, installId).size) notificarAcks(installId);
      return () => conj(ouvAcks, installId).delete(cb);
    },
    async apagarAckTerminal(installId, id) { checarRede(); mapa(acks, installId).delete(id); },
    escutarCatalogoTerminal(installId, cb) {
      conj(ouvCatalogo, installId).add(cb);
      if (catalogos.has(installId)) adiar(() => cb({ ...catalogos.get(installId).meta }));
      return () => conj(ouvCatalogo, installId).delete(cb);
    },
    async lerCatalogoTerminal(installId, meta) {
      checarRede();
      const c = catalogos.get(installId);
      if (!c) throw new Error('catálogo não publicado');
      return juntarCatalogo(meta, c.docs);
    },
  };

  // Lado "computador" (simulado)
  const computador = {
    eventos: (installId) => [...mapa(eventos, installId).values()].sort((a, b) => a.criadoEmMs - b.criadoEmMs),
    publicarCatalogo(installId, { versao, produtos = [], clientes = [], eventosAplicados = [], servidorNome = 'Computador' }) {
      const { partes, partesProdutos, partesClientes } = partirCatalogo({ produtos, clientes });
      const docs = Object.fromEntries(Object.entries(partes).map(([k, itens]) => [k, { versao, itensJson: JSON.stringify(itens) }]));
      const meta = { versao, partesProdutos, partesClientes, servidorNome, geradoEmMs: Date.now(), eventosAplicadosJson: JSON.stringify(eventosAplicados) };
      catalogos.set(installId, { meta, docs });
      notificarCatalogo(installId);
    },
    confirmar(installId, id, { status = 'aplicado', erro = null, resultado = null } = {}) {
      const ev = mapa(eventos, installId).get(id);
      if (ev) ev.status = status;
      mapa(acks, installId).set(id, { status, erro, resultadoJson: resultado ? JSON.stringify(resultado) : null });
      notificarAcks(installId);
    },
    confirmarTodos(installId, opcoes) {
      for (const ev of computador.eventos(installId)) if (ev.status === 'novo') computador.confirmar(installId, ev.id, opcoes);
    },
    acks: (installId) => mapa(acks, installId),
  };

  return { metodos, computador };
}
