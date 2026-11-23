// Garçons das mesas (nov/2026).
//
// O gerente vincula garçons e operadores às mesas (a "praça" de cada um). O
// vínculo é da MESA e fica até o gerente tirar: vale para todas as contas que
// abrirem nela. Aparece como etiqueta no quadrado da mesa e sai na nota e na
// pré-nota ("Garçom: Ana"). Os itens que OUTRAS contas lançaram (caixa, outro
// garçom, QR da mesa, vitrine) continuam saindo com quem lançou e a hora.
//
// Tabelas no schema.sql (CREATE TABLE IF NOT EXISTS, sem migração e sem
// REFERENCES de propósito: mesa ou usuário apagado só some das consultas, e
// nada trava exclusão de venda/mesa/usuário):
//   mesa_atendentes  (table_id, user_id)        -- o vínculo atual
//   sale_atendentes  (sale_id, user_id, nome)   -- foto na hora de fechar a
//                                                  conta, para a nota sair
//                                                  igual depois (reimpressão)
// No grupo de caixas o vínculo mora no servidor (mesas do servidor); a conta
// leva os nomes para o caixa que recebe (mesaCompartilhadaService).

const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/** Quem pode ser vinculado a uma mesa. */
const PAPEIS_ATENDENTE = ['garcom', 'operador'];
const PAPEL_ROTULO = { garcom: 'Garçom', operador: 'Operador' };

function auditar(db, operadorId, motivo) {
  try {
    db.prepare('INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso) VALUES (?, ?, ?, ?, 1)')
      .run(randomUUID(), 'mesa_garcons', operadorId || null, motivo);
  } catch (err) {
    console.error('[mesaAtendentes] auditoria:', err?.message || err);
  }
}

function elegiveis(db) {
  const ph = PAPEIS_ATENDENTE.map(() => '?').join(', ');
  return db.prepare(`SELECT id, nome, role FROM users WHERE ativo = 1 AND role IN (${ph}) ORDER BY nome COLLATE NOCASE`)
    .all(...PAPEIS_ATENDENTE);
}

/** Map tableId → [{ id, nome }] (só usuários ativos), para a lista de mesas. */
function mapaDasMesas(db, locationId) {
  const mapa = new Map();
  let linhas = [];
  try {
    linhas = db.prepare(`
      SELECT ma.table_id, u.id, u.nome FROM mesa_atendentes ma
      JOIN users u ON u.id = ma.user_id AND u.ativo = 1
      JOIN restaurant_tables t ON t.id = ma.table_id
      WHERE t.location_id = ?
      ORDER BY u.nome COLLATE NOCASE`).all(locationId);
  } catch { linhas = []; }
  for (const l of linhas) {
    if (!mapa.has(l.table_id)) mapa.set(l.table_id, []);
    mapa.get(l.table_id).push({ id: l.id, nome: l.nome });
  }
  return mapa;
}

/** Garçons da conta ABERTA: os da mesa principal e das unidas a ela. */
function atendentesDaContaAberta(db, saleId) {
  if (!saleId) return [];
  try {
    return db.prepare(`
      SELECT DISTINCT u.id, u.nome FROM restaurant_tables t
      JOIN mesa_atendentes ma ON ma.table_id = t.id
      JOIN users u ON u.id = ma.user_id AND u.ativo = 1
      WHERE t.sale_id = ?
      ORDER BY u.nome COLLATE NOCASE`).all(saleId);
  } catch { return []; }
}

/**
 * Foto dos garçons na venda (ao fechar/desocupar/juntar -- chamado junto com
 * saleService.registrarMesasDaVenda). Idempotente: a primeira foto fica.
 */
function registrarAtendentesDaVenda(db, saleId) {
  try {
    if (db.prepare('SELECT 1 FROM sale_atendentes WHERE sale_id = ? LIMIT 1').get(saleId)) return;
    const ins = db.prepare('INSERT OR IGNORE INTO sale_atendentes (sale_id, user_id, nome) VALUES (?, ?, ?)');
    for (const a of atendentesDaContaAberta(db, saleId)) ins.run(saleId, a.id, a.nome);
  } catch (err) {
    console.error('[mesaAtendentes] foto da venda:', err?.message || err);
  }
}

/** Grava a foto que veio de outra máquina (conta recebida no caixa do grupo). */
function gravarAtendentesDaVenda(db, saleId, lista) {
  const ins = db.prepare('INSERT OR IGNORE INTO sale_atendentes (sale_id, user_id, nome) VALUES (?, ?, ?)');
  for (const a of Array.isArray(lista) ? lista : []) {
    const nome = String(a?.nome || '').trim().slice(0, 80);
    if (nome) ins.run(saleId, a.id || null, nome);
  }
}

/** Garçons de uma venda: a foto, se já tem; senão os da mesa agora. */
function atendentesDaVenda(db, saleId) {
  try {
    const foto = db.prepare('SELECT user_id AS id, nome FROM sale_atendentes WHERE sale_id = ? ORDER BY nome COLLATE NOCASE').all(saleId);
    if (foto.length) return foto;
  } catch { /* tabela ainda não existe */ }
  return atendentesDaContaAberta(db, saleId);
}

