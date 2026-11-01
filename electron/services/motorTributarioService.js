const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const timeService = require('./timeService');

function assistenteFiscal() { return require('./assistenteFiscalService'); }

/**
 * Motor tributário (ERP, Fase 4): um lugar só que decide CST/CSOSN,
 * alíquota, base e valor de cada tributo de um item, a partir de regras
 * versionadas por vigência (tabela tax_rules). Nada de alíquota fixa no
 * código: a única coisa semeada é o que tem base legal clara para todos
 * (regrasTributariasPadrao.js).
 *
 * Escolha da regra, por tributo: entre as ativas, vigentes na data e cujos
 * critérios batem (critério NULL = qualquer valor), vence a mais específica
 * (pesos abaixo); empate -> regra da loja antes da do sistema -> vigência
 * mais recente -> versão maior -> id (determinístico). A resposta traz a
 * regra usada e quantas empataram, para auditoria.
 *
 * Ainda NÃO alimenta a emissão da NFC-e (nfceXmlService continua com o
 * cadastro do produto): ligar isso exige homologação na SEFAZ. Hoje serve
 * para simular, conferir o cadastro e preparar a reforma (IBS/CBS).
 */

const TRIBUTOS = ['ICMS', 'ICMS_ST', 'FCP', 'PIS', 'COFINS', 'IPI', 'ISS', 'IBS', 'CBS', 'IS'];
const REGIMES = ['mei', 'simples_nacional', 'lucro_presumido', 'lucro_real'];
const NATUREZAS = ['venda', 'devolucao', 'transferencia', 'remessa', 'outra'];
const PERFIS = ['consumidor_final', 'contribuinte', 'nao_contribuinte'];
const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
const PESOS = { regime: 32, cfop: 16, cst_csosn_item: 8, uf_destino: 4, uf_origem: 2, natureza: 2, perfil_cliente: 2 };
const ESPERADOS = {
  mei: ['ICMS', 'PIS', 'COFINS'],
  simples_nacional: ['ICMS', 'PIS', 'COFINS'],
  lucro_presumido: ['ICMS', 'PIS', 'COFINS', 'IBS', 'CBS'],
  lucro_real: ['ICMS', 'PIS', 'COFINS', 'IBS', 'CBS'],
};

