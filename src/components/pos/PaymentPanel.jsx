import { useState } from 'react';
import QRCode from 'qrcode';
import { useSession } from '../../context/SessionContext';
import { ManagerAuthModal } from './ManagerAuthModal';

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

  async function handleEmitirNFCe() {
    setNfceStatus({ emitindo: true, mensagem: null });
    const result = await window.pdv.fiscal.emitirNFCe({ saleId });
    setNfceStatus({
      emitindo: false,
      mensagem: result.ok ? result.aviso : result.error,
      sucesso: result.ok,
    });
  }

  async function handleImprimir() {
    setPrintMsg('Abrindo impressão...');
    const result = await window.pdv.print.receipt({ saleId });
    setPrintMsg(result.ok ? '' : result.error);
  }

  if (finalizada) {
    return (
      <div className="payment-panel">
        <p className="io-message">Venda finalizada com sucesso.</p>

        <button className="btn-secondary" onClick={handleImprimir}>Imprimir recibo</button>
        {printMsg && <p className="modal-error" style={{ marginTop: 4 }}>{printMsg}</p>}

        <div className="nfce-box">
          <p className="screen-hint" style={{ margin: 0 }}>
            Nota fiscal (NFC-e) — gera o arquivo XML de verdade, mas <strong>ainda não assina nem
            transmite</strong> pra SEFAZ (isso não é uma nota fiscal válida ainda). A venda já está
            registrada independente disso.
          </p>
          <button className="btn-secondary" onClick={handleEmitirNFCe} disabled={nfceStatus?.emitindo}>
            {nfceStatus?.emitindo ? 'Gerando...' : 'Gerar XML da NFC-e'}
          </button>
          {nfceStatus?.mensagem && (
            <p className={nfceStatus.sucesso ? 'io-message' : 'modal-error'} style={{ marginTop: 8 }}>
              {nfceStatus.mensagem}
            </p>
          )}
        </div>
        <button className="btn-primary" onClick={onFinalized}>Concluir</button>
      </div>
    );
  }

  return (
    <div className="payment-panel">
      <div className="customer-link-box">
        {customer ? (
          <div className="customer-chip">
            <span>{customer.nome} — {customer.pontos} ponto(s)</span>
            <button className="btn-link" onClick={() => setCustomer(null)}>Remover</button>
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
        <span>{restante > 0 ? 'Falta' : 'Troco'}</span>
        <strong>R$ {(restante > 0 ? restante : troco).toFixed(2)}</strong>
      </div>

      {restante > 0 && !pix && (
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
              <button className="btn-secondary" onClick={gerarQrPix} disabled={pixGerando}>
                {pixGerando ? 'Gerando...' : 'Gerar QR Code'}
              </button>
              <button className="btn-secondary" onClick={addPayment} title="Cliente já pagou por fora (QR fixo, chave, transferência) — só registra o valor, sem gerar nada aqui">
                Registrar sem QR
              </button>
            </>
          ) : (
            <button className="btn-secondary" onClick={addPayment}>Adicionar</button>
          )}
        </div>
      )}

      {restante > 0 && !pix && (
        <div className="payment-quick-values">
          <button type="button" className="quick-value-btn" onClick={() => setValor(restante.toFixed(2))}>
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
            <button className="btn-secondary" onClick={() => { setPix(null); setError(''); }}>Cancelar</button>
            <button className="btn-primary" onClick={confirmarRecebimentoPix}>Confirmar recebimento</button>
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

      <button className="btn-primary" disabled={restante > 0 || finalizando} onClick={finalizar}>
        {finalizando ? 'Finalizando...' : 'Finalizar venda'}
      </button>

      {showDescontoAuth && (
        <ManagerAuthModal
          title="Autorizar desconto"
          onConfirm={confirmarDescontoGerente}
          onClose={() => setShowDescontoAuth(false)}
        />
      )}
    </div>
  );
}
