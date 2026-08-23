import { useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { ManagerAuthModal } from './ManagerAuthModal';
import Icon from '../common/Icon';

const METODOS = [
  { id: 'dinheiro', label: 'Dinheiro' },
  { id: 'cartao_credito', label: 'Cartão de crédito' },
  { id: 'cartao_debito', label: 'Cartão de débito' },
  { id: 'pix', label: 'Pix' },
  { id: 'fiado', label: 'Fiado' },
  { id: 'outro', label: 'Outro' },
];

/**
 * @param {{ saleId: string, total: number, onFinalized: () => void }} props
 */
export function PaymentPanel({ saleId, total, onFinalized, mostrarTaxaServico = false, taxaServicoPercentual: taxaInicial = 0 }) {
  const { currentUser } = useSession();
  const [metodo, setMetodo] = useState('dinheiro');
  const [valor, setValor] = useState('');
  const [trocoConfirmado, setTrocoConfirmado] = useState(0);
  const [pagamentos, setPagamentos] = useState([]);
  const [error, setError] = useState('');
  const [finalizando, setFinalizando] = useState(false);
  const [finalizada, setFinalizada] = useState(false);
  const [nfceStatus, setNfceStatus] = useState(null);
  const [showCancelarNfceAuth, setShowCancelarNfceAuth] = useState(false);
  const [printMsg, setPrintMsg] = useState('');
  const [taxaServico, setTaxaServico] = useState(taxaInicial);

  // Cliente vinculado à venda — necessário pra fiado e fidelidade.
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerResults, setCustomerResults] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [pontosResgate, setPontosResgate] = useState('');
  const [desconto, setDesconto] = useState(0);

  // Desconto manual, a critério do gerente — separado do de fidelidade.
  const [descontoGerenteInput, setDescontoGerenteInput] = useState('');
  const [descontoGerenteTipo, setDescontoGerenteTipo] = useState('valor'); // 'valor' | 'percentual'
  const [descontoGerente, setDescontoGerente] = useState(0);
  const [descontoGerenteMotivo, setDescontoGerenteMotivo] = useState('');
  const [showDescontoAuth, setShowDescontoAuth] = useState(false);

  // Estado específico do fluxo Pix: gera o QR, espera confirmação manual
  // do operador (não existe integração bancária automática).
  const [pix, setPix] = useState(null); // { valor, payload, qrDataUrl } | null
  const [pixGerando, setPixGerando] = useState(false);

  const subtotalComDesconto = total - desconto - descontoGerente;
  const valorTaxaServico = taxaServico > 0 ? subtotalComDesconto * (taxaServico / 100) : 0;
  const totalAPagar = subtotalComDesconto + valorTaxaServico;
  const totalPago = pagamentos.reduce((acc, p) => acc + p.valor, 0);
  const restante = Math.max(0, totalAPagar - totalPago);
  // Mesma tolerância de meio centavo usada em finalizeSale (backend) --
  // sem isso, comparar `restante > 0` direto podia deixar o botão de
  // Finalizar travado pra sempre com "Falta R$ 0,00" na tela: somar
  // preços em ponto flutuante às vezes sobra um resíduo minúsculo (tipo
  // 0,00000000000004) que o toFixed(2) esconde na exibição mas que
  // continua sendo "maior que zero" numa comparação direta. Isso batia
  // menos com pagamentos parciais via Pix (o valor pago é sempre <= o
  // que faltava, validado em gerarQrPix) do que com um valor digitado
  // manualmente pra outras formas, o que explicava o botão só destravar
  // com Pix. Com a mesma tolerância dos dois lados, front e back sempre
  // concordam se a venda está paga.
  const pagamentoCompleto = totalPago + 0.005 >= totalAPagar;
  // Enquanto ainda está digitando o valor, mostra uma prévia do troco na
  // hora — depois que o pagamento é confirmado, o campo é limpo, então
  // passa a mostrar o troco do último pagamento que de fato gerou troco
  // (senão ele "desaparecia" assim que confirmava, mesmo tendo pago com
  // uma nota maior que o valor da venda).
  const trocoPreview = metodo === 'dinheiro' && Number(valor) > restante ? Number(valor) - restante : 0;
  const troco = valor ? trocoPreview : trocoConfirmado;

  function registrarPagamentoLocal(id, metodoUsado, valorAplicado) {
    setPagamentos((prev) => [...prev, { id, metodo: metodoUsado, valor: valorAplicado }]);
  }

  async function removerPagamento(pagamento) {
    const result = await window.pdv.sale.removePayment({ paymentId: pagamento.id, saleId });
    if (!result.ok) return setError(result.error);
    setPagamentos((prev) => prev.filter((p) => p.id !== pagamento.id));
  }

  async function buscarClientes(q) {
    setCustomerQuery(q);
    if (!q) return setCustomerResults([]);
    const list = await window.pdv.customers.list({ query: q });
    setCustomerResults(Array.isArray(list) ? list : []);
  }

  async function selecionarCliente(c) {
    await window.pdv.sale.setCustomer({ saleId, customerId: c.id });
    setCustomer(c);
    setCustomerResults([]);
    setCustomerQuery('');
  }

  async function resgatarPontos() {
    const pontos = Number(pontosResgate);
    if (!pontos || pontos <= 0) return;
    const result = await window.pdv.sale.redeemLoyaltyPoints({ saleId, pontos });
    if (!result.ok) return setError(result.error);
    setDesconto(result.desconto);
    setPontosResgate('');
  }

  async function solicitarDescontoGerente() {
    const valorNumerico = Number(descontoGerenteInput);
    if (!valorNumerico || valorNumerico <= 0) return setError('Informe um valor de desconto válido.');
    if (descontoGerenteTipo === 'percentual' && valorNumerico > 100) return setError('Porcentagem não pode passar de 100%.');
    setError('');

    const payload = descontoGerenteTipo === 'percentual'
      ? { percentual: valorNumerico }
      : { valor: valorNumerico };

    const config = await window.pdv.auth.getSecurityConfig();
    if (config.exigir_autorizacao_desconto !== 1) {
      // Sem exigência configurada — aplica direto, sem pedir senha.
      const result = await window.pdv.sale.applyManagerDiscount({
        saleId, ...payload, motivo: null, currentOperatorId: currentUser.id,
      });
      if (!result.ok) return setError(result.error);
      setDescontoGerente(result.desconto);
      setDescontoGerenteMotivo('');
      setDescontoGerenteInput('');
      return;
    }
    setShowDescontoAuth(true);
  }

  async function confirmarDescontoGerente(candidateId, pin, motivo) {
    const valorNumerico = Number(descontoGerenteInput);
    const payload = descontoGerenteTipo === 'percentual'
      ? { percentual: valorNumerico }
      : { valor: valorNumerico };
    const result = await window.pdv.sale.applyManagerDiscount({
      saleId, ...payload, motivo,
      currentOperatorId: currentUser.id, candidateManagerId: candidateId, pin,
    });
    if (result.ok) {
      setDescontoGerente(result.desconto);
      setDescontoGerenteMotivo(motivo);
      setDescontoGerenteInput('');
    }
    return result;
  }

  async function removerDescontoGerente() {
    await window.pdv.sale.removeManagerDiscount({ saleId });
    setDescontoGerente(0);
    setDescontoGerenteMotivo('');
  }

  async function alterarTaxaServico(novoValor) {
    setTaxaServico(novoValor);
    await window.pdv.sale.setServiceCharge({ saleId, percentual: novoValor });
  }

  async function addPayment() {
    const numeric = Number(valor);
    if (!numeric || numeric <= 0) return setError('Informe um valor válido.');
    if (metodo === 'fiado' && !customer) return setError('Vincule um cliente antes de usar fiado.');
    setError('');

    const trocoDestePagamento = metodo === 'dinheiro' && numeric > restante ? numeric - restante : 0;
    const valorAplicado = metodo === 'dinheiro' ? Math.min(numeric, restante) : numeric;
    const result = await window.pdv.sale.addPayment({ saleId, metodo, valor: valorAplicado, detalhes: {} });
    if (!result.ok) return setError(result.error);
    registrarPagamentoLocal(result.id, metodo, valorAplicado);
    setTrocoConfirmado(trocoDestePagamento);
    setValor('');
  }

  // Clicar em "Valor exato" só preenchia o campo -- ainda exigia um
  // segundo clique manual em "Adicionar" (ou "Gerar QR Code"), o que
  // muita gente não percebia que precisava fazer. Agora, se o valor no
  // campo já é exatamente o que falta (ou seja, a pessoa clicou de novo
  // em cima do mesmo valor que "Valor exato" já preencheu), o segundo
  // clique já efetiva o pagamento -- sem precisar caçar o botão
  // "Adicionar" ao lado.
  function handleValorExatoClick() {
    const jaPreenchidoComValorExato = valor !== '' && Math.abs(Number(valor) - restante) < 0.005;
    if (jaPreenchidoComValorExato) {
      if (metodo === 'pix') gerarQrPix(); else addPayment();
      return;
    }
    setValor(restante.toFixed(2));
  }

  async function gerarQrPix() {
    const numeric = Number(valor);
    if (!numeric || numeric <= 0) return setError('Informe o valor a cobrar via Pix (pode ser parcial).');
    if (numeric > restante) return setError(`O valor não pode passar de R$ ${restante.toFixed(2)} (falta da venda).`);
    setError('');
    setPixGerando(true);

    const result = await window.pdv.payment.buildPixPayload({ valor: numeric, txid: saleId.replace(/-/g, '').slice(0, 20) });
    if (!result.ok) {
      setPixGerando(false);
      return setError(result.error);
    }

    // qrcode só é usado nesse fluxo (gerar Pix) -- import dinâmico em vez
    // de estático no topo do arquivo, pra não fazer o PDV (montado o
    // tempo inteiro, ver AppShell.jsx) baixar essa biblioteca antes de
    // alguém realmente escolher pagar via Pix.
    const { default: QRCode } = await import('qrcode');
    const qrDataUrl = await QRCode.toDataURL(result.payload, { width: 260, margin: 1 });
    setPix({ valor: numeric, payload: result.payload, qrDataUrl });
    setPixGerando(false);
  }

  async function confirmarRecebimentoPix() {
    const result = await window.pdv.sale.addPayment({ saleId, metodo: 'pix', valor: pix.valor, detalhes: {} });
    if (!result.ok) return setError(result.error);
    registrarPagamentoLocal(result.id, 'pix', pix.valor);
    setPix(null);
    setValor('');
  }

  function copiarCodigoPix() {
    navigator.clipboard?.writeText(pix.payload);
  }

  async function finalizar() {
    setFinalizando(true);
    const result = await window.pdv.sale.finalize({ saleId });
    setFinalizando(false);
    if (!result.ok) return setError(result.error);
    setFinalizada(true);

    const receiptConfig = await window.pdv.print.getReceiptConfig();
    if (receiptConfig?.imprimir_automatico) {
      window.pdv.print.receipt({ saleId });
    }
  }

  function resumoNfce(result) {
    if (!result.ok) return { mensagem: result.error, sucesso: false, pendente: false };
    if (result.contingencia) {
      return { mensagem: result.aviso, sucesso: true, pendente: true, nfceId: result.id };
    }
    if (result.aviso) return { mensagem: result.aviso, sucesso: true, pendente: true, nfceId: result.id };
    if (result.autorizada) {
      return {
        mensagem: `NFC-e nº ${result.numero} autorizada (protocolo ${result.protocoloAutorizacao}).`,
        sucesso: true, pendente: false, autorizada: true, nfceId: result.id,
      };
    }
    return {
      mensagem: `NFC-e rejeitada pela SEFAZ: ${result.motivo || 'motivo não informado'}.`,
      sucesso: false, pendente: false,
    };
  }

  async function handleEmitirNFCe() {
    setNfceStatus({ emitindo: true, mensagem: null });
    const result = await window.pdv.fiscal.emitirNFCe({ saleId });
    setNfceStatus({ emitindo: false, ...resumoNfce(result) });
  }

  async function handleReenviarNFCe() {
    const nfceId = nfceStatus.nfceId;
    setNfceStatus((prev) => ({ ...prev, emitindo: true }));
    const result = await window.pdv.fiscal.reenviarNFCe({ nfceId });
    if (!result.ok) {
      // Continua pendente — deixa o botão de reenviar disponível de novo.
      setNfceStatus({ emitindo: false, mensagem: result.error, sucesso: false, pendente: true, nfceId });
      return;
    }
    setNfceStatus({ emitindo: false, ...resumoNfce(result) });
  }

  async function confirmarCancelamentoNFCe(candidateId, pin, motivo) {
    if (!motivo || motivo.trim().length < 15) {
      return { ok: false, error: 'Informe uma justificativa com pelo menos 15 caracteres (exigência da SEFAZ).' };
    }
    const result = await window.pdv.fiscal.cancelarNFCe({
      nfceId: nfceStatus.nfceId, justificativa: motivo,
      currentOperatorId: currentUser.id, candidateManagerId: candidateId, pin,
    });
    if (result.ok) {
      setNfceStatus((prev) => ({ ...prev, mensagem: `NFC-e cancelada (protocolo ${result.protocolo}).`, sucesso: true, autorizada: false, pendente: false }));
    }
    return result;
  }

  async function handleImprimir() {
    setPrintMsg('Abrindo impressão...');
    const result = await window.pdv.print.receipt({ saleId });
    setPrintMsg(result.ok ? '' : result.error);
  }

  async function handleEnviarWhatsapp() {
    setPrintMsg('Abrindo WhatsApp...');
    const result = await window.pdv.print.sendReceiptWhatsapp({ saleId });
    if (!result.ok) return setPrintMsg(result.error);
    setPrintMsg(result.temTelefoneCliente ? '' : 'Abriu o WhatsApp — escolha o contato pra enviar (essa venda não tem cliente com telefone cadastrado).');
  }

  if (finalizada) {
    return (
      <div className="payment-panel">
        <p className="io-message">Venda finalizada com sucesso.</p>

        <button className="btn-secondary" onClick={handleImprimir}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="printer" size={15} /> Imprimir recibo</span>
        </button>
        <button className="btn-secondary" onClick={handleEnviarWhatsapp} style={{ marginLeft: 8 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="chat" size={15} /> Enviar por WhatsApp</span>
        </button>
        {printMsg && <p className="modal-error" style={{ marginTop: 4 }}>{printMsg}</p>}

        <div className="nfce-box">
          <p className="screen-hint" style={{ margin: 0 }}>
            Nota fiscal (NFC-e) — gera o XML, assina com o certificado configurado e transmite pra
            SEFAZ. A venda já está registrada independente disso (emitir a NFC-e é opcional).
          </p>
          {!nfceStatus?.pendente && (
            <button className="btn-secondary" onClick={handleEmitirNFCe} disabled={nfceStatus?.emitindo}>
              {nfceStatus?.emitindo ? 'Emitindo...' : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="receipt" size={15} /> Emitir NFC-e</span>
              )}
            </button>
          )}
          {nfceStatus?.pendente && (
            <button className="btn-secondary" onClick={handleReenviarNFCe} disabled={nfceStatus?.emitindo}>
              {nfceStatus?.emitindo ? 'Reenviando...' : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="refresh" size={15} /> Tentar transmitir de novo</span>
              )}
            </button>
          )}
          {nfceStatus?.autorizada && (
            <button className="btn-danger" onClick={() => setShowCancelarNfceAuth(true)} style={{ marginLeft: 8 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="blocked" size={15} /> Cancelar NFC-e</span>
            </button>
          )}
          {nfceStatus?.mensagem && (
            <p className={nfceStatus.sucesso ? 'io-message' : 'modal-error'} style={{ marginTop: 8 }}>
              {nfceStatus.mensagem}
            </p>
          )}
        </div>
        <button className="btn-primary" onClick={onFinalized}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="checkCircle" size={15} /> Concluir</span>
        </button>

        {showCancelarNfceAuth && (
          <ManagerAuthModal
            title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="key" size={16} /> Autorizar cancelamento da NFC-e</span>}
            onConfirm={confirmarCancelamentoNFCe}
            onClose={() => setShowCancelarNfceAuth(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="payment-panel">
      <div className="customer-link-box">
        {customer ? (
          <div className="customer-chip">
            <span>{customer.nome} — {customer.pontos} ponto(s)</span>
            <button className="btn-link" onClick={() => setCustomer(null)}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="trash" size={14} /> Remover</span>
            </button>
          </div>
        ) : (
          <div>
            <input
              placeholder="Vincular cliente (opcional — necessário para fiado/fidelidade)"
              value={customerQuery}
              onChange={(e) => buscarClientes(e.target.value)}
            />
            {customerResults.length > 0 && (
              <ul className="customer-suggestions">
                {customerResults.map((c) => (
                  <li key={c.id}><button className="btn-link" onClick={() => selecionarCliente(c)}>{c.nome}</button></li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {customer && customer.pontos > 0 && desconto === 0 && (
        <div className="inline-form">
          <input type="number" min="1" max={customer.pontos} placeholder="Pontos a resgatar" value={pontosResgate} onChange={(e) => setPontosResgate(e.target.value)} />
          <button className="btn-secondary" onClick={resgatarPontos}>Resgatar</button>
        </div>
      )}
      {desconto > 0 && <p className="io-message">Desconto de fidelidade aplicado: -R$ {desconto.toFixed(2)}</p>}

      {descontoGerente === 0 ? (
        <div className="inline-form">
          <select
            value={descontoGerenteTipo}
            onChange={(e) => setDescontoGerenteTipo(e.target.value)}
            style={{ maxWidth: 90 }}
          >
            <option value="valor">R$</option>
            <option value="percentual">%</option>
          </select>
          <input
            type="number" step="0.01" min="0.01" max={descontoGerenteTipo === 'percentual' ? 100 : undefined}
            placeholder={descontoGerenteTipo === 'percentual' ? 'Desconto (%)' : 'Desconto a critério do gerente (R$)'}
            value={descontoGerenteInput}
            onChange={(e) => setDescontoGerenteInput(e.target.value)}
          />
          <button className="btn-secondary" onClick={solicitarDescontoGerente}>Aplicar desconto</button>
        </div>
      ) : (
        <p className="io-message">
          Desconto autorizado aplicado: -R$ {descontoGerente.toFixed(2)}
          {descontoGerenteMotivo && ` (${descontoGerenteMotivo})`}
          {' — '}
          <button className="btn-link" onClick={removerDescontoGerente}>remover</button>
        </p>
      )}

      {mostrarTaxaServico && (
        <div className="payment-service-charge">
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox" style={{ width: 'auto' }}
              checked={taxaServico > 0}
              onChange={(e) => alterarTaxaServico(e.target.checked ? 10 : 0)}
            />
            Taxa de serviço
          </label>
          {taxaServico > 0 && (
            <input
              type="number" min="0" max="100" step="1" style={{ width: 70 }}
              value={taxaServico}
              onChange={(e) => alterarTaxaServico(Number(e.target.value) || 0)}
            />
          )}
          {taxaServico > 0 && <span className="screen-hint" style={{ margin: 0 }}>% — R$ {valorTaxaServico.toFixed(2)}</span>}
        </div>
      )}

      <div className="payment-summary">
        <span>Total da venda</span>
        <strong>R$ {totalAPagar.toFixed(2)}</strong>
      </div>
      <div className="payment-summary">
        <span>Pago</span>
        <strong>R$ {totalPago.toFixed(2)}</strong>
      </div>
      <div className="payment-summary highlight">
        <span>{!pagamentoCompleto ? 'Falta' : 'Troco'}</span>
        <strong>R$ {(!pagamentoCompleto ? restante : troco).toFixed(2)}</strong>
      </div>

      {!pagamentoCompleto && !pix && (
        <div className="payment-input-row">
          <select value={metodo} onChange={(e) => { setMetodo(e.target.value); setError(''); }}>
            {METODOS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <input
            type="number"
            step="0.01"
            placeholder={metodo === 'pix' ? 'Valor (integral ou parcial)' : 'Valor'}
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (metodo === 'pix') gerarQrPix(); else addPayment();
            }}
            autoFocus
          />
          {metodo === 'pix' ? (
            <>
              <button className="btn-primary" onClick={gerarQrPix} disabled={pixGerando}>
                {pixGerando ? 'Gerando...' : 'Gerar QR Code'}
              </button>
              <button className="btn-secondary" onClick={addPayment} title="Cliente já pagou por fora (QR fixo, chave, transferência) — só registra o valor, sem gerar nada aqui">
                Registrar sem QR
              </button>
            </>
          ) : (
            // Era btn-secondary (cinza-esverdeado, baixo contraste no
            // tema escuro) -- ficava quase invisível ao lado do campo de
            // valor. btn-primary chama mais atenção pra essa ação, que é
            // o passo que de fato registra o pagamento.
            <button className="btn-primary" onClick={addPayment}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="add" size={15} /> Adicionar</span>
            </button>
          )}
        </div>
      )}

      {!pagamentoCompleto && !pix && (
        <div className="payment-quick-values">
          <button type="button" className="quick-value-btn" onClick={handleValorExatoClick}>
            Valor exato (R$ {restante.toFixed(2)})
          </button>
          {metodo === 'dinheiro' && [10, 20, 50, 100, 200].map((v) => (
            <button key={v} type="button" className="quick-value-btn" onClick={() => setValor(String(v))}>
              R$ {v}
            </button>
          ))}
        </div>
      )}

      {pix && (
        <div className="pix-box">
          <img src={pix.qrDataUrl} alt="QR Code Pix" width={200} height={200} />
          <p className="pix-valor">R$ {pix.valor.toFixed(2)}</p>
          <button className="btn-link" onClick={copiarCodigoPix}>Copiar código Pix (copia e cola)</button>
          <p className="screen-hint" style={{ margin: 0 }}>
            Peça para o cliente escanear ou colar o código. Confira o recebimento no seu banco antes de confirmar.
          </p>
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => { setPix(null); setError(''); }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="close" size={15} /> Cancelar</span>
            </button>
            <button className="btn-primary" onClick={confirmarRecebimentoPix}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="checkCircle" size={15} /> Confirmar recebimento</span>
            </button>
          </div>
        </div>
      )}

      {pagamentos.length > 0 && (
        <ul className="payment-list">
          {pagamentos.map((p) => (
            <li key={p.id} className="payment-list-item">
              <span>{METODOS.find((m) => m.id === p.metodo)?.label} — R$ {p.valor.toFixed(2)}</span>
              <button className="btn-link-danger" onClick={() => removerPagamento(p)}>Remover</button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="modal-error">{error}</p>}

      <button className="btn-primary" disabled={!pagamentoCompleto || finalizando} onClick={finalizar}>
        {finalizando ? 'Finalizando...' : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="checkCircle" size={15} /> Finalizar venda</span>
        )}
      </button>

      {showDescontoAuth && (
        <ManagerAuthModal
          title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="key" size={16} /> Autorizar desconto</span>}
          onConfirm={confirmarDescontoGerente}
          onClose={() => setShowDescontoAuth(false)}
        />
      )}
    </div>
  );
}
