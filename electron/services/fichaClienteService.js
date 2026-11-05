const { getDb } = require('../db/database');
const timeService = require('./timeService');

/**
 * Ficha do cliente: quem é, o que comprou (cada compra com os itens e as
 * especificações do produto), quanto gastou e -- na ótica -- as receitas.
 * Aberta tocando no nome do cliente (tela de Clientes e filtro de cliente
 * do Histórico), em qualquer perfil.
 *
 * Período: igual ao Histórico (data de FINALIZAÇÃO, dia local), ou tudo
 * quando dataInicio/dataFim não vêm. Só entram vendas finalizadas e que não
 * foram "excluídas do histórico" (teste/engano) -- é o que o cliente
 * consumiu de verdade. Devoluções aparecem na compra e saem do total.
 *
 * Especificações: a cópia guardada no item na hora da venda
 * (sale_items.especificacoes_json, migração 6). Item de antes disso usa o
 * cadastro ATUAL do produto e volta marcado (`especificacoesDoCadastroAtual`)
 * para a tela avisar.
 */

const LIMITE_VENDAS = 500;
const METODOS = {
  dinheiro: 'Dinheiro', cartao_credito: 'Cartão crédito', cartao_debito: 'Cartão débito',
  pix: 'Pix', fiado: 'Fiado', outro: 'Outro',
};