/** "Ana" | "Ana e Bruno" | "Ana, Bruno e Carla". */
function rotuloDosAtendentes(lista) {
  const nomes = (lista || []).map((a) => a.nome).filter(Boolean);
  if (nomes.length <= 1) return nomes[0] || '';
  return `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
}

const ROTULO_ORIGEM = { qr_mesa: 'QR da mesa', vitrine: 'Vitrine', whatsapp: 'WhatsApp' };

/**
 * Quem lançou o item, para a nota/pré-nota: só quando a conta tem garçom
 * vinculado e o item veio de OUTRA conta (ou do QR/vitrine). Item do próprio
 * garçom vinculado não repete o nome (a linha "Garçom:" já diz).
 */
function quemLancouParaImprimir(item, atendentes) {
  if (!atendentes?.length) return null;
  const origem = ROTULO_ORIGEM[item.origem];
  if (origem) return origem;
  if (!item.lancadoPorId) return null;
  if (atendentes.some((a) => a.id && a.id === item.lancadoPorId)) return null;
  return item.lancadoPorNome || null;
}

/**
 * Para a nota (printService.printReceipt): os nomes dos garçons e os itens com
 * `quem` (só os de OUTRA conta). Sem garçom vinculado, os itens voltam iguais.
 * `items` = linhas de sale_items (com lancado_por e origem).
 */
function garconsDaNota(db, saleId, items) {
  const atendentes = atendentesDaVenda(db, saleId);
  if (!atendentes.length) return { garcons: [], itens: items };
  const nomes = new Map(db.prepare('SELECT DISTINCT u.id, u.nome FROM sale_items si JOIN users u ON u.id = si.lancado_por WHERE si.sale_id = ?')
    .all(saleId).map((u) => [u.id, u.nome]));
  return {
    garcons: atendentes.map((a) => a.nome),
    itens: items.map((i) => ({
      ...i,
      quem: quemLancouParaImprimir({ origem: i.origem, lancadoPorId: i.lancado_por, lancadoPorNome: nomes.get(i.lancado_por) }, atendentes),
    })),
  };
}

// ------------------------------------------------------------------ tela do gerente

/** Para a janela "Garçons das mesas": quem pode ser vinculado, as mesas e os vínculos. */
function painel({ locationId } = {}) {
  const db = getDb();
  const mesas = db.prepare(`SELECT id, numero, nome FROM restaurant_tables WHERE location_id = ?
                            ORDER BY (ordem IS NULL), ordem, CAST(numero AS INTEGER), numero`).all(locationId);
  const ids = new Set(mesas.map((m) => m.id));
  const vinculos = db.prepare(`SELECT ma.table_id AS tableId, ma.user_id AS userId FROM mesa_atendentes ma
                               JOIN users u ON u.id = ma.user_id AND u.ativo = 1`).all().filter((v) => ids.has(v.tableId));
  return {
    ok: true,
    atendentes: elegiveis(db).map((u) => ({ id: u.id, nome: u.nome, papel: PAPEL_ROTULO[u.role] || u.role })),
    mesas: mesas.map((m) => ({ id: m.id, rotulo: m.nome || `Mesa ${m.numero}` })),
    vinculos,
  };
}

/** Define as mesas de UM garçom/operador (troca a lista inteira dele). */
function definirMesasDoAtendente({ userId, tableIds, locationId, operadorId } = {}) {
  const db = getDb();
  const u = db.prepare('SELECT id, nome, role, ativo FROM users WHERE id = ?').get(userId);
  if (!u || u.ativo !== 1) return { ok: false, error: 'Usuário não encontrado.' };
  if (!PAPEIS_ATENDENTE.includes(u.role)) return { ok: false, error: 'Só garçom ou operador pode ser vinculado à mesa.' };
  const pedidos = [...new Set((Array.isArray(tableIds) ? tableIds : []).map(String))];
  const daLoja = new Set(db.prepare('SELECT id FROM restaurant_tables WHERE location_id = ?').all(locationId).map((t) => t.id));
  const invalida = pedidos.find((id) => !daLoja.has(id));
  if (invalida) return { ok: false, error: 'Mesa não encontrada.' };
  db.transaction(() => {
    db.prepare(`DELETE FROM mesa_atendentes WHERE user_id = ? AND table_id IN (SELECT id FROM restaurant_tables WHERE location_id = ?)`).run(u.id, locationId);
    const ins = db.prepare('INSERT INTO mesa_atendentes (table_id, user_id, vinculado_por) VALUES (?, ?, ?)');
    for (const id of pedidos) ins.run(id, u.id, operadorId || null);
    const rotulos = pedidos.length
      ? db.prepare(`SELECT COALESCE(nome, 'Mesa ' || numero) AS r FROM restaurant_tables WHERE id IN (${pedidos.map(() => '?').join(',')})
                    ORDER BY CAST(numero AS INTEGER), numero`).all(...pedidos).map((x) => x.r).join(', ')
      : 'nenhuma';
    auditar(db, operadorId, `Mesas de ${u.nome}: ${rotulos}`);
  })();
  return { ok: true, quantidade: pedidos.length };
}

/** Tira todos os vínculos do local (ex.: troca de turno). */
function limparTodos({ locationId, operadorId } = {}) {
  const db = getDb();
  const r = db.prepare('DELETE FROM mesa_atendentes WHERE table_id IN (SELECT id FROM restaurant_tables WHERE location_id = ?)').run(locationId);
  if (r.changes) auditar(db, operadorId, `Tirou os garçons de todas as mesas (${r.changes} vínculo(s))`);
  return { ok: true, removidos: r.changes };
}

module.exports = {
  PAPEIS_ATENDENTE,
  mapaDasMesas, atendentesDaContaAberta, atendentesDaVenda, registrarAtendentesDaVenda, gravarAtendentesDaVenda,
  rotuloDosAtendentes, quemLancouParaImprimir, garconsDaNota,
  painel, definirMesasDoAtendente, limparTodos,
};
