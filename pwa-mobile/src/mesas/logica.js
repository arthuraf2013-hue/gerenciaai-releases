// Regras de tela do painel de mesas, sem React nem Firestore -- testadas em
// tests/logica.test.js. Quem decide de verdade (preço, quem pode, conta) é
// sempre o computador da loja (electron/services/mesaCelularService.js);
// aqui só se monta o que mostrar.

export const STATUS_PREPARO = {
  pendente: { rotulo: 'aguardando', tom: 'neutro' },
  preparando: { rotulo: 'preparando', tom: 'aviso' },
  pronto: { rotulo: 'pronto', tom: 'ok' },
};

export const METODOS = {
  dinheiro: 'Dinheiro',
  cartao_credito: 'Crédito',
  cartao_debito: 'Débito',
  pix: 'Pix',
};

export const PAPEIS_ORGANIZAR = ['operador', 'gerente', 'admin', 'suporte'];

const moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export function formatarMoeda(v) {
  return moeda.format(Number(v) || 0);
}

export const centavos = (v) => Math.round((Number(v) || 0) * 100);
export const reais = (c) => Math.round(c) / 100;

export function unidadeFracionada(unidade) {
  return ['kg', 'g', 'l', 'ml', 'm'].includes(unidade);
}

export function formatarQuantidade(q, unidade = 'un') {
  const n = Number(q) || 0;
  if (unidadeFracionada(unidade)) {
    return `${n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 3 })} ${unidade}`;
  }
  return `${Number.isInteger(n) ? n : n.toLocaleString('pt-BR', { maximumFractionDigits: 3 })}×`;
}

/** "Mesa 4" ou o nome que a loja deu. */
export function rotuloMesa(m) {
  if (!m) return 'Mesa';
  return m.nome || `Mesa ${m.numero}`;
}

/** "Mesa 4 + 5" quando há mesas unidas a ela. */
export function rotuloMesaComUnidas(m) {
  const base = rotuloMesa(m);
  const unidas = (m?.unidas || []).map((u) => (typeof u === 'string' ? u : u.numero));
  return unidas.length ? `${base} + ${unidas.join(' + ')}` : base;
}

export function rotuloPessoa(pessoas, numero) {
  if (numero == null) return 'Mesa';
  const p = (pessoas || []).find((x) => x.numero === numero);
  return p?.nome || `Pessoa ${numero}`;
}

/** Datas do computador vêm em UTC sem fuso ("AAAA-MM-DD HH:MM:SS"). */
export function paraData(valor) {
  if (!valor) return null;
  if (typeof valor?.toDate === 'function') return valor.toDate();
  const texto = String(valor);
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(texto) ? texto : `${texto.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "42 min", "1h10" -- desde quando a mesa abriu. */
export function tempoDesde(valor, agoraMs = Date.now()) {
  const d = paraData(valor);
  if (!d) return '';
  const min = Math.max(0, Math.floor((agoraMs - d.getTime()) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const resto = min % 60;
  return resto ? `${h}h${String(resto).padStart(2, '0')}` : `${h}h`;
}

/** Filtro da tela de mesas. Mesa unida a outra aparece junto da principal. */
export function filtrarMesas(mesas, filtro, meuUsuarioId) {
  const lista = Array.isArray(mesas) ? mesas : [];
  if (filtro === 'livres') return lista.filter((m) => m.status === 'livre');
  if (filtro === 'minhas') return lista.filter((m) => m.status === 'ocupada' && !m.unidaA && m.abertaPorId && m.abertaPorId === meuUsuarioId);
  return lista;
}

export function contarPorStatus(mesas) {
  const c = { livre: 0, ocupada: 0, aguardando_limpeza: 0, reservada: 0 };
  for (const m of mesas || []) if (c[m.status] != null && !m.unidaA) c[m.status] += 1;
  return c;
}

/**
 * Comanda agrupada por pessoa, com os itens que ESTE celular mandou e que
 * ainda não chegaram (na fila sem internet, ou enviando) já no lugar certo.
 * Cada grupo: { pessoaNumero (null = mesa), rotulo, itens, subtotal }.
 * Pessoas sem item também aparecem (para dar para lançar para elas).
 */
export function agruparComanda(comanda, pendentes = []) {
  const pessoas = comanda?.pessoas || [];
  const grupos = new Map();
  const grupo = (numero) => {
    const chave = numero ?? 'mesa';
    if (!grupos.has(chave)) grupos.set(chave, { pessoaNumero: numero ?? null, rotulo: rotuloPessoa(pessoas, numero ?? null), itens: [], subtotal: 0 });
    return grupos.get(chave);
  };
  for (const p of pessoas) grupo(p.numero);
  for (const i of comanda?.itens || []) {
    const g = grupo(i.pessoaNumero ?? null);
    g.itens.push({ ...i, situacao: i.preparo || 'pendente' });
    g.subtotal += centavos(i.total ?? i.precoUnitario * i.quantidade);
  }
  for (const env of pendentes) {
    for (const i of env.itens || []) {
      const numero = i.pessoaNumero ?? null;
      const g = grupo(numero);
      g.itens.push({
        id: `${env.id}:${g.itens.length}`, nome: i.nome, quantidade: i.quantidade, unidade: i.unidade || 'un',
        precoUnitario: i.preco, total: reais(centavos(i.preco * i.quantidade)), observacao: i.observacao || null,
        pessoaNumero: numero, situacao: env.situacao, provisorio: true,
      });
      g.subtotal += centavos(i.preco * i.quantidade);
    }
  }
  const ordem = [...grupos.values()].sort((a, b) => {
    if (a.pessoaNumero == null) return 1;
    if (b.pessoaNumero == null) return -1;
    return a.pessoaNumero - b.pessoaNumero;
  });
  return ordem
    .filter((g) => g.pessoaNumero != null || g.itens.length > 0)
    .map((g) => ({ ...g, subtotal: reais(g.subtotal) }));
}

/** Itens do carrinho de lançamento agrupados por quem vai receber. */
export function resumoCarrinho(carrinho) {
  let qtd = 0;
  let total = 0;
  for (const l of carrinho) {
    qtd += unidadeFracionada(l.unidade) ? 1 : l.quantidade;
    total += centavos(l.preco * l.quantidade);
  }
  return { linhas: carrinho.length, quantidade: qtd, total: reais(total) };
}

/** Acrescenta um produto ao carrinho para a pessoa. Mesma pessoa, mesmo
 * produto e sem observação: soma na linha. */
export function somarNoCarrinho(carrinho, produto, pessoaNumero, quantidade = 1) {
  const idx = carrinho.findIndex((l) => l.produtoId === produto.id && l.pessoaNumero === pessoaNumero && !l.observacao);
  if (idx >= 0) {
    return carrinho.map((l, i) => (i === idx ? { ...l, quantidade: Math.round((l.quantidade + quantidade) * 1000) / 1000 } : l));
  }
  return [...carrinho, {
    chave: `${produto.id}:${pessoaNumero ?? 'mesa'}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
    produtoId: produto.id, nome: produto.nome, preco: Number(produto.preco) || 0, unidade: produto.unidade || 'un',
    pessoaNumero, quantidade, observacao: '',
  }];
}

