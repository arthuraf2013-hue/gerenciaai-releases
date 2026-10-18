// Utilitários compartilhados por todos os serviços.

// --- Relógio confiável -------------------------------------------------
// O celular é do cliente: ele pode atrasar a data pra esticar os 3 dias
// sem internet. `relogioMaxMs` é o maior horário já visto (do próprio
// aparelho ou do servidor) e nunca volta pra trás -- todo registro usa
// `agoraMs()`, que é no mínimo esse valor. Se o relógio do aparelho
// voltar mais que a tolerância, a licença trava as vendas até validar
// online de novo (ver licenca.js -> relogioAtrasado).
let relogioDispositivo = () => Date.now();
let relogioMaxMs = 0;

export const TOLERANCIA_RELOGIO_MS = 10 * 60 * 1000;

/** Só pra testes: troca a fonte de horário do "aparelho". */
export function definirRelogioDoDispositivo(fn) { relogioDispositivo = fn; }
export function agoraDoDispositivoMs() { return relogioDispositivo(); }

export function carregarRelogioMax(ms) { relogioMaxMs = Math.max(0, Number(ms) || 0); }
export function relogioMax() { return relogioMaxMs; }

/** Horário do servidor recebido online: passa a ser a referência (mesmo se for MENOR que o máximo local -- corrige um relógio que estava adiantado). */
export function sincronizarRelogioComServidor(servidorMs) {
  relogioMaxMs = servidorMs;
}

export function relogioAtrasado() {
  return relogioDispositivo() < relogioMaxMs - TOLERANCIA_RELOGIO_MS;
}

export function agoraMs() {
  const d = relogioDispositivo();
  if (d > relogioMaxMs) relogioMaxMs = d;
  return relogioMaxMs;
}

export function agoraIso() { return new Date(agoraMs()).toISOString(); }

/** Marcador "use o horário do servidor" nos campos enviados pra nuvem (nuvem.js troca por serverTimestamp()). */
export const AGORA_SERVIDOR = '__gerenciaai_agora_servidor__';

// --- Contexto do aparelho ---------------------------------------------
const contexto = { dispositivoId: null, prefixoVenda: 'M', modoTerminal: false, servidorNome: null };
export function definirContexto(dados) { Object.assign(contexto, dados); }
export function ctx() { return contexto; }

// --- IDs ---------------------------------------------------------------
export function novoId() { return globalThis.crypto.randomUUID(); }

// --- Texto -------------------------------------------------------------
export function normalizarBusca(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// --- Dinheiro (centavos) e quantidade (milésimos) -----------------------
const FORMATO_BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export function formatarCentavos(c) { return FORMATO_BRL.format((Number(c) || 0) / 100); }

/** "12,50" | "12.5" | "R$ 1.234,56" -> 1250 | 1250 | 123456. Inválido -> null. */
export function lerCentavos(texto) {
  if (typeof texto === 'number') return Number.isFinite(texto) ? Math.round(texto * 100) : null;
  let s = String(texto || '').replace(/[R$\s]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // "1.234" em pt-BR = mil duzentos e trinta e quatro
  if (!/^-?\d+(\.\d{0,2})?$/.test(s)) return null;
  const [inteiro, dec = ''] = s.replace('-', '').split('.');
  const c = Number(inteiro) * 100 + Number((dec + '00').slice(0, 2));
  return s.startsWith('-') ? -c : c;
}

/** "0,750" | "2" -> 750 | 2000. Inválido ou <= 0 -> null. */
export function lerQuantidadeMil(texto) {
  let s = String(texto ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{0,3})?$/.test(s)) return null;
  const [inteiro, dec = ''] = s.split('.');
  const q = Number(inteiro) * 1000 + Number((dec + '000').slice(0, 3));
  return q > 0 ? q : null;
}

export function formatarQuantidade(qtdMil, unidade) {
  if (unidade === 'kg') return `${(qtdMil / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg`;
  const n = qtdMil / 1000;
  return Number.isInteger(n) ? String(n) : n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

/** Total do item arredondado pro centavo mais próximo (meio centavo sobe). */
export function totalItemCentavos(precoCentavos, qtdMil) {
  return Math.round((precoCentavos * qtdMil) / 1000);
}

// --- Datas locais ----------------------------------------------------------
/** Limites UTC [inicio, fim) do dia LOCAL do aparelho que contém `ms`. */
export function limitesDoDiaLocal(ms = agoraMs()) {
  const d = new Date(ms);
  const inicio = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const fim = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return { inicio: inicio.toISOString(), fim: fim.toISOString() };
}

// --- Erro de regra de negócio (mensagem pronta pra mostrar na tela) ----
export class ErroDeNegocio extends Error {
  constructor(mensagem, codigo) {
    super(mensagem);
    this.name = 'ErroDeNegocio';
    this.codigo = codigo;
  }
}

// --- Config (chave/valor) ------------------------------------------------
export async function lerConfig(db, chave, padrao = null) {
  const v = await db.valor('SELECT valor FROM config WHERE chave = ?', [chave]);
  if (v === undefined || v === null) return padrao;
  try { return JSON.parse(v); } catch { return v; }
}

export async function gravarConfig(db, chave, valor) {
  await db.run(
    'INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor',
    [chave, JSON.stringify(valor)],
  );
}

export async function auditar(db, acao, detalhes, usuarioId = null) {
  await db.run(
    'INSERT INTO auditoria (id, acao, detalhes, usuario_id, criado_em) VALUES (?, ?, ?, ?, ?)',
    [novoId(), acao, detalhes ? JSON.stringify(detalhes) : null, usuarioId, agoraIso()],
  );
}
