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
export function PaymentPanel({ saleId, total, onFinalized }) {
  const { currentUser } = useSession();
  const [metodo, setMetodo] = useState('dinheiro');
  const [valor, setValor] = useState('');
  const [pagamentos, setPagamentos] = useState([]);
  const [error, setError] = useState('');
  const [finalizando, setFinalizando] = useState(false);
  const [finalizada, setFinalizada] = useState(false);
  const [nfceStatus, setNfceStatus] = useState(null);
  const [printMsg, setPrintMsg] = useState('');

  // Cliente vinculado à venda — necessário pra fiado e fidelidade.
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerResults, setCustomerResults] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [pontosResgate, setPontosResgate] = useState('');
  const [desconto, setDesconto] = useState(0);

  // Desconto manual, a critério do gerente — separado do de fidelidade.
  const [descontoGerenteInput, setDescontoGerenteInput] = useState('');
  const [descontoGerente, setDescontoGerente] = useState(0);
  const [descontoGerenteMotivo, setDescontoGerenteMotivo] = useState('');
  const [showDescontoAuth, setShowDescontoAuth] = useState(false);

  // Estado específico do fluxo Pix: gera o QR, espera confirmação manual
  // do operador (não existe integração bancária automática).
  const [pix, setPix] = useState(null); // { valor, payload, qrDataUrl } | null
  const [pixGerando, setPixGerando] = useState(false);

  const totalAPagar = total - desconto - descontoGerente;
  const totalPago = pagamentos.reduce((acc, p) => acc + p.valor, 0);
  const restante = Math.max(0, totalAPagar - totalPago);
  const troco = metodo === 'dinheiro' && Number(valor) > restante ? Number(valor) - restante : 0;

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

  function solicitarDescontoGerente() {
    const valorNumerico = Number(descontoGerenteInput);
    if (!valorNumerico || valorNumerico <= 0) return setError('Informe um valor de desconto válido.');
    setError('');
    setShowDescontoAuth(true);
  }

  async function confirmarDescontoGerente(candidateId, pin, motivo) {
    const result = await window.pdv.sale.applyManagerDiscount({
      saleId, valor: Number(descontoGerenteInput), motivo,
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

  async function addPayment() {
    const numeric = Number(valor);
    if (!numeric || numeric <= 0) return setError('Informe um valor válido.');
    if (metodo === 'fiado' && !customer) return setError('Vincule um cliente antes de usar fiado.');
    setError('');

    const valorAplicado = metodo === 'dinheiro' ? Math.min(numeric, restante) : numeric;
    const result = await window.pdv.sale.addPayment({ saleId, metodo, valor: valorAplicado, detalhes: {} });
    if (!result.ok) return setError(result.error);
    registrarPagamentoLocal(result.id, metodo, valorAplicado);
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
    setNfceStatus({ emitindo: false, mensagem: result.error || 'NFC-e emitida.' });
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
            Emissão de nota fiscal (NFC-e) — opcional, a venda já está registrada independente disso.
          </p>
          <button className="btn-secondary" onClick={handleEmitirNFCe} disabled={nfceStatus?.emitindo}>
            {nfceStatus?.emitindo ? 'Emitindo...' : 'Emitir NFC-e'}
          </button>
          {nfceStatus?.mensagem && <p className="modal-error" style={{ marginTop: 8 }}>{nfceStatus.mensagem}</p>}
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
          <input
            type="number" step="0.01" min="0.01"
            placeholder="Desconto a critério do gerente (R$)"
            value={descontoGerenteInput}
            onChange={(e) => setDescontoGerenteInput(e.target.value)}
          />
          <button className="btn-secondary" onClick={solicitarDescontoGerente}>Solicitar desconto</button>
        </div>
      ) : (
        <p className="io-message">
          Desconto autorizado aplicado: -R$ {descontoGerente.toFixed(2)}
          {descontoGerenteMotivo && ` (${descontoGerenteMotivo})`}
          {' — '}
          <button className="btn-link" onClick={removerDescontoGerente}>remover</button>
        </p>
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
          />
          {metodo === 'pix' ? (
            <button className="btn-secondary" onClick={gerarQrPix} disabled={pixGerando}>
              {pixGerando ? 'Gerando...' : 'Gerar QR Code'}
            </button>
          ) : (
            <button className="btn-secondary" onClick={addPayment}>Adicionar</button>
          )}
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
