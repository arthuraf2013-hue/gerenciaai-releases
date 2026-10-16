import { icon } from './icons.js';
import { formatarMoeda, formatarQuantidade, escapeHtml, METODOS, formatarDataHora, abrirSheet, mostrarToast } from './pdv-util.js';

/** Recibo (não fiscal) de uma venda finalizada do PDV móvel -- mostra na
 * tela e deixa mandar pro cliente (WhatsApp ou o menu de compartilhar do
 * celular). Monta tudo a partir de `resumo`, que o computador grava no
 * documento da venda (pdvMobileSyncService.montarResumo) -- os valores
 * são os oficiais, não os que o celular calculou. */

function textoRecibo(resumo, nomeLoja) {
  const linhas = [
    `*${nomeLoja}*`,
    `Venda ${resumo.numero} — ${formatarDataHora(resumo.finalizadaEm)}`,
    '',
    ...resumo.itens.map((i) => `${formatarQuantidade(i.quantidade)}x ${i.nome} — ${formatarMoeda(i.precoUnitario * i.quantidade)}`),
    '',
    resumo.desconto > 0 ? `Desconto: -${formatarMoeda(resumo.desconto)}` : null,
    `*Total: ${formatarMoeda(resumo.total)}*`,
    ...resumo.pagamentos.map((p) => `${METODOS[p.metodo]?.rotulo || p.metodo}: ${formatarMoeda(p.valor)}`),
    resumo.troco > 0 ? `Troco: ${formatarMoeda(resumo.troco)}` : null,
    '',
    'Obrigado pela preferência!',
  ];
  return linhas.filter((l) => l !== null).join('\n');
}

function mostrarRecibo({ venda, nomeLoja }) {
  const r = venda?.resumo;
  if (!r) { mostrarToast('Recibo ainda não disponível.', 'erro'); return; }
  const texto = textoRecibo(r, nomeLoja || 'Loja');
  const { el, fechar } = abrirSheet(`
    <h2>Recibo</h2>
    <div class="recibo">
      <div class="recibo-loja">${escapeHtml(nomeLoja || 'Loja')}</div>
      <div class="subtexto">Venda ${escapeHtml(r.numero)} · ${escapeHtml(formatarDataHora(r.finalizadaEm))}${r.operadorNome ? ` · ${escapeHtml(r.operadorNome)}` : ''}</div>
      ${r.clienteNome ? `<div class="subtexto">Cliente: ${escapeHtml(r.clienteNome)}</div>` : ''}
      <div class="recibo-itens">
        ${r.itens.map((i) => `
          <div class="recibo-linha"><span>${escapeHtml(formatarQuantidade(i.quantidade))}× ${escapeHtml(i.nome)}</span><span>${formatarMoeda(i.precoUnitario * i.quantidade)}</span></div>`).join('')}
      </div>
      ${r.desconto > 0 ? `<div class="recibo-linha"><span>Desconto</span><span>−${formatarMoeda(r.desconto)}</span></div>` : ''}
      <div class="recibo-linha recibo-total"><span>Total</span><span>${formatarMoeda(r.total)}</span></div>
      ${r.pagamentos.map((p) => `<div class="recibo-linha subtexto"><span>${escapeHtml(METODOS[p.metodo]?.rotulo || p.metodo)}</span><span>${formatarMoeda(p.valor)}</span></div>`).join('')}
      ${r.troco > 0 ? `<div class="recibo-linha"><span>Troco</span><span>${formatarMoeda(r.troco)}</span></div>` : ''}
      <p class="subtexto centro">Documento sem valor fiscal. NFC-e, se precisar, é emitida no computador da loja.</p>
    </div>
    <button id="btn-recibo-whats" class="btn-primario">${icon('compartilhar', 18)} Enviar no WhatsApp</button>
    ${navigator.share ? '<button id="btn-recibo-share" class="btn-secundario">Compartilhar...</button>' : ''}
    <button id="btn-recibo-fechar" class="btn-secundario">Fechar</button>
  `);
  el.querySelector('#btn-recibo-whats').addEventListener('click', () => {
    // O computador já monta o link com o telefone do cliente cadastrado,
    // quando tem (printService.buildReceiptWhatsappLink); sem cliente,
    // abre o WhatsApp pra escolher o contato.
    const url = venda.reciboWhatsappUrl && venda.reciboWhatsappUrl.startsWith('https://wa.me/')
      ? venda.reciboWhatsappUrl
      : `https://wa.me/?text=${encodeURIComponent(texto)}`;
    window.open(url, '_blank', 'noopener');
  });
  el.querySelector('#btn-recibo-share')?.addEventListener('click', () => {
    navigator.share({ title: `Recibo ${r.numero}`, text: texto }).catch(() => {});
  });
  el.querySelector('#btn-recibo-fechar').addEventListener('click', fechar);
}

export { mostrarRecibo, textoRecibo };
