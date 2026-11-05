// Substitui src/mesas/servidorMesas.js nos testes de tela (tests/telas.test.js):
// sem Firestore, com dados controlados pelo teste e registro de tudo que a
// tela pediu ao "computador".

export const VERSAO_APP = 'teste';

export const estado = {
  mesas: null,          // { dados, existe, doServidor, ultimaNovidadeMs }
  comandas: {},         // mesaId -> comanda
  catalogo: { produtos: [] },
  pedidos: [],          // { tipo, campos }
  respostas: {},        // tipo -> resultado | (campos) => resultado | Error
  lancamentos: [],      // o que foi para a fila de lançar
  pinsCifrados: [],
  ouvintes: { mesas: new Set(), comandas: new Map(), catalogo: new Set() },
};

export function reiniciar() {
  estado.mesas = null;
  estado.comandas = {};
  estado.catalogo = { produtos: [] };
  estado.pedidos = [];
  estado.respostas = {};
  estado.lancamentos = [];
  estado.pinsCifrados = [];
  estado.ouvintes = { mesas: new Set(), comandas: new Map(), catalogo: new Set() };
}

export function publicarMesas(dados, extra = {}) {
  estado.mesas = { dados, existe: !!dados, doServidor: true, ultimaNovidadeMs: Date.now(), ...extra };
  estado.ouvintes.mesas.forEach((fn) => fn(estado.mesas));
}

export function publicarComanda(mesaId, comanda) {
  estado.comandas[mesaId] = comanda;
  (estado.ouvintes.comandas.get(mesaId) || new Set()).forEach((fn) => fn({ comanda, existe: !!comanda }));
}

export function observarMesas(_installId, aoMudar) {
  estado.ouvintes.mesas.add(aoMudar);
  if (estado.mesas) aoMudar(estado.mesas);
  return () => estado.ouvintes.mesas.delete(aoMudar);
}

export function observarComanda(_installId, mesaId, aoMudar) {
  if (!estado.ouvintes.comandas.has(mesaId)) estado.ouvintes.comandas.set(mesaId, new Set());
  estado.ouvintes.comandas.get(mesaId).add(aoMudar);
  const c = estado.comandas[mesaId] || null;
  aoMudar({ comanda: c, existe: !!c });
  return () => estado.ouvintes.comandas.get(mesaId)?.delete(aoMudar);
}

export function observarCatalogo(_installId, aoMudar) {
  aoMudar(estado.catalogo);
  return () => {};
}

export function executar(_installId, tipo, campos = {}) {
  estado.pedidos.push({ tipo, campos });
  const r = estado.respostas[tipo];
  const valor = typeof r === 'function' ? r(campos) : r;
  if (valor instanceof Error) return Promise.reject(valor);
  return Promise.resolve(valor || {});
}

export function criarFilaDeLancamentos(_installId, aoMudar) {
  let envios = [];
  aoMudar(envios);
  return {
    lancar(dados) {
      estado.lancamentos.push(dados);
      const id = `env${estado.lancamentos.length}`;
      envios = [...envios, { id, mesaId: dados.mesaId, itens: dados.itensTela, situacao: 'enviando', criadoMs: Date.now() }];
      aoMudar(envios);
      return id;
    },
    dispensar(id) { envios = envios.filter((e) => e.id !== id); aoMudar(envios); },
    parar() {},
  };
}

export async function cifrarPin(chave, pin) {
  estado.pinsCifrados.push({ chave, pin });
  return `cifrado(${pin})`;
}
