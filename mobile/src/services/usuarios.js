import { novoId, agoraIso, ErroDeNegocio, auditar, ctx, agoraMs } from './base.js';

// PIN nunca é guardado em claro: PBKDF2-SHA256 com sal aleatório por
// usuário (WebCrypto nativo -- rápido até em celular de entrada).
const ITERACOES = 60000;
const PAPEIS = ['admin', 'gerente', 'operador'];

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPin(pin, saltHex) {
  const enc = new TextEncoder();
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const chave = await globalThis.crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITERACOES, hash: 'SHA-256' }, chave, 256);
  return hex(bits);
}

function validarPin(pin) {
  if (!/^\d{4,8}$/.test(String(pin || ''))) throw new ErroDeNegocio('O PIN precisa ter de 4 a 8 números.');
}

export async function criarUsuario(db, { nome, papel, pin }, autorId = null) {
  const nomeLimpo = String(nome || '').trim();
  if (!nomeLimpo) throw new ErroDeNegocio('Informe o nome.');
  if (!PAPEIS.includes(papel)) throw new ErroDeNegocio('Papel inválido.');
  validarPin(pin);
  const salt = hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const id = novoId();
  await db.run(
    'INSERT INTO usuarios (id, nome, papel, pin_hash, pin_salt, ativo, criado_em, dispositivo_id) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    [id, nomeLimpo, papel, await hashPin(pin, salt), salt, agoraIso(), ctx().dispositivoId],
  );
  await auditar(db, 'usuario_criado', { id, nome: nomeLimpo, papel }, autorId);
  return id;
}

export function listarUsuarios(db, { incluirInativos = false } = {}) {
  return db.all(
    `SELECT id, nome, papel, ativo FROM usuarios ${incluirInativos ? '' : 'WHERE ativo = 1'} ORDER BY papel = 'operador', nome`,
  );
}

// Trava simples contra chute de PIN: 5 erros seguidos no mesmo usuário
// = 30 s de espera. Em memória de propósito (reiniciar o app zera, mas
// também custa tempo -- e o PIN aqui é controle de operador, não cofre).
const tentativas = new Map();
const MAX_ERROS = 5;
const ESPERA_MS = 30000;

function checarTrava(chave) {
  const t = tentativas.get(chave);
  if (t && t.erros >= MAX_ERROS && agoraMs() - t.ultimo < ESPERA_MS) {
    const s = Math.ceil((ESPERA_MS - (agoraMs() - t.ultimo)) / 1000);
    throw new ErroDeNegocio(`Muitas tentativas erradas. Aguarde ${s} s.`, 'pin_travado');
  }
}
function registrarErro(chave) {
  const t = tentativas.get(chave) || { erros: 0, ultimo: 0 };
  if (agoraMs() - t.ultimo >= ESPERA_MS && t.erros >= MAX_ERROS) t.erros = 0;
  t.erros += 1;
  t.ultimo = agoraMs();
  tentativas.set(chave, t);
}

async function pinConfere(usuario, pin) {
  return (await hashPin(pin, usuario.pin_salt)) === usuario.pin_hash;
}

export async function autenticar(db, usuarioId, pin) {
  checarTrava(usuarioId);
  const u = await db.get('SELECT * FROM usuarios WHERE id = ? AND ativo = 1', [usuarioId]);
  if (!u || !(await pinConfere(u, pin))) {
    registrarErro(usuarioId);
    throw new ErroDeNegocio('PIN incorreto.', 'pin_incorreto');
  }
  tentativas.delete(usuarioId);
  return { id: u.id, nome: u.nome, papel: u.papel };
}

/**
 * Autorização de gerente (desconto acima do limite, cancelamento de
 * venda...). Aceita qualquer gerente/admin ativo cujo PIN bata, MENOS o
 * próprio operador que está pedindo -- mesmo sendo gerente, ninguém
 * autoriza a si mesmo (mesma regra do GerenciaAI do computador).
 */
export async function autorizarGerente(db, { pin, solicitanteId }) {
  checarTrava('gerente');
  const candidatos = await db.all(
    `SELECT * FROM usuarios WHERE ativo = 1 AND papel IN ('admin', 'gerente') AND id != ?`,
    [solicitanteId || ''],
  );
  for (const u of candidatos) {
    if (await pinConfere(u, pin)) {
      tentativas.delete('gerente');
      return { id: u.id, nome: u.nome, papel: u.papel };
    }
  }
  registrarErro('gerente');
  if (candidatos.length === 0) {
    throw new ErroDeNegocio('Precisa de outro gerente ou administrador para autorizar. Cadastre um em Ajustes → Operadores.', 'sem_gerente');
  }
  throw new ErroDeNegocio('PIN de gerente incorreto (o próprio operador não pode autorizar).', 'pin_incorreto');
}

export async function trocarPin(db, usuarioId, pinNovo, autorId) {
  validarPin(pinNovo);
  const salt = hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const r = await db.run('UPDATE usuarios SET pin_hash = ?, pin_salt = ? WHERE id = ?', [await hashPin(pinNovo, salt), salt, usuarioId]);
  if (!r.changes) throw new ErroDeNegocio('Usuário não encontrado.');
  await auditar(db, 'pin_trocado', { usuarioId }, autorId);
}

export async function definirAtivo(db, usuarioId, ativo, autorId) {
  if (!ativo) {
    const u = await db.get('SELECT papel FROM usuarios WHERE id = ?', [usuarioId]);
    if (u?.papel === 'admin') {
      const admins = await db.valor(`SELECT COUNT(*) FROM usuarios WHERE papel = 'admin' AND ativo = 1`);
      if (admins <= 1) throw new ErroDeNegocio('Não dá pra desativar o único administrador.');
    }
    if (usuarioId === autorId) throw new ErroDeNegocio('Você não pode desativar o próprio usuário.');
  }
  await db.run('UPDATE usuarios SET ativo = ? WHERE id = ?', [ativo ? 1 : 0, usuarioId]);
  await auditar(db, ativo ? 'usuario_reativado' : 'usuario_desativado', { usuarioId }, autorId);
}