function lerJson(texto) {
  if (!texto) return null;
  try {
    const v = JSON.parse(texto);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function arred2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

/** campo -> { label, tipo } de todos os perfis; o perfil ativo tem prioridade
 * (o mesmo campo pode ter rótulos diferentes em perfis diferentes). */
function rotulosDosCampos(db, perfilAtivoId) {
  const mapa = new Map();
  const perfis = db.prepare('SELECT id, campos_extras_json FROM custom_profiles').all()
    .sort((a, b) => (a.id === perfilAtivoId) - (b.id === perfilAtivoId)); // ativo por último = vence
  for (const p of perfis) {
    let campos = [];
    try { campos = JSON.parse(p.campos_extras_json || '[]'); } catch { campos = []; }
    for (const c of Array.isArray(campos) ? campos : []) {
      if (c?.campo && c?.label) mapa.set(c.campo, { label: c.label, tipo: c.tipo || 'texto' });
    }
  }
  return mapa;
}

function rotuloDeChave(chave) {
  const t = String(chave).replace(/[_-]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : chave;
}

/** { chave: valor } -> [{ campo, label, tipo, valor }], sem vazios nem valores que não são texto/número/sim-não. */
function listarEspecificacoes(objeto, rotulos) {
  if (!objeto) return [];
  const lista = [];
  for (const [campo, valor] of Object.entries(objeto)) {
    if (valor == null || valor === '' || typeof valor === 'object') continue;
    const def = rotulos.get(campo);
    const tipo = def?.tipo || (typeof valor === 'boolean' ? 'boolean' : 'texto');
    // Sim/não desmarcado não é especificação ("Controlado: não" em todo item polui a ficha).
    if (tipo === 'boolean' && !valor) continue;
    lista.push({ campo, label: def?.label || rotuloDeChave(campo), tipo, valor });
  }
  return lista;
}

function rotuloDasMesas(mesas) {
  const ordenadas = [...mesas].sort((a, b) => (b.principal - a.principal)
    || (Number(a.numero) - Number(b.numero)) || String(a.numero).localeCompare(String(b.numero)));
  return ordenadas.map((m, i) => m.nome || (i === 0 ? `Mesa ${m.numero}` : m.numero)).join(' + ');
}

const FMT_DIA = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });

/** 'AAAA-MM-DD HH:MM:SS' em UTC (como o banco grava) -> dia em São Paulo 'AAAA-MM-DD'. */
function diaLocalDoUtc(utc) {
  const d = new Date(`${String(utc).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : FMT_DIA.format(d);
}

/** Soma meses a 'AAAA-MM-DD' sem pular mês (31/01 + 1 mês = 28 ou 29/02). */
function somarMeses(diaIso, meses) {
  const [a, m, d] = diaIso.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + meses, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimoDia));
  return alvo.toISOString().slice(0, 10);
}

function soDigitos(t) {
  return String(t || '').replace(/\D/g, '');
}

/** Mesmo critério de customerService.buscarPorTelefone: só dígitos, tolera DDI. */
function mesmoTelefone(a, b) {
  const x = soDigitos(a);
  const y = soDigitos(b);
  if (x.length < 8 || y.length < 8) return false;
  return x === y || x.endsWith(y) || y.endsWith(x);
}

// Campos de produto que dizem o que o cliente costuma levar (loja de roupas:
// tamanho e cor; petshop: espécie do animal da ração/petisco).
const CAMPOS_PREFERENCIA = ['tamanho', 'cor', 'especie_animal'];

function emLotes(ids, tamanho = 400) {
  const lotes = [];
  for (let i = 0; i < ids.length; i += tamanho) lotes.push(ids.slice(i, i + tamanho));
  return lotes;
}

function getFicha({ customerId, dataInicio = null, dataFim = null } = {}) {
  const db = getDb();
  const cliente = customerId ? db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) : null;
  if (!cliente) return { ok: false, error: 'Cliente não encontrado.' };
  const comPeriodo = !!(dataInicio && dataFim);
  if (comPeriodo && dataInicio > dataFim) return { ok: false, error: 'A data inicial é depois da final.' };

  const perfil = require('./profileService').getActiveProfile();
  const rotulos = rotulosDosCampos(db, perfil?.id);

  const filtros = ['s.customer_id = ?', "s.status = 'finalizada'", 's.oculta_historico = 0'];
  const params = [customerId];
  if (comPeriodo) {
    const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(dataInicio, dataFim);
    filtros.push('s.finalizada_em >= ? AND s.finalizada_em < ?');
    params.push(inicioUtc, fimUtcExclusivo);
  }
  const linhas = db.prepare(
    `SELECT s.id, s.finalizada_em, s.total, s.desconto, s.desconto_gerente, s.taxa_servico_percentual,
            u.nome AS operador_nome, l.nome AS local_nome
     FROM sales s
     LEFT JOIN users u ON u.id = s.operador_id
     LEFT JOIN locations l ON l.id = s.location_id
     WHERE ${filtros.join(' AND ')}
     ORDER BY s.finalizada_em DESC
     LIMIT ${LIMITE_VENDAS + 1}`
  ).all(...params);
  const truncado = linhas.length > LIMITE_VENDAS;
  const vendasRows = truncado ? linhas.slice(0, LIMITE_VENDAS) : linhas;
  const ids = vendasRows.map((v) => v.id);

  const itensPorVenda = new Map();
  const pagamentosPorVenda = new Map();
  const mesasPorVenda = new Map();
  const pessoasPorVenda = new Map();
  const devolucoesPorVenda = new Map();
  const anexosPorVenda = new Map();
  for (const lote of emLotes(ids)) {
    const ph = lote.map(() => '?').join(',');
    for (const i of db.prepare(
      `SELECT si.id, si.sale_id, si.quantidade, si.preco_unitario, si.observacao, si.pessoa_numero,
              si.nome_personalizado, si.eh_personalizado, si.especificacoes_json, si.product_id,
              p.nome, p.categoria, p.unidade, p.sku, p.codigo_barras, p.custom_fields, p.tipo AS produto_tipo
       FROM sale_items si JOIN products p ON p.id = si.product_id
       WHERE si.sale_id IN (${ph}) AND si.cancelado = 0
       ORDER BY si.criado_em, si.rowid`
    ).all(...lote)) {
      if (!itensPorVenda.has(i.sale_id)) itensPorVenda.set(i.sale_id, []);
      itensPorVenda.get(i.sale_id).push(i);
    }
    for (const p of db.prepare(`SELECT sale_id, metodo, valor FROM payments WHERE sale_id IN (${ph})`).all(...lote)) {
      if (!pagamentosPorVenda.has(p.sale_id)) pagamentosPorVenda.set(p.sale_id, new Map());
      const m = pagamentosPorVenda.get(p.sale_id);
      m.set(p.metodo, (m.get(p.metodo) || 0) + p.valor);
    }
    for (const a of db.prepare(`SELECT sale_id, COUNT(*) AS n FROM sale_attachments WHERE sale_id IN (${ph}) GROUP BY sale_id`).all(...lote)) {
      anexosPorVenda.set(a.sale_id, a.n);
    }
    for (const m of db.prepare(`SELECT sale_id, numero, nome, principal FROM sale_mesas WHERE sale_id IN (${ph})`).all(...lote)) {
      if (!mesasPorVenda.has(m.sale_id)) mesasPorVenda.set(m.sale_id, []);
      mesasPorVenda.get(m.sale_id).push(m);
    }
    for (const p of db.prepare(`SELECT sale_id, numero, nome FROM sale_people WHERE sale_id IN (${ph})`).all(...lote)) {
      if (!pessoasPorVenda.has(p.sale_id)) pessoasPorVenda.set(p.sale_id, new Map());
      pessoasPorVenda.get(p.sale_id).set(p.numero, p.nome);
    }
    for (const d of db.prepare(
      `SELECT r.id AS return_id, r.sale_id, r.criado_em, r.valor_devolvido, ri.product_id, ri.quantidade
       FROM returns r LEFT JOIN return_items ri ON ri.return_id = r.id
       WHERE r.sale_id IN (${ph})`
    ).all(...lote)) {
      if (!devolucoesPorVenda.has(d.sale_id)) devolucoesPorVenda.set(d.sale_id, { valores: new Map(), porProduto: new Map(), ultimaEm: null });
      const dev = devolucoesPorVenda.get(d.sale_id);
      // valor_devolvido é por devolução (repete em cada item dela): soma uma vez por devolução.
      dev.valores.set(d.return_id, d.valor_devolvido || 0);
      if (d.product_id) dev.porProduto.set(d.product_id, (dev.porProduto.get(d.product_id) || 0) + (d.quantidade || 0));
      if (!dev.ultimaEm || d.criado_em > dev.ultimaEm) dev.ultimaEm = d.criado_em;
    }
  }

  const hoje = timeService.hojeLocalISO();
  const contagemProdutos = new Map();
  const preferencias = new Map(); // campo -> { label, valores: Map(valor -> vezes) }
  const vendas = vendasRows.map((v) => {
    const diaDaVenda = diaLocalDoUtc(v.finalizada_em);
    const pessoas = pessoasPorVenda.get(v.id) || new Map();
    const dev = devolucoesPorVenda.get(v.id) || null;
    const devolvidoPorProduto = new Map(dev ? dev.porProduto : []);
    const itens = (itensPorVenda.get(v.id) || []).map((i) => {
      const guardadas = lerJson(i.especificacoes_json);
      const doCadastroAtual = i.especificacoes_json == null;
      const especificacoes = listarEspecificacoes(doCadastroAtual ? lerJson(i.custom_fields) : guardadas, rotulos);
      // Devolução é por produto: distribui a quantidade devolvida pelas linhas dele, em ordem.
      const restanteDevolver = devolvidoPorProduto.get(i.product_id) || 0;
      const devolvida = Math.min(restanteDevolver, i.quantidade);
      if (devolvida > 0) devolvidoPorProduto.set(i.product_id, restanteDevolver - devolvida);
      const nome = i.eh_personalizado && i.nome_personalizado ? i.nome_personalizado : i.nome;
      const chave = i.eh_personalizado ? `pers:${nome}` : i.product_id;
      const acumulado = contagemProdutos.get(chave) || { nome, quantidade: 0, valor: 0, unidade: i.unidade || 'un', vezes: 0 };
      acumulado.quantidade += i.quantidade - devolvida;
      acumulado.valor += (i.quantidade - devolvida) * i.preco_unitario;
      acumulado.vezes += 1;
      contagemProdutos.set(chave, acumulado);
      for (const e of especificacoes) {
        if (!CAMPOS_PREFERENCIA.includes(e.campo) || typeof e.valor !== 'string') continue;
        const valor = e.valor.trim();
        if (!valor) continue;
        if (!preferencias.has(e.campo)) preferencias.set(e.campo, { campo: e.campo, label: e.label, valores: new Map() });
        const chaveValor = valor.toLocaleUpperCase('pt-BR');
        const atual = preferencias.get(e.campo).valores.get(chaveValor) || { valor, vezes: 0 };
        atual.vezes += 1;
        preferencias.get(e.campo).valores.set(chaveValor, atual);
      }
      // Garantia (material de construção e qualquer perfil com "garantia_meses"): conta do dia da compra.
      const meses = Number(especificacoes.find((e) => e.campo === 'garantia_meses')?.valor);
      const garantiaAte = diaDaVenda && Number.isFinite(meses) && meses > 0 ? somarMeses(diaDaVenda, Math.round(meses)) : null;
      return {
        id: i.id,
        nome,
        servico: i.produto_tipo === 'servico',
        garantiaAte,
        garantiaVigente: garantiaAte ? garantiaAte >= hoje : null,
        categoria: i.categoria || null,
        codigo: i.codigo_barras || i.sku || null,
        unidade: i.unidade || 'un',
        quantidade: i.quantidade,
        quantidadeDevolvida: devolvida,
        precoUnitario: i.preco_unitario,
        total: arred2(i.quantidade * i.preco_unitario),
        observacao: i.observacao || null,
        pessoa: i.pessoa_numero ? (pessoas.get(i.pessoa_numero) || `Pessoa ${i.pessoa_numero}`) : null,
        especificacoes,
        especificacoesDoCadastroAtual: doCadastroAtual && especificacoes.length > 0,
      };
    });
    const valorDevolvido = dev ? arred2([...dev.valores.values()].reduce((s, x) => s + x, 0)) : 0;
    const pagamentos = [...(pagamentosPorVenda.get(v.id) || new Map()).entries()]
      .map(([metodo, valor]) => ({ metodo, rotulo: METODOS[metodo] || metodo, valor: arred2(valor) }));
    return {
      id: v.id,
      finalizadaEm: v.finalizada_em,
      total: arred2(v.total),
      desconto: arred2((v.desconto || 0) + (v.desconto_gerente || 0)),
      taxaServicoPercentual: v.taxa_servico_percentual || 0,
      valorDevolvido,
      operador: v.operador_nome || null,
      local: v.local_nome || null,
      mesa: mesasPorVenda.has(v.id) ? rotuloDasMesas(mesasPorVenda.get(v.id)) : null,
      anexos: anexosPorVenda.get(v.id) || 0,
      pagamentos,
      itens,
    };
  });

  const totalGasto = arred2(vendas.reduce((s, v) => s + v.total, 0));
  const totalDevolvido = arred2(vendas.reduce((s, v) => s + v.valorDevolvido, 0));
  const liquido = arred2(totalGasto - totalDevolvido);
  const maisComprados = [...contagemProdutos.values()]
    .filter((p) => p.quantidade > 0)
    .sort((a, b) => b.quantidade - a.quantidade || b.valor - a.valor)
    .slice(0, 5)
    .map((p) => ({ ...p, valor: arred2(p.valor) }));

  // Primeira e última compra de TODO o histórico (não só do período): é o que se quer saber do cliente.
  const extremos = db.prepare(
    `SELECT MIN(finalizada_em) AS primeira, MAX(finalizada_em) AS ultima, COUNT(*) AS total
     FROM sales WHERE customer_id = ? AND status = 'finalizada' AND oculta_historico = 0`
  ).get(customerId);

  const extras = montarExtras(db, { cliente, comPeriodo, dataInicio, dataFim, hoje });

  const receitas = db.prepare(
    `SELECT * FROM eyewear_prescriptions WHERE customer_id = ? AND ativo = 1 ORDER BY data_receita DESC, criado_em DESC`
  ).all(customerId);

  return {
    ok: true,
    perfil: perfil ? { id: perfil.id, nome: perfil.nome } : null,
    periodo: comPeriodo ? { dataInicio, dataFim } : null,
    cliente: {
      id: cliente.id,
      nome: cliente.nome,
      telefone: cliente.telefone || null,
      cpf: cliente.cpf || null,
      cnpj: cliente.cnpj || null,
      dataNascimento: cliente.data_nascimento || null,
      pontos: cliente.pontos || 0,
      ativo: cliente.ativo !== 0,
      clienteDesde: cliente.criado_em,
      saldoFiado: arred2(require('./customerService').getSaldoFiado(cliente.id)),
      primeiraCompra: extremos.primeira || null,
      ultimaCompra: extremos.ultima || null,
      comprasNoTotal: extremos.total || 0,
    },
    resumo: {
      compras: vendas.length,
      totalGasto,
      totalDevolvido,
      liquido,
      ticketMedio: vendas.length ? arred2(liquido / vendas.length) : 0,
      itens: vendas.reduce((s, v) => s + v.itens.reduce((t, i) => t + (i.quantidade - i.quantidadeDevolvida), 0), 0),
      maisComprados,
    },
    truncado,
    limite: LIMITE_VENDAS,
    vendas,
    preferencias: [...preferencias.values()].map((p) => ({
      campo: p.campo,
      label: p.label,
      valores: [...p.valores.values()].sort((a, b) => b.vezes - a.vezes || a.valor.localeCompare(b.valor, 'pt-BR')),
    })),
    ...extras,
    receitas: receitas.map((r) => ({
      id: r.id,
      dataReceita: r.data_receita || null,
      od: { esferico: r.od_esferico, cilindrico: r.od_cilindrico, eixo: r.od_eixo, adicao: r.od_adicao },
      oe: { esferico: r.oe_esferico, cilindrico: r.oe_cilindrico, eixo: r.oe_eixo, adicao: r.oe_adicao },
      distanciaPupilar: r.distancia_pupilar,
      tipoLente: r.tipo_lente || null,
      observacoes: r.observacoes || null,
      criadoEm: r.criado_em,
    })),
  };
}

/**
 * O resto da vida do cliente na loja, além das compras -- cada bloco só
 * volta com dado quando existe (a tela mostra o que tiver; o perfil ativo
 * decide o que aparece mesmo vazio). O período vale para o que tem data de
 * acontecimento (agendamento, orçamento, entrega, fiado, reserva); pets e
 * próximos agendamentos são o estado de agora.
 */
function montarExtras(db, { cliente, comPeriodo, dataInicio, dataFim, hoje }) {
  const limitesUtc = comPeriodo ? timeService.localDateRangeToUtcBounds(dataInicio, dataFim) : null;
  const noPeriodoUtc = (col) => (limitesUtc ? ` AND ${col} >= ? AND ${col} < ?` : '');
  const paramsUtc = limitesUtc ? [limitesUtc.inicioUtc, limitesUtc.fimUtcExclusivo] : [];
  // Datas LOCAIS (agenda e reserva gravam a hora de Brasília, não UTC).
  const noPeriodoLocal = (col) => (comPeriodo ? ` AND substr(${col}, 1, 10) >= ? AND substr(${col}, 1, 10) <= ?` : '');
  const paramsLocal = comPeriodo ? [dataInicio, dataFim] : [];
  const agoraLocal = timeService.agoraLocalString();

  // Petshop: os animais do cliente, com vacina e vermífugo.
  const situacao = (proxima) => {
    if (!proxima) return null;
    if (proxima < hoje) return 'atrasada';
    // Mesma antecedência dos "Lembretes de vacina/vermífugo" (petService.listLembretesPendentes).
    if (proxima <= timeService.diasAPartirDeHojeLocalISO(7)) return 'proxima';
    return 'em_dia';
  };
  const pets = db.prepare('SELECT * FROM pets WHERE customer_id = ? AND ativo = 1 ORDER BY nome').all(cliente.id).map((p) => ({
    id: p.id, nome: p.nome, especie: p.especie || null, raca: p.raca || null, observacoes: p.observacoes || null,
    ultimaVacina: p.ultima_vacina_em || null, proximaVacina: p.proxima_vacina_em || null, situacaoVacina: situacao(p.proxima_vacina_em),
    ultimoVermifugo: p.ultimo_vermifugo_em || null, proximoVermifugo: p.proximo_vermifugo_em || null, situacaoVermifugo: situacao(p.proximo_vermifugo_em),
  }));

  // Salão: agenda do cliente (próximos sempre; o resto, no período).
  const agendamento = (a) => ({
    id: a.id, servico: a.servico, inicio: a.data_hora_inicio, duracaoMinutos: a.duracao_minutos,
    status: a.status, profissional: a.profissional || null, observacoes: a.observacoes || null,
  });
  const selectAgenda = `SELECT a.*, pr.nome AS profissional FROM appointments a
     LEFT JOIN appointment_professionals pr ON pr.id = a.professional_id WHERE a.customer_id = ?`;
  const proximosAgendamentos = db.prepare(
    `${selectAgenda} AND a.status IN ('agendado', 'confirmado') AND a.data_hora_inicio >= ? ORDER BY a.data_hora_inicio LIMIT 10`
  ).all(cliente.id, agoraLocal).map(agendamento);
  const agendamentos = db.prepare(
    `${selectAgenda} AND a.data_hora_inicio < ?${noPeriodoLocal('a.data_hora_inicio')} ORDER BY a.data_hora_inicio DESC LIMIT 200`
  ).all(cliente.id, agoraLocal, ...paramsLocal).map(agendamento);
  const contarAgenda = (status) => agendamentos.filter((a) => a.status === status).length;

  // Orçamentos (qualquer perfil; material de construção usa muito).
  const orcamentos = db.prepare(
    `SELECT q.*, (SELECT COALESCE(SUM(qi.quantidade * qi.preco_unitario), 0) FROM quote_items qi WHERE qi.quote_id = q.id) AS total,
            (SELECT COUNT(*) FROM quote_items qi WHERE qi.quote_id = q.id) AS itens
     FROM quotes q WHERE q.customer_id = ?${noPeriodoUtc('q.criado_em')} ORDER BY q.criado_em DESC LIMIT 100`
  ).all(cliente.id, ...paramsUtc).map((q) => ({
    id: q.id, criadoEm: q.criado_em, status: q.status, total: arred2(q.total), itens: q.itens,
    validadeAte: q.validade_ate || null, vencido: q.status === 'aberto' && !!q.validade_ate && q.validade_ate < hoje,
    observacoes: q.observacoes || null,
  }));

  // Entregas (delivery).
  const entregas = db.prepare(
    `SELECT * FROM deliveries WHERE customer_id = ?${noPeriodoUtc('criado_em')} ORDER BY criado_em DESC LIMIT 100`
  ).all(cliente.id, ...paramsUtc).map((d) => ({
    id: d.id, criadoEm: d.criado_em, status: d.status, endereco: d.endereco || null, taxa: arred2(d.taxa_entrega),
    entregueEm: d.entregue_em || null, observacoes: d.observacoes || null,
  }));
  // Endereços usados, o mais recente primeiro; o mesmo endereço escrito de outro jeito (caixa, espaço) conta uma vez.
  const enderecosVistos = new Map();
  for (const e of entregas) {
    const texto = e.endereco?.trim();
    const chave = texto?.toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ');
    if (chave && !enderecosVistos.has(chave)) enderecosVistos.set(chave, texto);
  }
  const enderecos = [...enderecosVistos.values()];

  // Fiado: movimentos do período (o saldo de hoje já vem no cliente).
  const fiado = db.prepare(
    `SELECT * FROM customer_credit_movements WHERE customer_id = ?${noPeriodoUtc('criado_em')} ORDER BY criado_em DESC LIMIT 200`
  ).all(cliente.id, ...paramsUtc).map((m) => ({
    id: m.id, criadoEm: m.criado_em, tipo: m.tipo, valor: arred2(m.valor), motivo: m.motivo || null, saleId: m.sale_id || null,
  }));

  // Restaurante/padaria: reservas feitas com o telefone do cliente (a reserva não tem cadastro, só nome e telefone).
  let reservas = [];
  if (soDigitos(cliente.telefone).length >= 8) {
    const fim8 = soDigitos(cliente.telefone).slice(-8);
    reservas = db.prepare(
      `SELECT * FROM reservations WHERE cliente_telefone LIKE ?${noPeriodoLocal('data_hora')} ORDER BY data_hora DESC LIMIT 200`
    ).all(`%${fim8.slice(0, 4)}%${fim8.slice(4)}%`, ...paramsLocal)
      .filter((r) => mesmoTelefone(r.cliente_telefone, cliente.telefone))
      .map((r) => ({ id: r.id, dataHora: r.data_hora, pessoas: r.pessoas, status: r.status, observacoes: r.observacoes || null }));
  }

  return {
    pets,
    agenda: {
      proximos: proximosAgendamentos,
      historico: agendamentos,
      concluidos: contarAgenda('concluido'),
      faltas: contarAgenda('faltou'),
      cancelados: contarAgenda('cancelado'),
    },
    orcamentos,
    entregas: { lista: entregas, enderecos },
    fiado,
    reservas,
  };
}

module.exports = { getFicha, listarEspecificacoes, somarMeses, LIMITE_VENDAS };
