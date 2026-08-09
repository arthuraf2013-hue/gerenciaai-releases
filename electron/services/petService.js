const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/** Pets de um cliente específico. */
function listByCustomer(customerId) {
  const db = getDb();
  return db.prepare('SELECT * FROM pets WHERE customer_id = ? AND ativo = 1 ORDER BY nome').all(customerId);
}

function upsert(pet) {
  if (!pet.nome?.trim()) return { ok: false, error: 'Informe o nome do pet.' };
  if (!pet.customerId) return { ok: false, error: 'Pet precisa estar vinculado a um cliente.' };
  const db = getDb();
  const id = pet.id || randomUUID();
  db.prepare(
    `INSERT INTO pets (id, customer_id, nome, especie, raca, ultima_vacina_em, proxima_vacina_em, ultimo_vermifugo_em, proximo_vermifugo_em, observacoes)
     VALUES (@id, @customerId, @nome, @especie, @raca, @ultimaVacinaEm, @proximaVacinaEm, @ultimoVermifugoEm, @proximoVermifugoEm, @observacoes)
     ON CONFLICT(id) DO UPDATE SET
       nome=excluded.nome, especie=excluded.especie, raca=excluded.raca,
       ultima_vacina_em=excluded.ultima_vacina_em, proxima_vacina_em=excluded.proxima_vacina_em,
       ultimo_vermifugo_em=excluded.ultimo_vermifugo_em, proximo_vermifugo_em=excluded.proximo_vermifugo_em,
       observacoes=excluded.observacoes`
  ).run({
    id, customerId: pet.customerId, nome: pet.nome.trim(), especie: pet.especie || null, raca: pet.raca || null,
    ultimaVacinaEm: pet.ultimaVacinaEm || null, proximaVacinaEm: pet.proximaVacinaEm || null,
    ultimoVermifugoEm: pet.ultimoVermifugoEm || null, proximoVermifugoEm: pet.proximoVermifugoEm || null,
    observacoes: pet.observacoes || null,
  });
  return { ok: true, id };
}

function deactivate(petId) {
  const db = getDb();
  db.prepare('UPDATE pets SET ativo = 0 WHERE id = ?').run(petId);
  return { ok: true };
}

/**
 * Pets com vacina ou vermífugo vencendo dentro de `diasAntecedencia`
 * (ou já vencido) — pra avisar o dono antes que passe da data, não só
 * depois. Só considera pet com data cadastrada (quem nunca preencheu
 * não entra, não tem o que avisar).
 */
function listLembretesPendentes({ diasAntecedencia = 7 } = {}) {
  const db = getDb();
  const limite = new Date(Date.now() + diasAntecedencia * 86400000).toISOString().slice(0, 10);

  const pets = db.prepare(
    `SELECT p.id, p.nome, p.especie, p.proxima_vacina_em, p.proximo_vermifugo_em,
       c.id as customerId, c.nome as clienteNome, c.telefone as clienteTelefone
     FROM pets p
     JOIN customers c ON c.id = p.customer_id
     WHERE p.ativo = 1 AND c.ativo = 1
       AND ((p.proxima_vacina_em IS NOT NULL AND p.proxima_vacina_em <= ?)
         OR (p.proximo_vermifugo_em IS NOT NULL AND p.proximo_vermifugo_em <= ?))`
  ).all(limite, limite);

  const hoje = new Date().toISOString().slice(0, 10);
  return pets.map((p) => ({
    id: p.id, nome: p.nome, especie: p.especie,
    customerId: p.customerId, clienteNome: p.clienteNome, clienteTelefone: p.clienteTelefone,
    vacinaVencida: p.proxima_vacina_em && p.proxima_vacina_em < hoje,
    vacinaPendente: p.proxima_vacina_em && p.proxima_vacina_em <= limite ? p.proxima_vacina_em : null,
    vermifugoVencido: p.proximo_vermifugo_em && p.proximo_vermifugo_em < hoje,
    vermifugoPendente: p.proximo_vermifugo_em && p.proximo_vermifugo_em <= limite ? p.proximo_vermifugo_em : null,
  })).sort((a, b) => (a.vacinaPendente || a.vermifugoPendente || '').localeCompare(b.vacinaPendente || b.vermifugoPendente || ''));
}

/** Link de WhatsApp com lembrete pronto — mesmo padrão dos outros
 * links de wa.me já usados no sistema (recibo, reconquista de cliente). */
function montarLinkLembrete(petId) {
  const db = getDb();
  const pet = db.prepare(
    `SELECT p.*, c.nome as clienteNome, c.telefone as clienteTelefone FROM pets p JOIN customers c ON c.id = p.customer_id WHERE p.id = ?`
  ).get(petId);
  if (!pet) return { ok: false, error: 'Pet não encontrado.' };
  if (!pet.clienteTelefone) return { ok: false, error: 'O dono desse pet não tem telefone cadastrado.' };

  const hoje = new Date().toISOString().slice(0, 10);
  const partes = [];
  if (pet.proxima_vacina_em && pet.proxima_vacina_em <= hoje) partes.push('a vacina');
  if (pet.proximo_vermifugo_em && pet.proximo_vermifugo_em <= hoje) partes.push('o vermífugo');
  // Se nada estiver VENCIDO ainda (só chegando perto, dentro do prazo de aviso),
  // usa uma frase mais suave em vez de "pendente" -- ainda não venceu de verdade.
  const jaVencido = partes.length > 0;
  if (!jaVencido) {
    if (pet.proxima_vacina_em) partes.push('a vacina');
    if (pet.proximo_vermifugo_em) partes.push('o vermífugo');
  }

  const primeiroNome = pet.clienteNome.trim().split(' ')[0];
  const mensagem = jaVencido
    ? `Oi, ${primeiroNome}! Passando pra lembrar que ${pet.nome} está com ${partes.join(' e ')} pendente. Bora agendar? 🐾`
    : `Oi, ${primeiroNome}! ${pet.nome} está com ${partes.join(' e ')} chegando perto da data — bora agendar antes de vencer? 🐾`;

  const digitos = pet.clienteTelefone.replace(/\D/g, '');
  const numeroLimpo = digitos.startsWith('55') ? digitos : '55' + digitos;
  const url = `https://wa.me/${numeroLimpo}?text=${encodeURIComponent(mensagem)}`;
  return { ok: true, url, mensagem };
}

module.exports = { listByCustomer, upsert, deactivate, listLembretesPendentes, montarLinkLembrete };
