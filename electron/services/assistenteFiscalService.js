const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const timeService = require('./timeService');
const tabelas = require('./tabelasFiscais');

/**
 * Assistente fiscal (ERP, Fase 4) -- facilitadores, não apuração:
 *  - saúde fiscal do cadastro de produtos, com correção em massa
 *    (NCM/CEST que vieram nas notas de compra; CFOP/CSOSN pela regra de
 *    ST do Simples quando o fornecedor vendeu com ST);
 *  - painel de limites (MEI e Simples), RBT12, alíquota efetiva e DAS
 *    estimados;
 *  - calendário de obrigações;
 *  - relatório mensal de receitas brutas do MEI;
 *  - pacote do contador (ZIP do mês).
 * Tudo é apoio ao contador e diz isso na tela; nada aqui transmite nada
 * para a Receita/SEFAZ.
 */

const { arred } = tabelas;

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBR = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');
const soDigitos = (v) => String(v || '').replace(/\D/g, '');

function financeiro() { return require('./financeiroService'); }

function fiscalConfig(db) {
  return db.prepare('SELECT * FROM fiscal_config WHERE id = ?').get('default') || {};
}

// ---------- receita, RBT12, imposto estimado ----------

/** Primeiro mês com venda finalizada registrada no sistema (AAAA-MM). */
function primeiroMesComVenda(db, locationId) {
  const r = db.prepare(`SELECT MIN(finalizada_em) AS m FROM sales WHERE location_id = ? AND status = 'finalizada'`).get(locationId);
  return r?.m ? financeiro().dataLocalDeUtc(r.m).slice(0, 7) : null;
}

/**
 * Receita bruta dos 12 meses anteriores à competência (base da alíquota do
 * Simples). Empresa com menos de 12 meses de atividade (data de abertura
 * informada): média dos meses × 12, e no 1º mês a receita do próprio mês
 * × 12 (LC 123, art. 18, §2º). Meses antes de a loja usar o sistema:
 * completa com o faturamento anterior informado em Configurações, se houver.
 */
function rbt12({ locationId, competencia }) {
  const db = getDb();
  const fin = financeiro();
  const config = fin.getConfig();
  const meses = fin.competenciasEntre(fin.somarMeses(competencia, -12), fin.somarMeses(competencia, -1));
  const abertura = config.data_abertura_empresa ? config.data_abertura_empresa.slice(0, 7) : null;
  const primeiroComVenda = primeiroMesComVenda(db, locationId);
  const receitas = meses.map((m) => ({ competencia: m, valor: fin.receitaLiquidaDoMes(db, locationId, m) }));

  if (abertura && abertura >= meses[0]) {
    const ativos = receitas.filter((r) => r.competencia >= abertura);
    if (ativos.length === 0) {
      const doMes = fin.receitaLiquidaDoMes(db, locationId, competencia);
      return { valor: arred(doMes * 12), base: 'primeiro_mes', meses: 0, estimado: true };
    }
    const media = ativos.reduce((s, r) => s + r.valor, 0) / ativos.length;
    return { valor: arred(media * 12), base: 'proporcional', meses: ativos.length, estimado: true };
  }
  let soma = 0;
  let completados = 0;
  const porMesAnterior = config.rbt12_anterior ? Number(config.rbt12_anterior) / 12 : null;
  for (const r of receitas) {
    if (porMesAnterior !== null && (!primeiroComVenda || r.competencia < primeiroComVenda)) {
      soma += porMesAnterior; completados += 1;
    } else soma += r.valor;
  }
  const semHistorico = !primeiroComVenda || primeiroComVenda > meses[0];
  return {
    valor: arred(soma), base: 'doze_meses', meses: 12, mesesCompletados: completados,
    estimado: semHistorico && porMesAnterior === null,
  };
}

function valorDasMei(ano, config) {
  if (config.das_mei_valor) return { valor: arred(config.das_mei_valor), estimado: false, informado: true };
  const d = tabelas.dasMei(ano, config.atividade_mei || 'comercio');
  return { valor: d.valor, estimado: d.estimado, informado: false };
}

/** Imposto do mês para o DRE: DAS-MEI fixo, ou receita × alíquota efetiva
 * do Anexo I (comércio). Estimativa: não considera ST/monofásico
 * segregados nem outros anexos -- o valor real vem do PGDAS do contador. */
function impostoEstimadoDoMes({ locationId, competencia, receitaDoMes, regime }) {
  const config = financeiro().getConfig();
  if (regime === 'mei') {
    const das = valorDasMei(Number(competencia.slice(0, 4)), config);
    return { valor: das.valor, origem: 'das_mei', estimado: das.estimado };
  }
  const base = rbt12({ locationId, competencia });
  const aliq = tabelas.aliquotaEfetivaAnexoI(base.valor);
  return { valor: arred(Math.max(0, receitaDoMes) * aliq.efetiva), origem: 'simples_anexo_i', aliquota: aliq, rbt12: base };
}

// ---------- painel de limites ----------

