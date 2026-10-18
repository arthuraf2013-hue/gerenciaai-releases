import { limitesDoDiaLocal, agoraMs, formatarCentavos, formatarQuantidade } from './base.js';
import { METODOS } from './vendas.js';

export async function resumoDoPeriodo(db, { inicio, fim }) {
  const tot = await db.get(
    `SELECT COUNT(*) AS qtd, COALESCE(SUM(total_centavos), 0) AS total, COALESCE(SUM(desconto_centavos), 0) AS descontos
     FROM vendas WHERE status = 'finalizada' AND criado_em >= ? AND criado_em < ?`,
    [inicio, fim],
  );
  const canceladas = await db.get(
    `SELECT COUNT(*) AS qtd, COALESCE(SUM(total_centavos), 0) AS total FROM vendas WHERE status = 'cancelada' AND criado_em >= ? AND criado_em < ?`,
    [inicio, fim],
  );
  const porMetodo = await db.all(
    `SELECT p.metodo, SUM(p.valor_centavos) AS total FROM pagamentos p JOIN vendas v ON v.id = p.venda_id
     WHERE v.status = 'finalizada' AND v.criado_em >= ? AND v.criado_em < ? GROUP BY p.metodo ORDER BY total DESC`,
    [inicio, fim],
  );
  const maisVendidos = await db.all(
    `SELECT vi.produto_id, vi.nome, vi.unidade, SUM(vi.qtd_mil) AS qtd_mil, SUM(vi.total_centavos) AS total
     FROM venda_itens vi JOIN vendas v ON v.id = vi.venda_id
     WHERE v.status = 'finalizada' AND v.criado_em >= ? AND v.criado_em < ?
     GROUP BY vi.produto_id ORDER BY total DESC LIMIT 10`,
    [inicio, fim],
  );
  const custo = await db.valor(
    `SELECT COALESCE(SUM(p.custo_centavos * vi.qtd_mil / 1000.0), 0) FROM venda_itens vi
     JOIN vendas v ON v.id = vi.venda_id JOIN produtos p ON p.id = vi.produto_id
     WHERE v.status = 'finalizada' AND v.criado_em >= ? AND v.criado_em < ?`,
    [inicio, fim],
  );
  return {
    vendas: tot.qtd,
    totalCentavos: tot.total,
    descontosCentavos: tot.descontos,
    ticketMedioCentavos: tot.qtd ? Math.round(tot.total / tot.qtd) : 0,
    custoEstimadoCentavos: Math.round(custo),
    canceladas: { quantidade: canceladas.qtd, totalCentavos: canceladas.total },
    porMetodo: porMetodo.map((m) => ({ metodo: m.metodo, nome: METODOS[m.metodo] || m.metodo, totalCentavos: m.total })),
    maisVendidos,
  };
}

export function resumoDeHoje(db) {
  return resumoDoPeriodo(db, limitesDoDiaLocal(agoraMs()));
}

/** Recibo em texto puro (vai bem no WhatsApp e em impressora térmica de 32/48 colunas). */
export function reciboEmTexto(venda, { nomeNegocio = 'GerenciaAI' } = {}) {
  const linhas = [];
  linhas.push(`*${nomeNegocio}*`);
  linhas.push(`Venda ${venda.numero} — ${new Date(venda.criado_em).toLocaleString('pt-BR')}`);
  if (venda.status === 'cancelada') linhas.push('*** VENDA CANCELADA ***');
  linhas.push('');
  for (const i of venda.itens) {
    linhas.push(`${formatarQuantidade(i.qtd_mil, i.unidade)} x ${i.nome}`);
    linhas.push(`   ${formatarCentavos(i.preco_unit_centavos)}${i.unidade === 'kg' ? '/kg' : ''} = ${formatarCentavos(i.total_centavos)}`);
  }
  linhas.push('');
  if (venda.desconto_centavos) {
    linhas.push(`Subtotal: ${formatarCentavos(venda.subtotal_centavos)}`);
    linhas.push(`Desconto: -${formatarCentavos(venda.desconto_centavos)}`);
  }
  linhas.push(`*Total: ${formatarCentavos(venda.total_centavos)}*`);
  for (const p of venda.pagamentos) linhas.push(`${METODOS[p.metodo] || p.metodo}: ${formatarCentavos(p.metodo === 'dinheiro' ? p.recebido_centavos ?? p.valor_centavos : p.valor_centavos)}`);
  if (venda.troco_centavos) linhas.push(`Troco: ${formatarCentavos(venda.troco_centavos)}`);
  if (venda.cliente_nome) linhas.push(`Cliente: ${venda.cliente_nome}`);
  linhas.push('');
  linhas.push('Documento sem valor fiscal.');
  return linhas.join('\n');
}