export function quantidadeNoCarrinho(carrinho, produtoId) {
  return carrinho.filter((l) => l.produtoId === produtoId).reduce((s, l) => s + l.quantidade, 0);
}

/** Payload de `lancar` para o computador. */
export function itensParaLancar(carrinho) {
  return carrinho.map((l) => ({
    produtoId: l.produtoId,
    nome: l.nome,
    quantidade: l.quantidade,
    pessoaNumero: l.pessoaNumero ?? null,
    observacao: l.observacao?.trim() ? l.observacao.trim().slice(0, 200) : null,
  }));
}

/** Busca simples, sem acento e sem diferença de maiúscula. */
export function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function filtrarCatalogo(produtos, { busca = '', categoria = 'todas' } = {}) {
  const termo = normalizar(busca);
  return (produtos || []).filter((p) => {
    if (categoria !== 'todas' && (p.categoria || 'Outros') !== categoria) return false;
    if (!termo) return true;
    return normalizar(p.nome).includes(termo) || (p.codigoBarras && String(p.codigoBarras).includes(termo));
  });
}

export function categoriasDo(produtos) {
  return [...new Set((produtos || []).map((p) => p.categoria || 'Outros'))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

/** Valor a receber de uma seleção de grupos (ou da conta toda). */
export function valorDaSelecao(conta, selecionados, tudo) {
  if (!conta) return 0;
  if (tudo) return conta.restante;
  const devedores = (conta.grupos || []).filter((g) => g.devido > 0);
  const escolhidos = devedores.filter((g) => selecionados.includes(g.grupo));
  if (escolhidos.length > 0 && escolhidos.length === devedores.length) return conta.restante;
  return reais(escolhidos.reduce((s, g) => s + centavos(g.devido), 0));
}

/**
 * Pagamentos que fecham `valorC` centavos: só dinheiro pode passar do que
 * falta (vira troco). Devolve { faltaC, trocoC, linhas } com o valor que
 * cada linha cobre de fato.
 */
export function fecharPagamentos(valor, pagamentos) {
  let faltaC = centavos(valor);
  let trocoC = 0;
  const linhas = [];
  for (const p of pagamentos) {
    const valorC = centavos(p.valor);
    if (p.metodo === 'dinheiro') {
      const recebidoC = Math.max(centavos(p.valorRecebido ?? p.valor), valorC);
      const cobre = Math.min(valorC, Math.max(0, faltaC));
      trocoC += recebidoC - cobre;
      faltaC -= cobre;
      linhas.push({ ...p, cobre: reais(cobre) });
    } else {
      const cobre = Math.min(valorC, Math.max(0, faltaC));
      faltaC -= cobre;
      linhas.push({ ...p, cobre: reais(cobre), excede: valorC > cobre });
    }
  }
  return { faltaC: Math.max(0, faltaC), trocoC, linhas };
}

/** Ler "12,50" / "12.50" / "1.234,56" como número. */
export function lerValor(texto) {
  const s = String(texto ?? '').trim().replace(/\s/g, '');
  if (!s) return NaN;
  const normal = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = Number(normal);
  return Number.isFinite(n) ? n : NaN;
}

/** Comandos que precisam do computador respondendo na hora. */
export const SO_ONLINE = ['abrir', 'adicionar_pessoa', 'renomear_pessoa', 'remover_pessoa', 'mover_item', 'observacao_item',
  'cancelar_item', 'limpar_mesa', 'juntar', 'separar', 'transferir', 'taxa_servico', 'receber', 'meu_turno'];

/**
 * Computador "vivo": ele republica as mesas pelo menos a cada 30 s. Vale o
 * que vier primeiro: o relógio do computador (vivoEmMs) perto do nosso, ou
 * este celular ter RECEBIDO uma publicação nova há pouco (não depende de os
 * dois relógios estarem certos).
 */
export function servidorVivo(doc, ultimaNovidadeMs, agoraMs = Date.now()) {
  const ms = Number(doc?.vivoEmMs) || 0;
  if (ms > 0 && Math.abs(agoraMs - ms) < 90 * 1000) return true;
  return Number(ultimaNovidadeMs) > 0 && agoraMs - ultimaNovidadeMs < 90 * 1000;
}