function painel({ locationId, ano }) {
  const db = getDb();
  const fin = financeiro();
  const hoje = timeService.hojeLocalISO();
  const anoRef = Number(ano) || Number(hoje.slice(0, 4));
  const config = fin.getConfig();
  const regime = fiscalConfig(db).regime_tributario || null;
  const mesAtual = hoje.slice(0, 7);

  const meses = fin.competenciasEntre(`${anoRef}-01`, `${anoRef}-12`).map((c) => ({
    competencia: c, receita: c <= mesAtual ? fin.receitaLiquidaDoMes(db, locationId, c) : null,
  }));
  const acumulado = arred(meses.reduce((s, m) => s + (m.receita || 0), 0));
  const mesesPassados = meses.filter((m) => m.receita !== null).length;
  const projecaoAno = anoRef === Number(hoje.slice(0, 4)) && mesesPassados > 0
    ? arred((acumulado / mesesPassados) * 12) : acumulado;

  const avisos = [];
  let limite = null;
  if (regime === 'mei') {
    const lim = tabelas.limiteMei(anoRef, config.data_abertura_empresa);
    const usado = lim.limite > 0 ? arred((acumulado / lim.limite) * 100, 1) : null;
    limite = { tipo: 'mei', ...lim, usadoPercentual: usado, restante: arred(lim.limite - acumulado), projecaoAno };
    if (acumulado > lim.comTolerancia) avisos.push({ nivel: 'critico', texto: `Faturamento passou de ${brl(lim.comTolerancia)} (limite + 20%): o desenquadramento do MEI retroage a janeiro. Procure o contador agora.` });
    else if (acumulado > lim.limite) avisos.push({ nivel: 'critico', texto: `Faturamento passou do limite do MEI (${brl(lim.limite)}). Até ${brl(lim.comTolerancia)} paga-se DAS complementar e vira ME em janeiro. Fale com o contador.` });
    else if (usado >= 80) avisos.push({ nivel: 'aviso', texto: `Já foram ${usado}% do limite do MEI. No ritmo atual o ano fecha em ${brl(projecaoAno)}.` });
    else if (projecaoAno > lim.limite) avisos.push({ nivel: 'aviso', texto: `No ritmo atual o ano fecha em ${brl(projecaoAno)}, acima do limite do MEI (${brl(lim.limite)}).` });
    if (!config.data_abertura_empresa) avisos.push({ nivel: 'info', texto: 'Informe a data de abertura do CNPJ: no ano da abertura o limite do MEI é proporcional aos meses.' });
  } else if (regime === 'simples_nacional') {
    const usado = arred((acumulado / tabelas.LIMITE_SIMPLES) * 100, 1);
    limite = { tipo: 'simples', limite: tabelas.LIMITE_SIMPLES, sublimite: tabelas.SUBLIMITE_ICMS, usadoPercentual: usado, restante: arred(tabelas.LIMITE_SIMPLES - acumulado), projecaoAno };
    if (projecaoAno > tabelas.SUBLIMITE_ICMS) avisos.push({ nivel: 'aviso', texto: `No ritmo atual o ano fecha em ${brl(projecaoAno)}, acima do sublimite de ${brl(tabelas.SUBLIMITE_ICMS)}: o ICMS passa a ser recolhido fora do DAS.` });
  } else {
    avisos.push({ nivel: 'info', texto: 'Escolha o regime tributário em Configurações → Geral → Fiscal (NFC-e) para ver limites e o imposto estimado.' });
  }

  let imposto = null;
  if (regime === 'mei') {
    const das = valorDasMei(anoRef, config);
    imposto = { tipo: 'das_mei', valorMensal: das.valor, estimado: das.estimado, informado: das.informado, atividade: config.atividade_mei };
  } else if (regime === 'simples_nacional') {
    const base = rbt12({ locationId, competencia: mesAtual });
    const aliq = tabelas.aliquotaEfetivaAnexoI(base.valor);
    const receitaMes = fin.receitaLiquidaDoMes(db, locationId, mesAtual);
    imposto = { tipo: 'simples', competencia: mesAtual, rbt12: base, ...aliq, receitaMes, dasEstimado: arred(receitaMes * aliq.efetiva) };
    if (base.estimado) avisos.push({ nivel: 'info', texto: 'O RBT12 está incompleto (o sistema tem menos de 12 meses de vendas). Informe o faturamento anterior ou a data de abertura em Fiscal → Ajustes.' });
  }

  return { ok: true, regime, ano: anoRef, meses, acumulado, projecaoAno, limite, imposto, avisos, calendario: calendario({ hoje, regime }) };
}

// ---------- calendário de obrigações ----------

const DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** Próximas obrigações (60 dias). Data cheia de fim de semana vem marcada:
 * o dia útil certo de vencimento o contador confirma. */