const arred = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
// Data de calendário de verdade (2026-02-30 não passa: o Date "rolaria" para março).
const ehData = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && (() => { const d = new Date(`${s}T12:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; })();
const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');
const vazio = (v) => v === undefined || v === null || String(v).trim() === '';

function diaAnterior(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ---------- cadastro de regras ----------

/** Normaliza e valida os campos de uma regra. Devolve { ok, regra } ou { ok:false, error }. */
function validar(c) {
  const r = {
    nome: String(c.nome || '').trim(),
    tributo: c.tributo,
    regime: vazio(c.regime) ? null : c.regime,
    uf_origem: vazio(c.ufOrigem) ? null : String(c.ufOrigem).toUpperCase(),
    uf_destino: vazio(c.ufDestino) ? null : String(c.ufDestino).toUpperCase(),
    ncm_prefixo: vazio(c.ncmPrefixo) ? null : soDigitos(c.ncmPrefixo),
    cfop: vazio(c.cfop) ? null : soDigitos(c.cfop),
    cst_csosn_item: vazio(c.cstCsosnItem) ? null : soDigitos(c.cstCsosnItem),
    natureza: vazio(c.natureza) ? null : c.natureza,
    perfil_cliente: vazio(c.perfilCliente) ? null : c.perfilCliente,
    cst: vazio(c.cst) ? null : soDigitos(c.cst),
    cclass_trib: vazio(c.cclassTrib) ? null : soDigitos(c.cclassTrib),
    aliquota: vazio(c.aliquota) ? 0 : Number(c.aliquota),
    reducao_base: vazio(c.reducaoBase) ? 0 : Number(c.reducaoBase),
    mva: vazio(c.mva) ? 0 : Number(c.mva),
    aliquota_interna_destino: vazio(c.aliquotaInternaDestino) ? null : Number(c.aliquotaInternaDestino),
    recolhido_no_das: c.recolhidoNoDas ? 1 : 0,
    informativo: c.informativo ? 1 : 0,
    difal_base: vazio(c.difalBase) ? null : c.difalBase,
    fundamento: vazio(c.fundamento) ? null : String(c.fundamento).trim().slice(0, 1000),
    vigencia_inicio: c.vigenciaInicio,
    vigencia_fim: vazio(c.vigenciaFim) ? null : c.vigenciaFim,
  };
  if (!r.nome) return { ok: false, error: 'Dê um nome à regra.' };
  if (r.nome.length > 120) return { ok: false, error: 'Nome muito longo (máx. 120).' };
  if (!TRIBUTOS.includes(r.tributo)) return { ok: false, error: 'Tributo inválido.' };
  if (r.regime && !REGIMES.includes(r.regime)) return { ok: false, error: 'Regime inválido.' };
  if (r.uf_origem && !UFS.includes(r.uf_origem)) return { ok: false, error: 'UF de origem inválida.' };
  if (r.uf_destino && !UFS.includes(r.uf_destino)) return { ok: false, error: 'UF de destino inválida.' };
  if (r.ncm_prefixo && (r.ncm_prefixo.length < 2 || r.ncm_prefixo.length > 8)) return { ok: false, error: 'NCM: informe de 2 a 8 dígitos (prefixo).' };
  if (r.cfop && !/^[1-7]\d{3}$/.test(r.cfop)) return { ok: false, error: 'CFOP inválido (4 dígitos).' };
  if (r.cst_csosn_item && !/^\d{2,3}$/.test(r.cst_csosn_item)) return { ok: false, error: 'CST/CSOSN do produto inválido.' };
  if (r.natureza && !NATUREZAS.includes(r.natureza)) return { ok: false, error: 'Natureza da operação inválida.' };
  if (r.perfil_cliente && !PERFIS.includes(r.perfil_cliente)) return { ok: false, error: 'Perfil do cliente inválido.' };
  if (r.cst && !/^\d{2,3}$/.test(r.cst)) return { ok: false, error: 'CST/CSOSN de saída inválido (2 ou 3 dígitos).' };
  if (r.cclass_trib && !/^\d{6}$/.test(r.cclass_trib)) return { ok: false, error: 'cClassTrib tem 6 dígitos.' };
  for (const [campo, v, max] of [['Alíquota', r.aliquota, 100], ['Alíquota interna do destino', r.aliquota_interna_destino ?? 0, 100]]) {
    if (!Number.isFinite(v) || v < 0 || v > max) return { ok: false, error: `${campo} deve ficar entre 0 e ${max}%.` };
  }
  if (!Number.isFinite(r.reducao_base) || r.reducao_base < 0 || r.reducao_base >= 100) return { ok: false, error: 'Redução de base deve ficar entre 0 e 99,99%.' };
  if (!Number.isFinite(r.mva) || r.mva < 0 || r.mva > 1000) return { ok: false, error: 'MVA inválida.' };
  if (r.tributo === 'ICMS_ST' && r.aliquota_interna_destino === null && !(r.aliquota > 0)) return { ok: false, error: 'ICMS-ST precisa da alíquota interna do destino.' };
  if (r.difal_base && !['unica', 'dupla'].includes(r.difal_base)) return { ok: false, error: 'Base do DIFAL: única ou dupla.' };
  if (r.difal_base && r.tributo !== 'ICMS') return { ok: false, error: 'Base do DIFAL só vale para regra de ICMS.' };
  if (!ehData(r.vigencia_inicio)) return { ok: false, error: 'Informe o início da vigência.' };
  if (r.vigencia_fim && (!ehData(r.vigencia_fim) || r.vigencia_fim < r.vigencia_inicio)) return { ok: false, error: 'Fim da vigência inválido.' };
  return { ok: true, regra: r };
}

function inserir(db, r, extra) {
  const linha = { ...r, ...extra };
  const cols = Object.keys(linha);
  db.prepare(`INSERT INTO tax_rules (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`).run(linha);
  return linha.id;
}

function criar(campos = {}) {
  const v = validar(campos);
  if (!v.ok) return v;
  const id = randomUUID();
  inserir(getDb(), v.regra, { id, grupo_id: id, versao: 1, origem: 'usuario', criado_por: campos.operadorId || null });
  return { ok: true, id };
}

/**
 * Muda uma regra sem apagar o passado: a versão vigente ganha fim no dia
 * anterior ao início da nova. A nova versão é sempre da loja.
 */
function novaVersao({ grupoId, operadorId, ...campos } = {}) {
  const db = getDb();
  const atual = db.prepare('SELECT * FROM tax_rules WHERE grupo_id = ? AND ativo = 1 ORDER BY versao DESC LIMIT 1').get(grupoId);
  if (!atual) return { ok: false, error: 'Regra não encontrada ou desativada.' };
  const v = validar(campos);
  if (!v.ok) return v;
  if (v.regra.tributo !== atual.tributo) return { ok: false, error: 'A nova versão precisa ser do mesmo tributo.' };
  if (v.regra.vigencia_inicio <= atual.vigencia_inicio) return { ok: false, error: `A nova versão precisa começar depois de ${atual.vigencia_inicio.split('-').reverse().join('/')} (início da versão atual).` };
  const id = randomUUID();
  db.transaction(() => {
    const fim = diaAnterior(v.regra.vigencia_inicio);
    if (!atual.vigencia_fim || atual.vigencia_fim > fim) db.prepare('UPDATE tax_rules SET vigencia_fim = ? WHERE id = ?').run(fim, atual.id);
    inserir(db, v.regra, { id, grupo_id: grupoId, versao: atual.versao + 1, origem: 'usuario', criado_por: operadorId || null });
  })();
  return { ok: true, id, versao: atual.versao + 1 };
}

function desativar({ id } = {}) {
  const r = getDb().prepare('UPDATE tax_rules SET ativo = 0 WHERE id = ? AND ativo = 1').run(id);
  return r.changes ? { ok: true } : { ok: false, error: 'Regra não encontrada ou já desativada.' };
}

function listar({ tributo, incluirInativas = false } = {}) {
  const filtros = [];
  const args = [];
  if (tributo) { filtros.push('tributo = ?'); args.push(tributo); }
  if (!incluirInativas) filtros.push('ativo = 1');
  return getDb().prepare(
    `SELECT * FROM tax_rules ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''}
     ORDER BY tributo, nome, grupo_id, versao DESC`
  ).all(...args);
}

// ---------- resolução e cálculo ----------

function bate(regra, ctx) {
  for (const campo of Object.keys(PESOS)) {
    if (regra[campo] !== null && regra[campo] !== ctx[campo]) return false;
  }
  if (regra.ncm_prefixo !== null && !(ctx.ncm || '').startsWith(regra.ncm_prefixo)) return false;
  return true;
}

function especificidade(regra) {
  let s = 0;
  for (const [campo, peso] of Object.entries(PESOS)) if (regra[campo] !== null) s += peso;
  if (regra.ncm_prefixo) s += regra.ncm_prefixo.length * 2;
  return s;
}

function comparar(a, b) {
  return (b.especificidade - a.especificidade)
    || ((a.origem === 'usuario' ? 0 : 1) - (b.origem === 'usuario' ? 0 : 1))
    || (b.vigencia_inicio < a.vigencia_inicio ? -1 : b.vigencia_inicio > a.vigencia_inicio ? 1 : 0)
    || (b.versao - a.versao)
    || (a.id < b.id ? -1 : 1);
}

function normalizarContexto(c = {}) {
  return {
    regime: c.regime || null,
    uf_origem: c.ufOrigem ? String(c.ufOrigem).toUpperCase() : null,
    uf_destino: c.ufDestino ? String(c.ufDestino).toUpperCase() : null,
    ncm: soDigitos(c.ncm) || null,
    cfop: soDigitos(c.cfop) || null,
    cst_csosn_item: soDigitos(c.cstCsosnItem) || null,
    natureza: c.natureza || 'venda',
    perfil_cliente: c.perfilCliente || 'consumidor_final',
    data: c.data || timeService.hojeLocalISO(),
  };
}

/** { [tributo]: { regra, especificidade, empatadas } } para o contexto. */
function regrasVigentes(data) {
  return getDb().prepare(
    `SELECT * FROM tax_rules WHERE ativo = 1 AND vigencia_inicio <= ? AND (vigencia_fim IS NULL OR vigencia_fim >= ?)`
  ).all(data, data);
}

/** `vigentes`: regras já carregadas (para conferir muitos produtos com uma consulta só). */
function resolver(contexto, vigentes = null) {
  const ctx = normalizarContexto(contexto);
  const candidatas = (vigentes || regrasVigentes(ctx.data))
    .filter((r) => bate(r, ctx)).map((r) => ({ ...r, especificidade: especificidade(r) }));
  const porTributo = {};
  for (const r of candidatas) (porTributo[r.tributo] ||= []).push(r);
  const resultado = {};
  for (const [tributo, lista] of Object.entries(porTributo)) {
    lista.sort(comparar);
    const [melhor] = lista;
    const empatadas = lista.filter((r) => r.especificidade === melhor.especificidade && r.origem === melhor.origem).length;
    resultado[tributo] = { regra: melhor, especificidade: melhor.especificidade, empatadas };
  }
  return { contexto: ctx, regras: resultado };
}

/**
 * Calcula os tributos de um item. valor = quantidade × preço − desconto
 * + frete/outras (base da operação). Simples/MEI: valores zerados quando a
 * regra diz recolhido no DAS (o imposto sai na guia, não no item).
 */
function calcularItem({ quantidade = 1, precoUnitario = 0, desconto = 0, outras = 0, ...contexto } = {}) {
  const q = Number(quantidade);
  const p = Number(precoUnitario);
  if (!(q > 0) || !(p >= 0)) return { ok: false, error: 'Quantidade e preço inválidos.' };
  const baseOperacao = arred(q * p - Number(desconto || 0) + Number(outras || 0));
  if (baseOperacao < 0) return { ok: false, error: 'Desconto maior que o valor do item.' };
  const { contexto: ctx, regras } = resolver(contexto);
  const tributos = [];
  const valorDe = (t) => tributos.find((x) => x.tributo === t)?.valor || 0;
  const ordem = ['IPI', 'ICMS', 'FCP', 'ICMS_ST', 'PIS', 'COFINS', 'ISS', 'IBS', 'CBS', 'IS'];
  for (const tributo of ordem) {
    const achado = regras[tributo];
    if (!achado) continue;
    const r = achado.regra;
    let base = baseOperacao;
    let aliquota = r.aliquota;
    if (tributo === 'ICMS_ST') {
      base = (baseOperacao + valorDe('IPI')) * (1 + r.mva / 100);
      aliquota = r.aliquota_interna_destino ?? r.aliquota;
    }
    base = arred(base * (1 - r.reducao_base / 100));
    let valor = arred(base * aliquota / 100);
    if (tributo === 'ICMS_ST') valor = Math.max(0, arred(valor - valorDe('ICMS')));
    if (r.recolhido_no_das) valor = 0;
    tributos.push({
      tributo, cst: r.cst, cclassTrib: r.cclass_trib, base: r.recolhido_no_das ? 0 : base, aliquota: r.recolhido_no_das ? 0 : aliquota, valor,
      recolhidoNoDas: !!r.recolhido_no_das, informativo: !!r.informativo,
      regra: { id: r.id, grupoId: r.grupo_id, nome: r.nome, versao: r.versao, origem: r.origem, fundamento: r.fundamento, especificidade: achado.especificidade },
      avisoEmpate: achado.empatadas > 1 ? `${achado.empatadas} regras empatadas; usada a de vigência mais recente.` : null,
    });
  }
  const esperados = ESPERADOS[ctx.regime] || [];
  const semRegra = esperados.filter((t) => !regras[t] && !((t === 'IBS' || t === 'CBS') && ctx.data < '2026-01-01'));
  const avisos = [];
  if (!ctx.regime) avisos.push('Regime tributário não informado: configure em Configurações → Geral → Fiscal (NFC-e).');
  if (semRegra.length) avisos.push(`Sem regra para ${semRegra.join(', ')} neste contexto: cadastre com o contador.`);
  // DIFAL (EC 87/2015, LC 190/2022): venda interestadual a consumidor final
  // não contribuinte, regime regular. Precisa da regra de ICMS interestadual
  // com a alíquota interna do destino; a base (única ou dupla) é da UF de destino.
  // Simples/MEI fora (cláusula nona do Conv. 93/2015 suspensa, ADI 5464).
  const simples = ctx.regime === 'simples_nacional' || ctx.regime === 'mei';
  if (ctx.uf_origem && ctx.uf_destino && ctx.uf_origem !== ctx.uf_destino && ctx.perfil_cliente !== 'contribuinte' && !simples) {
    const icms = regras.ICMS?.regra;
    const icmsItem = tributos.find((t) => t.tributo === 'ICMS');
    if (icms && icms.aliquota_interna_destino !== null && icmsItem) {
      const v = icmsItem.base;
      const inter = icms.aliquota;
      const dest = icms.aliquota_interna_destino;
      const metodo = icms.difal_base || 'unica';
      let base = v;
      let valor;
      if (metodo === 'dupla') {
        base = arred((v - (v * inter) / 100) / (1 - dest / 100));
        valor = arred((base * dest) / 100 - (v * inter) / 100);
      } else {
        valor = arred((v * (dest - inter)) / 100);
      }
      tributos.push({
        tributo: 'DIFAL', cst: null, cclassTrib: null, base, aliquota: arred(dest - inter), valor: Math.max(0, valor),
        recolhidoNoDas: false, informativo: false,
        regra: { id: icms.id, grupoId: icms.grupo_id, nome: `${icms.nome} (DIFAL, base ${metodo})`, versao: icms.versao, origem: icms.origem, fundamento: 'EC 87/2015 e LC 190/2022: diferença entre a alíquota interna do destino e a interestadual.', especificidade: regras.ICMS.especificidade },
        avisoEmpate: null,
      });
      if (!icms.difal_base) avisos.push('Base do DIFAL não informada na regra: calculado em base única. Confira com o contador se a UF de destino usa base dupla.');
    } else {
      avisos.push('Venda interestadual a não contribuinte: cadastre a regra de ICMS interestadual com a alíquota interna do destino para calcular o DIFAL.');
    }
  }
  const totalDestacado = arred(tributos.filter((t) => !t.informativo && t.tributo !== 'ICMS_ST').reduce((s, t) => s + t.valor, 0));
  return { ok: true, contexto: ctx, baseOperacao, tributos, semRegra, avisos, totalDestacado };
}

function contextoDaLoja() {
  const fc = getDb().prepare("SELECT regime_tributario, uf FROM fiscal_config WHERE id = 'default'").get() || {};
  return { regime: fc.regime_tributario || null, ufOrigem: fc.uf || null };
}

/** Simula um produto do cadastro (NCM, CFOP e CST/CSOSN dele) na loja. */
function simularProduto({ productId, quantidade = 1, precoUnitario, ufDestino, perfilCliente, natureza, data, regime } = {}) {
  const p = getDb().prepare('SELECT id, nome, ncm, cfop, cst_csosn, preco FROM products WHERE id = ?').get(productId);
  if (!p) return { ok: false, error: 'Produto não encontrado.' };
  const loja = contextoDaLoja();
  const r = calcularItem({
    ...loja, regime: regime || loja.regime, ufDestino: ufDestino || loja.ufOrigem, perfilCliente, natureza, data,
    ncm: p.ncm, cfop: p.cfop, cstCsosnItem: p.cst_csosn, quantidade, precoUnitario: precoUnitario ?? p.preco,
  });
  if (!r.ok) return r;
  const divergencias = [];
  const icms = r.tributos.find((t) => t.tributo === 'ICMS');
  if (icms?.cst && p.cst_csosn && soDigitos(p.cst_csosn) !== icms.cst) {
    divergencias.push(`O cadastro do produto tem CST/CSOSN ${p.cst_csosn}, mas a regra "${icms.regra.nome}" indica ${icms.cst}.`);
  }
  return { ...r, produto: { id: p.id, nome: p.nome, ncm: p.ncm, cfop: p.cfop, cstCsosn: p.cst_csosn }, divergencias };
}

/**
 * Cadastro × regras: produtos cujo CST/CSOSN difere do que a regra de ICMS
 * vigente indica para o CFOP/NCM deles (ou está vazio). Com aplicar=true,
 * grava o CST/CSOSN da regra -- só em produto que já tem CFOP (sem CFOP o
 * motor não sabe se há ST; quem completa isso é o assistente fiscal).
 */
function conferirCadastro({ aplicar = false, productIds, operadorId, limite = 500 } = {}) {
  const db = getDb();
  const loja = contextoDaLoja();
  if (!loja.regime) return { ok: false, error: 'Escolha o regime tributário em Configurações → Geral → Fiscal (NFC-e).' };
  const data = timeService.hojeLocalISO();
  const vigentes = regrasVigentes(data);
  const produtos = db.prepare(
    `SELECT id, nome, ncm, cest, cfop, cst_csosn FROM products WHERE ativo = 1 AND COALESCE(tipo, 'produto') = 'produto'
     AND cfop IS NOT NULL AND TRIM(cfop) != '' ORDER BY nome`
  ).all();
  const filtro = Array.isArray(productIds) ? new Set(productIds) : null;
  const divergentes = [];
  for (const p of produtos) {
    if (filtro && !filtro.has(p.id)) continue;
    const { regras } = resolver({ ...loja, ufDestino: loja.ufOrigem, ncm: p.ncm, cfop: p.cfop, cstCsosnItem: p.cst_csosn, data }, vigentes);
    const icms = regras.ICMS?.regra;
    if (!icms?.cst) continue;
    if (soDigitos(p.cst_csosn) === icms.cst) continue;
    // Regra genérica do sistema (ex.: "Simples sem ST = 102") não derruba um
    // CSOSN válido escolhido pela loja (103/300/400 existem). Ela só corrige
    // vazio, inválido ou ST incoerente; regra da loja ou específica do CFOP vale sempre.
    const problemas = assistenteFiscal().problemasDoProduto(p, loja.regime);
    const cadastroRuim = ['sem_csosn', 'csosn_invalido', 'st_inconsistente'].some((c) => problemas.includes(c));
    if (!cadastroRuim && icms.origem !== 'usuario' && icms.cfop === null) continue;
    divergentes.push({
      id: p.id, nome: p.nome, ncm: p.ncm, cfop: p.cfop, atual: p.cst_csosn || null, indicado: icms.cst, regra: icms.nome, versao: icms.versao,
      motivo: cadastroRuim ? 'cadastro vazio ou incoerente' : icms.origem === 'usuario' ? 'regra da loja' : `regra do CFOP ${icms.cfop}`,
    });
  }
  if (!aplicar) return { ok: true, total: divergentes.length, divergentes: divergentes.slice(0, limite) };
  db.transaction(() => {
    const upd = db.prepare('UPDATE products SET cst_csosn = ? WHERE id = ?');
    for (const d of divergentes) upd.run(d.indicado, d.id);
    if (divergentes.length) {
      db.prepare('INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso) VALUES (?, ?, ?, ?, 1)')
        .run(randomUUID(), 'regras_aplicadas_ao_cadastro', operadorId || null, `Motor tributário ajustou o CST/CSOSN de ${divergentes.length} produto(s) conforme as regras vigentes.`);
    }
  })();
  return { ok: true, aplicados: divergentes.length };
}

module.exports = {
  TRIBUTOS, REGIMES, NATUREZAS, PERFIS, UFS,
  validar, criar, novaVersao, desativar, listar, resolver, calcularItem, simularProduto, contextoDaLoja, conferirCadastro,
};
