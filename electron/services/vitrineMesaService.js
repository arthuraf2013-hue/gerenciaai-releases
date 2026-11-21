const crypto = require('crypto');
const { getDb } = require('../db/database');

/**
 * QR DA MESA PELA INTERNET (cliente SEM o Wi-Fi da loja): chamar o garçom,
 * pedir a conta e ver a conta, pela vitrine (Firebase). É o caminho da página
 * pwa-mobile/loja.html; a página da rede da loja (mesaLocalService) continua
 * igual.
 *
 *  - Chamado: a página grava installations/{id}/chamados_vitrine/{id}
 *    ({ slug, mesa: segredo do QR, tipo: 'garcom'|'conta', aparelho }); esta
 *    máquina escuta os 'novo', confere o segredo e registra pelo MESMO caminho
 *    do chamado local (mesaLocalService.chamar): marca o quadrado da mesa,
 *    avisa as telas e toca o som. Depois marca o documento como 'recebido'.
 *  - Conta: esta máquina publica installations/{id}/contas_mesa/{chave} com o
 *    que cada pessoa pediu e o total. A chave é derivada do SEGREDO do QR com
 *    um rótulo próprio (`conta|`): NÃO é o hash que a vitrine publica para
 *    escrever "Mesa 5" (esse é público), então só quem tem o QR da mesa lê a
 *    conta. Cada pessoa é identificada por um hash do código do celular dela.
 *    Só publica com a vitrine ligada e recebendo pedidos; só republica o que
 *    mudou.
 */

const SEGREDO_MESA = /^[A-Za-z0-9]{24}$/;
const APARELHO = /^[A-Za-z0-9]{16,40}$/;
const INTERVALO_MS = 20 * 1000;

const estado = { pararEscuta: null, escutando: false, ultimo: new Map(), timer: null, processando: new Set() };

const sha = (texto) => crypto.createHash('sha256').update(String(texto)).digest('hex');
/** Chave do documento da conta (a página calcula a mesma coisa). */
const chaveDaConta = (segredo) => sha(`conta|${segredo}`).slice(0, 32);
/** Identificador público de um celular dentro da conta. */
const chaveDoAparelho = (aparelho) => sha(`aparelho|${aparelho}`).slice(0, 16);
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function ligado() {
  try { return require('./vitrineService').internetDisponivel(); } catch { return false; }
}

// ------------------------------------------------------------------ chamados

/** Trata um chamado vindo da vitrine; devolve { ok, erro? } para marcar o documento. */
function tratarChamado(dados, { chamar = require('./mesaLocalService').chamar } = {}) {
  if (!dados || typeof dados !== 'object') return { ok: false, erro: 'Chamado inválido.' };
  if (!SEGREDO_MESA.test(String(dados.mesa || ''))) return { ok: false, erro: 'Chamado inválido.' };
  if (!['garcom', 'conta'].includes(dados.tipo)) return { ok: false, erro: 'Chamado inválido.' };
  const aparelho = APARELHO.test(String(dados.aparelho || '')) ? dados.aparelho : null;
  const r = chamar({ token: dados.mesa, aparelho, tipo: dados.tipo, ip: 'vitrine' });
  return r?.ok ? { ok: true, repetido: !!r.repetido } : { ok: false, erro: String(r?.error || 'Não registrado.').slice(0, 120) };
}

async function processarChamado(docSnap, { firestore }) {
  const id = docSnap.id;
  if (estado.processando.has(id)) return;
  estado.processando.add(id);
  try {
    const dados = docSnap.data();
    if (!dados || dados.status !== 'novo') return;
    const r = tratarChamado(dados);
    const { doc, updateDoc, serverTimestamp } = require('firebase/firestore');
    const installId = require('./pdvRegistryService').getOrCreateDeviceUid();
    await updateDoc(doc(firestore, 'installations', installId, 'chamados_vitrine', id), r.ok
      ? { status: 'recebido', processadoEm: serverTimestamp() }
      : { status: 'erro', erro: r.erro, processadoEm: serverTimestamp() });
  } finally {
    estado.processando.delete(id);
  }
}

// --------------------------------------------------------------------- conta

/**
 * O que a página mostra de uma mesa: total e, por pessoa, o que pediu.
 * `mesa` é a mesa que vale para o QR (principal/transferida).
 */