function calendario({ hoje = timeService.hojeLocalISO(), regime, dias = 60 } = {}) {
  const fin = financeiro();
  const config = fin.getConfig();
  const ate = fin.somarDias(hoje, dias);
  const itens = [];
  const add = (data, titulo, detalhe) => {
    if (data < hoje || data > ate) return;
    const dow = new Date(`${data}T12:00:00Z`).getUTCDay();
    itens.push({ data, titulo, detalhe, diaSemana: DIAS_SEMANA[dow], fimDeSemana: dow === 0 || dow === 6 });
  };
  const mesHoje = hoje.slice(0, 7);
  for (let i = 0; i <= 2; i += 1) {
    const mes = fin.somarMeses(mesHoje, i);
    const anterior = fin.somarMeses(mes, -1).split('-').reverse().join('/');
    if (regime === 'mei') {
      add(`${mes}-20`, 'DAS-MEI', `Pagamento do DAS da competência ${anterior}.`);
      add(`${mes}-20`, 'Relatório mensal de receitas (MEI)', `Preencher e guardar o relatório de ${anterior} com as notas do mês.`);
    } else if (regime === 'simples_nacional') {
      add(`${mes}-20`, 'PGDAS-D e DAS (Simples)', `Apuração e pagamento da competência ${anterior}.`);
    }
    const dia = String(config.dia_pacote_contador || 5).padStart(2, '0');
    add(`${mes}-${dia}`, 'Pacote do contador', `Enviar vendas, compras e XMLs de ${anterior} (Fiscal → Pacote do contador).`);
  }
  for (const ano of [Number(hoje.slice(0, 4)), Number(hoje.slice(0, 4)) + 1]) {
    if (regime === 'mei') add(`${ano}-05-31`, 'DASN-SIMEI', `Declaração anual do MEI referente a ${ano - 1}.`);
    if (regime === 'simples_nacional') add(`${ano}-03-31`, 'DEFIS', `Declaração anual do Simples referente a ${ano - 1}.`);
  }
  return itens.sort((a, b) => a.data.localeCompare(b.data) || a.titulo.localeCompare(b.titulo));
}

// ---------- saúde fiscal do cadastro ----------

const PROBLEMAS = {
  sem_ncm: 'Sem NCM',
  ncm_invalido: 'NCM inválido (precisa ter 8 dígitos)',
  sem_cfop: 'Sem CFOP',
  cfop_invalido: 'CFOP de venda inválido para NFC-e (precisa começar com 5)',
  sem_csosn: 'Sem CSOSN/CST',
  csosn_invalido: 'CSOSN/CST inválido para o regime',
  st_inconsistente: 'CFOP e CSOSN não combinam (5405 anda com CSOSN 500)',
  cest_invalido: 'CEST inválido (precisa ter 7 dígitos)',
  cest_faltando: 'Mercadoria com ST sem CEST',
};

const ncmValido = (v) => /^\d{8}$/.test(v || '') && v !== '00000000';
const cestValido = (v) => /^\d{7}$/.test(v || '');

function problemasDoProduto(p, regime) {
  const lista = [];
  const ncm = soDigitos(p.ncm);
  const cfop = soDigitos(p.cfop);
  const cst = soDigitos(p.cst_csosn);
  const cest = soDigitos(p.cest);
  const simples = regime === 'simples_nacional' || regime === 'mei';
  if (!ncm) lista.push('sem_ncm'); else if (!ncmValido(ncm)) lista.push('ncm_invalido');
  if (!cfop) lista.push('sem_cfop'); else if (!/^5\d{3}$/.test(cfop)) lista.push('cfop_invalido');
  if (!cst) lista.push('sem_csosn');
  else if (simples && !tabelas.CSOSN_VALIDOS.has(cst)) lista.push('csosn_invalido');
  else if (regime && !simples && !tabelas.CST_ICMS_VALIDOS.has(cst.slice(-2))) lista.push('csosn_invalido');
  if (cest && !cestValido(cest)) lista.push('cest_invalido');
  const comSt = simples ? (cfop === '5405' || cst === '500') : ['10', '30', '60', '70'].includes(cst.slice(-2));
  if (simples && cfop && cst && ((cfop === '5405') !== (cst === '500'))) lista.push('st_inconsistente');
  if (comSt && !cest) lista.push('cest_faltando');
  return lista;
}

/**
 * O que a própria loja já usa para um NCM: a combinação CFOP + CST/CSOSN
 * (+ CEST) mais comum entre os produtos ativos com esse NCM e cadastro
 * fiscal sem problema. Produto do mesmo NCM costuma ter o mesmo tratamento
 * na mesma loja; por isso vale como sugestão (nunca troca valor válido).
 */
