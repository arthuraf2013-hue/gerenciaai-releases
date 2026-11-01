const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const timeService = require('./timeService');

/**
 * Gestão de pessoas (ERP, Fase 6): cadastro da equipe, checklist de
 * documentos e controle de férias. NÃO calcula folha, INSS, FGTS nem
 * rescisão (isso é do contador / sistema de folha integrado ao eSocial).
 * Férias: informativo pela CLT (30 dias por período aquisitivo de 12 meses,
 * concedidas nos 12 meses seguintes); não considera faltas (art. 130).
 */

const DOCUMENTOS = {
  rg: 'RG ou CNH', cpf: 'CPF', ctps: 'Carteira de trabalho (CTPS digital)', pis: 'PIS/NIS', endereco: 'Comprovante de endereço',
  aso: 'Exame admissional (ASO)', contrato: 'Contrato de trabalho assinado', foto: 'Foto 3x4',
};
const ehData = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && (() => { const d = new Date(`${s}T12:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; })();
const vazio = (v) => v === undefined || v === null || String(v).trim() === '';

function cpfValido(cpf) {
  const d = String(cpf || '').replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n) => {
    let soma = 0;
    for (let i = 0; i < n; i += 1) soma += Number(d[i]) * (n + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

function somarMeses(iso, n) {
  const [a, m, dia] = iso.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(dia, ultimo));
  return alvo.toISOString().slice(0, 10);
}
function somarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const diasEntre = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

function salvar(c = {}) {
  const db = getDb();
  const nome = String(c.nome || '').trim();
  if (!nome || nome.length > 120) return { ok: false, error: 'Informe o nome (até 120 caracteres).' };
  const cpf = vazio(c.cpf) ? null : String(c.cpf).replace(/\D/g, '');
  if (cpf && !cpfValido(cpf)) return { ok: false, error: 'CPF inválido.' };
  for (const [campo, rotulo] of [['admissao', 'Admissão'], ['demissao', 'Desligamento']]) {
    if (!vazio(c[campo]) && !ehData(c[campo])) return { ok: false, error: `${rotulo}: data inválida.` };
  }
  if (!vazio(c.demissao) && !vazio(c.admissao) && c.demissao < c.admissao) return { ok: false, error: 'Desligamento antes da admissão.' };
  const salario = vazio(c.salario) ? null : Number(c.salario);
  if (salario !== null && !(Number.isFinite(salario) && salario >= 0)) return { ok: false, error: 'Salário inválido.' };
  if (!vazio(c.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(c.email))) return { ok: false, error: 'E-mail inválido.' };
  if (c.userId && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(c.userId)) return { ok: false, error: 'Usuário do PDV não encontrado.' };
  const documentos = {};
  for (const [k, v] of Object.entries(c.documentos || {})) {
    if (!DOCUMENTOS[k]) return { ok: false, error: `Documento desconhecido: ${k}` };
    documentos[k] = !!v;
  }
  if (cpf && db.prepare('SELECT 1 FROM employees WHERE cpf = ? AND id != COALESCE(?, \'\') AND ativo = 1').get(cpf, c.id || null)) {
    return { ok: false, error: 'Já existe alguém ativo com esse CPF.' };
  }
  const linha = {
    nome, cpf, cargo: vazio(c.cargo) ? null : String(c.cargo).trim().slice(0, 60), departamento: vazio(c.departamento) ? null : String(c.departamento).trim().slice(0, 60),
    admissao: vazio(c.admissao) ? null : c.admissao, demissao: vazio(c.demissao) ? null : c.demissao, salario,
    telefone: vazio(c.telefone) ? null : String(c.telefone).trim().slice(0, 30), email: vazio(c.email) ? null : String(c.email).trim().slice(0, 120),
    user_id: c.userId || null, documentos: JSON.stringify(documentos), observacoes: vazio(c.observacoes) ? null : String(c.observacoes).slice(0, 1000),
    ativo: vazio(c.demissao) ? 1 : 0,
  };
  if (c.id) {
    const r = db.prepare(`UPDATE employees SET ${Object.keys(linha).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...linha, id: c.id });
    return r.changes ? { ok: true, id: c.id } : { ok: false, error: 'Colaborador não encontrado.' };
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO employees (id, ${Object.keys(linha).join(', ')}) VALUES (@id, ${Object.keys(linha).map((k) => `@${k}`).join(', ')})`).run({ ...linha, id });
  return { ok: true, id };
}

/** Períodos aquisitivos e saldo de férias (gozo abate o período mais antigo). */
function situacaoFerias(empregado, ferias, hoje = timeService.hojeLocalISO()) {
  if (!empregado.admissao) return { periodos: [], alerta: null };
  const fimContrato = empregado.demissao && empregado.demissao < hoje ? empregado.demissao : hoje;
  const periodos = [];
  for (let k = 0; k < 60; k += 1) {
    const inicio = somarMeses(empregado.admissao, 12 * k);
    if (inicio > fimContrato) break;
    const fim = somarDias(somarMeses(empregado.admissao, 12 * (k + 1)), -1);
    periodos.push({ inicio, fim, limite: somarDias(somarMeses(fim, 12), 0), direito: fim <= fimContrato ? 30 : 0, gozados: 0 });
  }
  let gozados = ferias.reduce((s, f) => s + diasEntre(f.inicio, f.fim) + 1, 0);
  for (const p of periodos) {
    if (p.direito === 0) continue;
    const usa = Math.min(p.direito, gozados);
    p.gozados = usa;
    gozados -= usa;
  }
  let alerta = null;
  for (const p of periodos) {
    p.saldo = p.direito - p.gozados;
    p.situacao = p.direito === 0 ? 'em_aquisicao' : p.saldo === 0 ? 'gozadas' : p.limite < hoje ? 'vencidas' : diasEntre(hoje, p.limite) <= 60 ? 'vencendo' : 'a_gozar';
    if (!empregado.demissao && (p.situacao === 'vencidas' || (p.situacao === 'vencendo' && !alerta))) {
      alerta = p.situacao === 'vencidas'
        ? { nivel: 'critico', texto: `${empregado.nome}: férias do período ${p.inicio.split('-').reverse().join('/')} venceram em ${p.limite.split('-').reverse().join('/')} (pagamento em dobro, CLT art. 137). Fale com o contador.` }
        : { nivel: 'aviso', texto: `${empregado.nome}: ${p.saldo} dia(s) de férias a conceder até ${p.limite.split('-').reverse().join('/')}.` };
    }
  }
  return { periodos, alerta };
}

function listar({ incluirInativos = false } = {}) {
  const db = getDb();
  const lista = db.prepare(`SELECT e.*, u.nome AS usuario_nome FROM employees e LEFT JOIN users u ON u.id = e.user_id ${incluirInativos ? '' : 'WHERE e.ativo = 1'} ORDER BY e.ativo DESC, e.nome`).all();
  const hoje = timeService.hojeLocalISO();
  const alertas = [];
  const resultado = lista.map((e) => {
    const ferias = db.prepare('SELECT * FROM employee_vacations WHERE employee_id = ? ORDER BY inicio').all(e.id);
    const situacao = situacaoFerias(e, ferias, hoje);
    if (situacao.alerta) alertas.push(situacao.alerta);
    const documentos = JSON.parse(e.documentos || '{}');
    const faltando = Object.keys(DOCUMENTOS).filter((k) => !documentos[k]);
    if (e.ativo && e.admissao && faltando.length && diasEntre(e.admissao, hoje) > 30) {
      alertas.push({ nivel: 'info', texto: `${e.nome}: faltam ${faltando.length} documento(s) no checklist.` });
    }
    const emFerias = ferias.find((f) => f.inicio <= hoje && f.fim >= hoje);
    return { ...e, documentos, documentosFaltando: faltando.map((k) => DOCUMENTOS[k]), ferias, periodos: situacao.periodos, emFerias: !!emFerias };
  });
  const ativos = resultado.filter((e) => e.ativo);
  return {
    ok: true, colaboradores: resultado, alertas, documentosCatalogo: DOCUMENTOS,
    usuarios: db.prepare("SELECT id, nome, role FROM users WHERE ativo = 1 AND role != 'suporte' ORDER BY nome").all(),
    resumo: {
      ativos: ativos.length,
      folhaBaseMensal: Math.round(ativos.reduce((s, e) => s + (e.salario || 0), 0) * 100) / 100,
      emFerias: ativos.filter((e) => e.emFerias).length,
      porDepartamento: Object.entries(ativos.reduce((m, e) => ({ ...m, [e.departamento || 'Sem departamento']: (m[e.departamento || 'Sem departamento'] || 0) + 1 }), {})).map(([departamento, qtd]) => ({ departamento, qtd })),
    },
  };
}

function registrarFerias({ employeeId, inicio, fim, observacao } = {}) {
  const db = getDb();
  const e = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!e) return { ok: false, error: 'Colaborador não encontrado.' };
  if (!ehData(inicio) || !ehData(fim) || fim < inicio) return { ok: false, error: 'Período inválido.' };
  const dias = diasEntre(inicio, fim) + 1;
  if (dias > 30) return { ok: false, error: 'Um período de férias tem no máximo 30 dias.' };
  if (dias < 5) return { ok: false, error: 'Período de férias com menos de 5 dias não é permitido (CLT art. 134).' };
  if (e.admissao && inicio < e.admissao) return { ok: false, error: 'Férias antes da admissão.' };
  if (db.prepare('SELECT 1 FROM employee_vacations WHERE employee_id = ? AND inicio <= ? AND fim >= ?').get(employeeId, fim, inicio)) {
    return { ok: false, error: 'Já existem férias nesse período.' };
  }
  const id = randomUUID();
  db.prepare('INSERT INTO employee_vacations (id, employee_id, inicio, fim, observacao) VALUES (?, ?, ?, ?, ?)')
    .run(id, employeeId, inicio, fim, vazio(observacao) ? null : String(observacao).slice(0, 200));
  return { ok: true, id };
}

function removerFerias({ id } = {}) {
  const r = getDb().prepare('DELETE FROM employee_vacations WHERE id = ?').run(id);
  return r.changes ? { ok: true } : { ok: false, error: 'Registro não encontrado.' };
}

module.exports = { salvar, listar, registrarFerias, removerFerias, situacaoFerias, cpfValido, DOCUMENTOS };