function contaDaMesa(db, mesa) {
  const ml = require('./mesaLocalService');
  const efetiva = ml.mesaEfetiva(db, mesa);
  const saleId = ml.vendaAberta(db, efetiva);
  const rotulo = ml.rotuloMesa(efetiva);
  if (!saleId) return { rotulo, aberta: false, totalMesa: 0, pessoas: [] };
  const itens = db.prepare(`SELECT si.pessoa_numero AS numero, COALESCE(si.nome_personalizado, p.nome) AS nome,
                                   SUM(si.quantidade) AS quantidade, SUM(si.quantidade * si.preco_unitario) AS total
                            FROM sale_items si JOIN products p ON p.id = si.product_id
                            WHERE si.sale_id = ? AND si.cancelado = 0
                            GROUP BY si.pessoa_numero, si.product_id, COALESCE(si.nome_personalizado, p.nome)
                            ORDER BY MIN(si.criado_em), MIN(si.rowid)`).all(saleId);
  const pessoasDb = db.prepare('SELECT numero, nome, aparelho FROM sale_people WHERE sale_id = ? ORDER BY numero').all(saleId);
  const montar = (numero, nome, aparelho) => {
    const meus = itens.filter((i) => (i.numero ?? null) === numero).map((i) => ({ nome: String(i.nome).slice(0, 60), quantidade: r2(i.quantidade), total: r2(i.total) }));
    return { nome: nome ? String(nome).slice(0, 40) : 'Mesa', chave: aparelho && APARELHO.test(aparelho) ? chaveDoAparelho(aparelho) : null, itens: meus.slice(0, 60), total: r2(meus.reduce((s, i) => s + i.total, 0)) };
  };
  const pessoas = pessoasDb.map((p) => montar(p.numero, p.nome, p.aparelho)).filter((p) => p.itens.length || p.chave);
  const semPessoa = montar(null, null, null);
  if (semPessoa.itens.length) pessoas.push(semPessoa);
  const totalMesa = r2(db.prepare('SELECT COALESCE(SUM(quantidade * preco_unitario), 0) AS t FROM sale_items WHERE sale_id = ? AND cancelado = 0').get(saleId).t);
  return { rotulo, aberta: true, totalMesa, pessoas: pessoas.slice(0, 30) };
}

/** Publica as contas que mudaram (e fecha as que fecharam). Devolve quantas gravou. */
async function publicarContas({ gravar } = {}) {
  if (!ligado()) return 0;
  const db = getDb();
  const mesas = db.prepare("SELECT * FROM restaurant_tables WHERE qr_token IS NOT NULL AND unida_a_mesa_id IS NULL").all();
  let n = 0;
  for (const m of mesas) {
    if (!SEGREDO_MESA.test(String(m.qr_token || ''))) continue;
    const conta = contaDaMesa(db, m);
    const chave = chaveDaConta(m.qr_token);
    const assinatura = sha(JSON.stringify(conta));
    const anterior = estado.ultimo.get(chave);
    if (anterior === assinatura) continue;
    // Mesa que nunca teve conta publicada e está fechada: nada a gravar.
    if (anterior === undefined && !conta.aberta) { estado.ultimo.set(chave, assinatura); continue; }
    try {
      await (gravar || gravarConta)(chave, conta);
      estado.ultimo.set(chave, assinatura);
      n += 1;
    } catch (err) {
      console.error('[vitrineMesaService] conta não publicada:', err?.message || err);
    }
  }
  return n;
}

async function gravarConta(chave, conta) {
  const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
  const firestore = require('./licenseService').getLicenseFirestore();
  const installId = require('./pdvRegistryService').getOrCreateDeviceUid();
  await setDoc(doc(firestore, 'installations', installId, 'contas_mesa', chave), { ...conta, atualizadoEm: serverTimestamp() });
}

// -------------------------------------------------------------------- ligar

function pararEscuta() {
  if (estado.pararEscuta) { try { estado.pararEscuta(); } catch { /* já parada */ } }
  estado.pararEscuta = null;
  estado.escutando = false;
}

/** Liga/desliga conforme a vitrine (chamado ao iniciar, ao salvar a vitrine e de tempos em tempos). */
function atualizar() {
  const quer = ligado();
  if (!quer) { pararEscuta(); if (estado.timer) { clearInterval(estado.timer); estado.timer = null; } return; }
  if (!estado.timer) {
    estado.timer = setInterval(() => { publicarContas().catch((err) => console.error('[vitrineMesaService]', err?.message || err)); }, INTERVALO_MS);
    estado.timer.unref?.();
    publicarContas().catch(() => {});
  }
  if (estado.escutando) return;
  try {
    const { collection, query, where, onSnapshot } = require('firebase/firestore');
    const firestore = require('./licenseService').getLicenseFirestore();
    const installId = require('./pdvRegistryService').getOrCreateDeviceUid();
    estado.pararEscuta = onSnapshot(
      query(collection(firestore, 'installations', installId, 'chamados_vitrine'), where('status', '==', 'novo')),
      (snap) => {
        snap.docChanges().forEach((m) => {
          if (m.type === 'removed') return;
          processarChamado(m.doc, { firestore }).catch((err) => console.error('[vitrineMesaService]', err?.message || err));
        });
        // Chamou "conta": a página vai ler a conta agora, então atualiza já.
        publicarContas().catch(() => {});
      },
      // A escuta do Firestore que dá erro não volta sozinha: solta aqui e o
      // atualizar() de cada minuto liga de novo.
      (err) => { console.error('[vitrineMesaService] escuta de chamados falhou (religa no próximo minuto):', err?.message || err); pararEscuta(); },
    );
    estado.escutando = true;
  } catch (err) {
    console.error('[vitrineMesaService] não foi possível iniciar a escuta:', err?.message || err);
  }
}

function parar() { pararEscuta(); if (estado.timer) { clearInterval(estado.timer); estado.timer = null; } estado.ultimo.clear(); }

module.exports = { atualizar, parar, tratarChamado, contaDaMesa, publicarContas, chaveDaConta, chaveDoAparelho, SEGREDO_MESA };