function fiscalDaLoja(db, ncm, regime, excluirId = null) {
  const n = soDigitos(ncm);
  if (!ncmValido(n)) return null;
  const linhas = db.prepare(
    `SELECT id, ncm, cest, cfop, cst_csosn FROM products
     WHERE ativo = 1 AND ncm = ? AND id != COALESCE(?, '') AND cfop IS NOT NULL AND cst_csosn IS NOT NULL`
  ).all(n, excluirId);
  const contagem = new Map();
  for (const p of linhas) {
    if (problemasDoProduto(p, regime).length) continue;
    const chave = `${soDigitos(p.cfop)}|${soDigitos(p.cst_csosn)}|${soDigitos(p.cest)}`;
    contagem.set(chave, (contagem.get(chave) || 0) + 1);
  }
  if (contagem.size === 0) return null;
  const [chave, qtd] = [...contagem.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  const [cfop, cst, cest] = chave.split('|');
  return { cfop, cst_csosn: cst, cest: cest || null, produtos: qtd, total: [...contagem.values()].reduce((x, y) => x + y, 0) };
}

/**
 * Sugestão a partir da ÚLTIMA nota de compra confirmada do produto: NCM e
 * CEST do fornecedor; e, para Simples/MEI, se o fornecedor vendeu com ST
 * (CFOP 5401/5403/5405/6401/6403/6404), revenda com CFOP 5405 + CSOSN 500,
 * senão 5102 + 102. Sem nota: só o padrão 5102/102 (marcado como padrão).
 */
function sugestaoDoProduto(db, p, regime) {
  const nota = db.prepare(
    `SELECT i.ncm, i.cest, i.cfop, e.numero, e.emitente_nome FROM nfe_entrada_itens i JOIN nfe_entradas e ON e.id = i.entrada_id
     WHERE i.product_id = ? AND e.status = 'confirmada' ORDER BY e.confirmada_em DESC, i.n_item LIMIT 1`
  ).get(p.id);
  const simples = regime === 'simples_nacional' || regime === 'mei';
  const s = { fonte: null };
  if (nota) {
    s.fonte = `NF-e ${nota.numero} de ${nota.emitente_nome}`;
    if (ncmValido(nota.ncm)) s.ncm = nota.ncm;
    if (cestValido(nota.cest)) s.cest = nota.cest;
    if (simples && nota.cfop) {
      const st = tabelas.CFOP_COMPRA_COM_ST.has(nota.cfop);
      s.cfop = st ? '5405' : '5102';
      s.cst_csosn = st ? '500' : '102';
      s.st = st;
    }
  }
  // Sem a nota dizer o CFOP: o que a loja já usa para o mesmo NCM -- mas
  // só se o produto não tem CFOP válido ou já usa o MESMO CFOP da loja
  // (CFOP válido diferente é escolha de alguém; a maioria não passa por cima).
  const cfopAtual = soDigitos(p.cfop);
  if (!s.cfop && simples && cfopAtual === '5405') {
    s.fonte = s.fonte ? `${s.fonte} + CFOP 5405 do cadastro` : 'CFOP 5405 do cadastro (ST)';
    s.cfop = '5405';
    s.cst_csosn = '500';
    s.st = true;
  }
  if (!s.cfop) {
    const lojaBruta = fiscalDaLoja(db, s.ncm || p.ncm, regime, p.id);
    const loja = lojaBruta && (!/^5\d{3}$/.test(cfopAtual) || lojaBruta.cfop === cfopAtual) ? lojaBruta : null;
    if (loja) {
      s.fonte = s.fonte ? `${s.fonte} + ${loja.produtos} produto(s) com o mesmo NCM` : `${loja.produtos} produto(s) com o mesmo NCM`;
      s.cfop = loja.cfop;
      s.cst_csosn = loja.cst_csosn;
      if (!s.cest && loja.cest) s.cest = loja.cest;
      s.st = simples ? loja.cfop === '5405' : ['10', '30', '60', '70'].includes(loja.cst_csosn.slice(-2));
    }
  }
  if (!s.fonte && simples) {
    s.fonte = 'padrao';
    s.cfop = '5102';
    s.cst_csosn = '102';
    s.st = false;
  }
  return s;
}

function diagnosticoCadastro({ limite = 500 } = {}) {
  const db = getDb();
  const regime = fiscalConfig(db).regime_tributario || null;
  const produtos = db.prepare(
    `SELECT id, nome, codigo_barras, ncm, cest, cfop, cst_csosn, origem_mercadoria FROM products
     WHERE ativo = 1 AND COALESCE(tipo, 'produto') = 'produto' ORDER BY nome`
  ).all();
  const contagem = {};
  const comProblema = [];
  for (const p of produtos) {
    const problemas = problemasDoProduto(p, regime);
    if (problemas.length === 0) continue;
    problemas.forEach((c) => { contagem[c] = (contagem[c] || 0) + 1; });
    comProblema.push({ ...p, problemas, sugestao: sugestaoDoProduto(db, p, regime) });
  }
  const daNota = comProblema.filter((p) => p.sugestao.fonte && p.sugestao.fonte !== 'padrao').length;
  return {
    ok: true, regime, totalProdutos: produtos.length, comProblema: comProblema.length,
    problemas: Object.entries(contagem).map(([codigo, qtd]) => ({ codigo, descricao: PROBLEMAS[codigo], qtd })).sort((a, b) => b.qtd - a.qtd),
    sugestoesDeNota: daNota,
    produtos: comProblema.slice(0, limite),
  };
}

/**
 * Aplica as sugestões: preenche campo VAZIO ou INVÁLIDO; nunca troca um
 * valor válido. `incluirPadrao` libera o 5102/102 para quem não tem nota.
 */
function aplicarSugestoes({ productIds, incluirPadrao = false, operadorId }) {
  const db = getDb();
  const regime = fiscalConfig(db).regime_tributario || null;
  const ids = Array.isArray(productIds) ? productIds.slice(0, 5000) : null;
  const alvo = ids
    ? ids.map((id) => db.prepare('SELECT * FROM products WHERE id = ? AND ativo = 1').get(id)).filter(Boolean)
    : db.prepare(`SELECT * FROM products WHERE ativo = 1 AND COALESCE(tipo, 'produto') = 'produto'`).all();
  let alterados = 0;
  const campos = { ncm: 0, cest: 0, cfop: 0, cst_csosn: 0 };
  db.transaction(() => {
    for (const p of alvo) {
      const s = sugestaoDoProduto(db, p, regime);
      if (!s.fonte || (s.fonte === 'padrao' && !incluirPadrao)) continue;
      const problemas = problemasDoProduto(p, regime);
      const novo = {};
      if (s.ncm && (problemas.includes('sem_ncm') || problemas.includes('ncm_invalido'))) novo.ncm = s.ncm;
      if (s.cest && (!soDigitos(p.cest) || problemas.includes('cest_invalido'))) novo.cest = s.cest;
      const fiscalRuim = ['sem_cfop', 'cfop_invalido', 'sem_csosn', 'csosn_invalido', 'st_inconsistente'].some((c) => problemas.includes(c));
      if (s.cfop && fiscalRuim) { novo.cfop = s.cfop; novo.cst_csosn = s.cst_csosn; }
      const chaves = Object.keys(novo);
      if (chaves.length === 0) continue;
      db.prepare(`UPDATE products SET ${chaves.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...chaves.map((c) => novo[c]), p.id);
      chaves.forEach((c) => { campos[c] += 1; });
      alterados += 1;
    }
    if (alterados > 0) {
      db.prepare('INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso) VALUES (?, ?, ?, ?, 1)')
        .run(randomUUID(), 'fiscal_cadastro_corrigido', operadorId || null,
          `Assistente fiscal corrigiu ${alterados} produto(s): NCM ${campos.ncm}, CEST ${campos.cest}, CFOP/CSOSN ${campos.cfop}${incluirPadrao ? ' (com padrão 5102/102)' : ''}.`);
    }
  })();
  return { ok: true, alterados, campos };
}

// ---------- relatório mensal do MEI ----------

/**
 * Receitas brutas do mês no formato do relatório mensal do MEI: revenda
 * de mercadorias e serviços, com e sem documento fiscal (NFC-e
 * autorizada). Desconto da venda é rateado pelos itens; devolução do mês
 * sai do grupo da venda original.
 */
function relatorioMei({ locationId, competencia }) {
  if (!/^\d{4}-\d{2}$/.test(competencia || '')) return { ok: false, error: 'Mês inválido.' };
  const db = getDb();
  const fin = financeiro();
  const de = `${competencia}-01`;
  const ate = `${competencia}-${String(fin.ultimoDiaDoMes(competencia)).padStart(2, '0')}`;
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(de, ate);

  const partesDaVenda = db.prepare(
    `SELECT s.id, (s.total - s.desconto - s.desconto_gerente) * (1 + s.taxa_servico_percentual / 100.0) AS liquido,
       COALESCE(SUM(CASE WHEN COALESCE(p.tipo, 'produto') = 'servico' THEN si.quantidade * si.preco_unitario END), 0) AS servicos,
       COALESCE(SUM(si.quantidade * si.preco_unitario), 0) AS bruto,
       EXISTS (SELECT 1 FROM nfce_emitidas n WHERE n.sale_id = s.id AND n.status = 'autorizada') AS com_nf
     FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id AND si.cancelado = 0
     LEFT JOIN products p ON p.id = si.product_id
     WHERE s.id = ? GROUP BY s.id`
  );
  const t = { comercioSemNf: 0, comercioComNf: 0, servicoSemNf: 0, servicoComNf: 0 };
  const somar = (venda, sinal, valor) => {
    const fracServ = venda.bruto > 0 ? venda.servicos / venda.bruto : 0;
    const chave = venda.com_nf ? 'ComNf' : 'SemNf';
    t[`servico${chave}`] += sinal * valor * fracServ;
    t[`comercio${chave}`] += sinal * valor * (1 - fracServ);
  };
  const vendas = db.prepare(
    `SELECT id FROM sales WHERE location_id = ? AND status = 'finalizada' AND finalizada_em >= ? AND finalizada_em < ?`
  ).all(locationId, inicioUtc, fimUtcExclusivo);
  for (const { id } of vendas) { const v = partesDaVenda.get(id); somar(v, 1, v.liquido); }
  const devolucoes = db.prepare(
    `SELECT sale_id, valor_devolvido FROM returns WHERE location_id = ? AND criado_em >= ? AND criado_em < ? AND valor_devolvido > 0`
  ).all(locationId, inicioUtc, fimUtcExclusivo);
  for (const d of devolucoes) { const v = partesDaVenda.get(d.sale_id); if (v) somar(v, -1, d.valor_devolvido); }

  for (const k of Object.keys(t)) t[k] = arred(t[k]);
  const linhas = {
    I: t.comercioSemNf, II: t.comercioComNf, III: arred(t.comercioSemNf + t.comercioComNf),
    IV: 0, V: 0, VI: 0,
    VII: t.servicoSemNf, VIII: t.servicoComNf, IX: arred(t.servicoSemNf + t.servicoComNf),
  };
  linhas.X = arred(linhas.III + linhas.VI + linhas.IX);
  const fc = fiscalConfig(db);
  return {
    ok: true, competencia, linhas, vendas: vendas.length, devolucoes: devolucoes.length,
    empresa: { cnpj: fc.cnpj || '', nome: fc.razao_social || fc.nome_fantasia || '' },
  };
}

function htmlRelatorioMei(rel) {
  const [ano, mes] = rel.competencia.split('-');
  const linha = (rom, texto, valor, forte) => `<tr${forte ? ' class="total"' : ''}><td class="rom">${rom}</td><td>${escapeHtml(texto)}</td><td class="v">${escapeHtml(brl(valor))}</td></tr>`;
  const ultimo = financeiro().ultimoDiaDoMes(rel.competencia);
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório mensal das receitas brutas — ${escapeHtml(`${mes}/${ano}`)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:32px;font-size:13px}h1{font-size:17px;margin:0 0 4px}h2{font-size:13px;margin:18px 0 6px;text-transform:uppercase}
table{width:100%;border-collapse:collapse}td{border:1px solid #999;padding:6px 8px}td.rom{width:44px;text-align:center}td.v{width:150px;text-align:right}tr.total td{font-weight:bold;background:#f2f2f2}
.cab td{border:none;padding:2px 0}.assin{margin-top:48px;display:flex;justify-content:space-between;gap:24px}.assin div{flex:1;border-top:1px solid #333;padding-top:4px;text-align:center}.nota{color:#555;font-size:11px;margin-top:22px}</style></head><body>
<h1>RELATÓRIO MENSAL DAS RECEITAS BRUTAS</h1>
<table class="cab"><tr><td><strong>CNPJ:</strong> ${escapeHtml(rel.empresa.cnpj)}</td></tr><tr><td><strong>Empreendedor individual:</strong> ${escapeHtml(rel.empresa.nome)}</td></tr>
<tr><td><strong>Período de apuração:</strong> 01/${escapeHtml(mes)}/${escapeHtml(ano)} a ${escapeHtml(String(ultimo))}/${escapeHtml(mes)}/${escapeHtml(ano)}</td></tr></table>
<h2>Receita bruta mensal — revenda de mercadorias (comércio)</h2><table>
${linha('I', 'Revenda de mercadorias com dispensa de emissão de documento fiscal', rel.linhas.I)}
${linha('II', 'Revenda de mercadorias com documento fiscal emitido', rel.linhas.II)}
${linha('III', 'Total das receitas com revenda de mercadorias (I + II)', rel.linhas.III, true)}</table>
<h2>Receita bruta mensal — venda de produtos industrializados (indústria)</h2><table>
${linha('IV', 'Venda de produtos industrializados com dispensa de emissão de documento fiscal', 0)}
${linha('V', 'Venda de produtos industrializados com documento fiscal emitido', 0)}
${linha('VI', 'Total das receitas com venda de produtos industrializados (IV + V)', 0, true)}</table>
<h2>Receita bruta mensal — prestação de serviços</h2><table>
${linha('VII', 'Receita com prestação de serviços com dispensa de emissão de documento fiscal', rel.linhas.VII)}
${linha('VIII', 'Receita com prestação de serviços com documento fiscal emitido', rel.linhas.VIII)}
${linha('IX', 'Total das receitas com prestação de serviços (VII + VIII)', rel.linhas.IX, true)}</table>
<table style="margin-top:12px">${linha('X', 'Total geral das receitas brutas no mês (III + VI + IX)', rel.linhas.X, true)}</table>
<div class="assin"><div>Local e data</div><div>Assinatura do empresário</div></div>
<p class="nota">Encontram-se anexados a este relatório: os documentos fiscais comprobatórios das entradas de mercadorias e serviços tomados referentes ao período; as notas fiscais relativas às operações ou prestações realizadas eventualmente emitidas.<br>
Gerado pelo GerenciaAI a partir de ${escapeHtml(String(rel.vendas))} venda(s) registradas; "com documento fiscal" = venda com NFC-e autorizada. Confira antes de assinar.</p>
</body></html>`;
}

// ---------- pacote do contador ----------

async function pacoteContador({ locationId, competencia }) {
  if (!/^\d{4}-\d{2}$/.test(competencia || '')) return { ok: false, error: 'Mês inválido.' };
  const ExcelJS = require('exceljs');
  const JSZip = require('jszip');
  const db = getDb();
  const fin = financeiro();
  const de = `${competencia}-01`;
  const ate = `${competencia}-${String(fin.ultimoDiaDoMes(competencia)).padStart(2, '0')}`;
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(de, ate);
  const fc = fiscalConfig(db);
  const regime = fc.regime_tributario || null;
  const zip = new JSZip();
  const avisos = [];
  const localBR = (utc) => (utc ? new Date(`${utc.replace(' ', 'T')}Z`).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '');

  const planilha = (wb, nome, colunas, linhas) => {
    const ws = wb.addWorksheet(nome);
    ws.columns = colunas.map(([header, key, width, numFmt]) => ({ header, key, width: width || 16, style: numFmt ? { numFmt } : {} }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    linhas.forEach((l) => ws.addRow(l));
    return ws;
  };
  const MOEDA = '"R$" #,##0.00';

  // --- vendas ---
  const vendas = db.prepare(
    `SELECT s.id, s.finalizada_em, s.total, s.desconto + s.desconto_gerente AS descontos,
       (s.total - s.desconto - s.desconto_gerente) * (1 + s.taxa_servico_percentual / 100.0) AS liquido,
       (SELECT group_concat(metodo || ':' || printf('%.2f', valor), ' | ') FROM payments WHERE sale_id = s.id) AS formas,
       (SELECT n.numero FROM nfce_emitidas n WHERE n.sale_id = s.id ORDER BY n.criado_em DESC LIMIT 1) AS nfce_numero,
       (SELECT n.chave_acesso FROM nfce_emitidas n WHERE n.sale_id = s.id ORDER BY n.criado_em DESC LIMIT 1) AS nfce_chave,
       (SELECT n.status FROM nfce_emitidas n WHERE n.sale_id = s.id ORDER BY n.criado_em DESC LIMIT 1) AS nfce_status
     FROM sales s WHERE s.location_id = ? AND s.status = 'finalizada' AND s.finalizada_em >= ? AND s.finalizada_em < ?
     ORDER BY s.finalizada_em`
  ).all(locationId, inicioUtc, fimUtcExclusivo);
  const porForma = db.prepare(
    `SELECT p.metodo, COUNT(DISTINCT p.sale_id) AS vendas, SUM(p.valor) AS total FROM payments p JOIN sales s ON s.id = p.sale_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND s.finalizada_em >= ? AND s.finalizada_em < ? GROUP BY p.metodo ORDER BY total DESC`
  ).all(locationId, inicioUtc, fimUtcExclusivo);
  const porTributacao = db.prepare(
    `SELECT COALESCE(p.cfop, '') AS cfop, COALESCE(p.cst_csosn, '') AS cst_csosn, COALESCE(p.ncm, '') AS ncm,
       SUM(si.quantidade) AS quantidade, SUM(si.quantidade * si.preco_unitario) AS valor
     FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND si.cancelado = 0 AND s.finalizada_em >= ? AND s.finalizada_em < ?
     GROUP BY 1, 2, 3 ORDER BY valor DESC`
  ).all(locationId, inicioUtc, fimUtcExclusivo);
  const receita = fin.dre({ locationId, competencias: [competencia] }).meses[0];

  const wbV = new ExcelJS.Workbook();
  planilha(wbV, 'Resumo', [['Item', 'item', 44], ['Valor', 'valor', 18, MOEDA]], [
    { item: 'Vendas (bruto)', valor: receita.receitaBruta },
    { item: 'Descontos', valor: receita.descontos },
    { item: 'Devoluções', valor: receita.devolucoes },
    { item: 'Receita líquida', valor: receita.receitaLiquida },
    ...porForma.map((f) => ({ item: `Recebido em ${f.metodo} (${f.vendas} venda(s))`, valor: f.total })),
  ]);
  planilha(wbV, 'Vendas', [['Data e hora', 'data', 20], ['Venda', 'venda', 12], ['Bruto', 'total', 14, MOEDA], ['Descontos', 'descontos', 14, MOEDA],
    ['Líquido', 'liquido', 14, MOEDA], ['Formas', 'formas', 40], ['NFC-e nº', 'nfce_numero', 10], ['Situação NFC-e', 'nfce_status', 14], ['Chave NFC-e', 'nfce_chave', 48]],
  vendas.map((v) => ({ ...v, data: localBR(v.finalizada_em), venda: v.id.slice(0, 8) })));
  planilha(wbV, 'Por tributação', [['CFOP', 'cfop', 8], ['CSOSN/CST', 'cst_csosn', 11], ['NCM', 'ncm', 12], ['Quantidade', 'quantidade', 12], ['Valor dos itens', 'valor', 16, MOEDA]], porTributacao);
  zip.file(`vendas-${competencia}.xlsx`, await wbV.xlsx.writeBuffer());

  // --- compras ---
  const compras = db.prepare(
    `SELECT e.id, e.chave, e.numero, e.serie, e.emissao, e.emitente_nome, e.emitente_cnpj, e.valor_total, e.xml FROM nfe_entradas e
     WHERE e.location_id = ? AND e.status = 'confirmada' AND e.confirmada_em >= ? AND e.confirmada_em < ? ORDER BY e.confirmada_em`
  ).all(locationId, inicioUtc, fimUtcExclusivo);
  const wbC = new ExcelJS.Workbook();
  planilha(wbC, 'Notas de compra', [['Emissão', 'emissao', 12], ['Número', 'numero', 10], ['Série', 'serie', 6], ['Fornecedor', 'emitente_nome', 36],
    ['CNPJ', 'emitente_cnpj', 18], ['Valor', 'valor_total', 14, MOEDA], ['Chave', 'chave', 48]], compras.map((c) => ({ ...c, emissao: dataBR(c.emissao) })));
  const itensCompra = compras.length ? db.prepare(
    `SELECT e.numero, i.descricao, i.ncm, i.cfop, i.quantidade_nota, i.unidade_nota, i.valor_produto, i.valor_icms_st, i.valor_ipi
     FROM nfe_entrada_itens i JOIN nfe_entradas e ON e.id = i.entrada_id WHERE e.id IN (${compras.map(() => '?').join(',')}) ORDER BY e.numero, i.n_item`
  ).all(...compras.map((c) => c.id)) : [];
  planilha(wbC, 'Itens', [['NF-e', 'numero', 10], ['Descrição', 'descricao', 40], ['NCM', 'ncm', 12], ['CFOP', 'cfop', 8], ['Qtd', 'quantidade_nota', 10],
    ['Un', 'unidade_nota', 6], ['Valor', 'valor_produto', 14, MOEDA], ['ICMS-ST', 'valor_icms_st', 12, MOEDA], ['IPI', 'valor_ipi', 12, MOEDA]], itensCompra);
  zip.file(`compras-${competencia}.xlsx`, await wbC.xlsx.writeBuffer());
  for (const c of compras) zip.file(`xml/compras/${c.chave}.xml`, c.xml);

  // --- financeiro ---
  const pagas = db.prepare(
    `SELECT e.data_pagamento, e.data_vencimento, e.categoria, e.descricao, e.valor, s.nome AS fornecedor FROM expenses e
     LEFT JOIN suppliers s ON s.id = e.fornecedor_id WHERE e.location_id = ? AND e.data_pagamento >= ? AND e.data_pagamento < ? ORDER BY e.data_pagamento`
  ).all(locationId, inicioUtc, fimUtcExclusivo);
  const abertas = db.prepare(
    `SELECT e.data_vencimento, e.categoria, e.descricao, e.valor, s.nome AS fornecedor FROM expenses e LEFT JOIN suppliers s ON s.id = e.fornecedor_id
     WHERE e.location_id = ? AND e.data_pagamento IS NULL ORDER BY e.data_vencimento`
  ).all(locationId);
  const wbF = new ExcelJS.Workbook();
  planilha(wbF, 'Contas pagas no mês', [['Pago em', 'pago', 12], ['Vencimento', 'venc', 12], ['Categoria', 'categoria', 16], ['Descrição', 'descricao', 44],
    ['Fornecedor', 'fornecedor', 26], ['Valor', 'valor', 14, MOEDA]], pagas.map((p) => ({ ...p, pago: dataBR(fin.dataLocalDeUtc(p.data_pagamento)), venc: dataBR(p.data_vencimento) })));
  planilha(wbF, 'Contas em aberto', [['Vencimento', 'venc', 12], ['Categoria', 'categoria', 16], ['Descrição', 'descricao', 44], ['Fornecedor', 'fornecedor', 26],
    ['Valor', 'valor', 14, MOEDA]], abertas.map((p) => ({ ...p, venc: dataBR(p.data_vencimento) })));
  zip.file(`financeiro-${competencia}.xlsx`, await wbF.xlsx.writeBuffer());

  // --- XML das NFC-e (arquivos gravados pela emissão) ---
  const nfces = db.prepare(
    `SELECT n.chave_acesso, n.xml_path, n.status FROM nfce_emitidas n JOIN sales s ON s.id = n.sale_id
     WHERE s.location_id = ? AND n.status IN ('autorizada', 'cancelada') AND n.criado_em >= ? AND n.criado_em < ?`
  ).all(locationId, inicioUtc, fimUtcExclusivo);
  let xmlsNfce = 0;
  let faltando = 0;
  for (const n of nfces) {
    const caminho = n.xml_path && path.extname(n.xml_path).toLowerCase() === '.xml' ? n.xml_path : null;
    if (caminho && fs.existsSync(caminho)) {
      zip.file(`xml/nfce/${n.status === 'cancelada' ? 'canceladas/' : ''}${n.chave_acesso || path.basename(caminho, '.xml')}.xml`, fs.readFileSync(caminho));
      xmlsNfce += 1;
    } else faltando += 1;
  }
  if (faltando) avisos.push(`${faltando} NFC-e sem o arquivo XML no computador (não entraram no pacote).`);

  let relatorio = null;
  if (regime === 'mei') {
    relatorio = relatorioMei({ locationId, competencia });
    zip.file(`relatorio-mensal-receitas-mei-${competencia}.html`, htmlRelatorioMei(relatorio));
  }

  const [ano, mes] = competencia.split('-');
  const leiaMe = [
    `PACOTE DO CONTADOR — ${mes}/${ano}`,
    `Empresa: ${fc.razao_social || fc.nome_fantasia || '(configure em Configurações → Geral → Fiscal (NFC-e))'}${fc.cnpj ? ` — CNPJ ${fc.cnpj}` : ''}`,
    `Regime: ${regime || 'não informado'}`,
    `Gerado em: ${timeService.agoraLocalString()} pelo GerenciaAI`,
    '',
    `Vendas: ${vendas.length} — receita líquida R$ ${receita.receitaLiquida.toFixed(2)}`,
    `Notas de compra lançadas: ${compras.length} (XMLs em xml/compras)`,
    `NFC-e no período: ${nfces.length} (${xmlsNfce} XML em xml/nfce)`,
    `Contas pagas no mês: ${pagas.length}`,
    relatorio ? `Relatório mensal do MEI: total R$ ${relatorio.linhas.X.toFixed(2)} (abrir o .html e imprimir para assinar)` : null,
    '',
    'A aba "Por tributação" de vendas usa o CFOP/CSOSN/NCM ATUAL de cada produto.',
    ...avisos.map((a) => `ATENÇÃO: ${a}`),
  ].filter((l) => l !== null).join('\r\n');
  zip.file('LEIA-ME.txt', leiaMe);

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    ok: true, buffer, nomeSugerido: `contador-${competencia}.zip`,
    resumo: { vendas: vendas.length, compras: compras.length, nfce: nfces.length, xmlsNfce, contasPagas: pagas.length, relatorioMei: !!relatorio }, avisos,
  };
}

module.exports = {
  rbt12, impostoEstimadoDoMes, painel, calendario, diagnosticoCadastro, aplicarSugestoes, problemasDoProduto, fiscalDaLoja,
  relatorioMei, htmlRelatorioMei, pacoteContador, PROBLEMAS, escapeHtml,
};
