/**
 * Maquininha Mercado Pago Point integrada ao caixa (API de Orders, tipo
 * "point" -- a API "Payment Intent" antiga está sendo substituída por esta).
 *
 *   listar     GET   /terminals/v1/list?limit=50          -> data.terminals[] (id, operating_mode)
 *   modo PDV   PATCH /terminals/v1/setup                  { terminals: [{ id, operating_mode: 'PDV' }] }
 *   criar      POST  /v1/orders                           { type: 'point', external_reference, transactions.payments[{ amount }], config.point.terminal_id }
 *   consultar  GET   /v1/orders/{id}                      -> status: created | at_terminal | processed | failed | canceled | expired | refunded | action_required
 *   cancelar   POST  /v1/orders/{id}/cancel               (na maquininha: cabeçalho x-allow-cancelable-status: at_terminal -> 202)
 *   testar     GET   /users/me
 *
 * Documentação consultada em 11/2026 (developers Mercado Pago: "Integrar o
 * processamento de pagamentos" e "Migrar da API Payment Intent para Orders").
 * Valor vai como TEXTO com até 2 casas ("24.00"); `X-Idempotency-Key`
 * obrigatório na criação e no cancelamento (UUID). A maquininha precisa
 * estar no modo PDV (ativarModoPdv) e vinculada à mesma conta do token.
 * O resultado (aprovado/recusado) fica na própria order: não consultar a API
 * de payments para pagamento Point.
 *
 * Todo provedor devolve o mesmo formato (ver maquininhaService.js).
 */

const API = 'https://api.mercadopago.com';
const TIMEOUT_MS = 15000;
const TIPOS = { credito: 'credit_card', debito: 'debit_card', pix: 'qr' };

function mapearStatus(status) {
  switch (status) {
    case 'processed': return 'pago';
    case 'created': case 'at_terminal': case 'action_required': return 'pendente';
    case 'canceled': return 'cancelado';
    case 'expired': return 'expirado';
    case 'failed': return 'falhou';
    case 'refunded': return 'estornado';
    default: return 'pendente';
  }
}

/** Dados do pagamento aprovado que vão para a venda e para a NFC-e (grupo card). */
function detalhesDoPagamento(order) {
  const p = order?.transactions?.payments?.[0] || {};
  const pm = p.payment_method || {};
  return {
    pagamentoId: p.id ? String(p.id) : null,
    bandeira: typeof pm.id === 'string' ? pm.id : null,
    tipoCartao: typeof pm.type === 'string' ? pm.type : null,
    parcelas: Number(pm.installments) || null,
    autorizacao: [p.authorization_code, p.reference_id, p.reference?.id].find((v) => typeof v === 'string' && v.trim()) || null,
    ultimos4: typeof p.card?.last_four_digits === 'string' ? p.card.last_four_digits : null,
    valorPago: Number(p.paid_amount ?? p.amount ?? order?.total_amount) || null,
    statusDetalhe: String(p.status_detail || order?.status_detail || '').slice(0, 60) || null,
  };
}

function criarMercadoPagoPoint({ fetch: fetchImpl = globalThis.fetch } = {}) {
  async function chamar(caminho, { token, metodo = 'GET', corpo, idempotencia, cabecalhos = {} } = {}) {
    let resposta;
    try {
      resposta = await fetchImpl(`${API}${caminho}`, {
        method: metodo,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(idempotencia ? { 'X-Idempotency-Key': idempotencia } : {}),
          ...cabecalhos,
        },
        body: corpo ? JSON.stringify(corpo) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      const err = new Error('Sem conexão com o Mercado Pago. Confira a internet.');
      err.rede = true;
      throw err;
    }
    let dados = null;
    try { dados = await resposta.json(); } catch { dados = null; }
    if (!resposta.ok) {
      const codigo = String(dados?.errors?.[0]?.code || dados?.error || dados?.code || '');
      const err = new Error(traduzirErro(resposta.status, codigo, dados));
      err.status = resposta.status;
      err.codigo = codigo;
      throw err;
    }
    return { dados, status: resposta.status };
  }

  return {
    id: 'mercadopago_point',
    nome: 'Mercado Pago Point',

    async listarTerminais({ token }) {
      const { dados } = await chamar('/terminals/v1/list?limit=50&offset=0', { token });
      const lista = Array.isArray(dados?.data?.terminals) ? dados.data.terminals : [];
      return lista.map((t) => ({
        id: String(t.id), modo: String(t.operating_mode || ''), lojaId: t.store_id ? String(t.store_id) : null,
        caixaId: t.pos_id ? String(t.pos_id) : null, nome: t.external_pos_id ? String(t.external_pos_id) : null,
      }));
    },

    async ativarModoPdv({ token, terminalId }) {
      const { dados } = await chamar('/terminals/v1/setup', {
        token, metodo: 'PATCH', corpo: { terminals: [{ id: terminalId, operating_mode: 'PDV' }] },
      });
      const t = Array.isArray(dados?.terminals) ? dados.terminals.find((x) => x.id === terminalId) : null;
      return { modo: t?.operating_mode || 'PDV' };
    },

    async criar({ token, terminalId, valor, tipo, parcelas, referencia, idempotencia, imprimirNoTerminal, descricao }) {
      const metodo = TIPOS[tipo];
      if (!metodo) throw new Error('Tipo de pagamento inválido para a maquininha.');
      const paymentMethod = { default_type: metodo };
      if (tipo === 'credito' && Number(parcelas) > 1) paymentMethod.default_installments = String(Math.min(12, Math.floor(Number(parcelas))));
      const { dados } = await chamar('/v1/orders', {
        token, metodo: 'POST', idempotencia,
        corpo: {
          type: 'point',
          external_reference: String(referencia).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64),
          expiration_time: 'PT10M',
          description: String(descricao || 'Venda').slice(0, 150),
          transactions: { payments: [{ amount: (Math.round(valor * 100) / 100).toFixed(2) }] },
          config: {
            point: { terminal_id: terminalId, print_on_terminal: imprimirNoTerminal ? 'seller_ticket' : 'no_ticket' },
            payment_method: paymentMethod,
          },
        },
      });
      if (!dados?.id) throw new Error('O Mercado Pago não devolveu o pedido da maquininha.');
      return { provedorId: String(dados.id), pagamentoId: dados?.transactions?.payments?.[0]?.id ? String(dados.transactions.payments[0].id) : null, status: mapearStatus(dados.status) };
    },

    async consultar({ token, provedorId }) {
      const { dados } = await chamar(`/v1/orders/${encodeURIComponent(provedorId)}`, { token });
      return { status: mapearStatus(dados?.status), statusOriginal: dados?.status || null, naMaquininha: dados?.status === 'at_terminal', ...detalhesDoPagamento(dados) };
    },

    /** Cancela antes de pagar. Já na tela da maquininha: só Point Smart com
     * software atual aceita (202 = pedido de cancelamento, confirmar depois). */
    async cancelar({ token, provedorId, naMaquininha = false }) {
      const { status } = await chamar(`/v1/orders/${encodeURIComponent(provedorId)}/cancel`, {
        token, metodo: 'POST', idempotencia: require('crypto').randomUUID(),
        cabecalhos: naMaquininha ? { 'x-allow-cancelable-status': 'at_terminal' } : {},
      });
      return { confirmado: status === 200 };
    },

    async testar({ token }) {
      const { dados } = await chamar('/users/me', { token });
      return { conta: String(dados?.nickname || dados?.id || 'conta Mercado Pago') };
    },
  };
}

function traduzirErro(status, codigo, dados) {
  if (status === 401) return 'Token do Mercado Pago inválido. Confira em Configurações → Pagamento.';
  if (codigo === 'forbidden_checking_terminal_owner' || status === 403) return 'Essa maquininha não é da conta do token configurado (ou o token não tem permissão de Point).';
  if (codigo === 'already_queued_order_on_terminal' || codigo === 'idempotency_key_already_used' || status === 409) {
    return 'A maquininha já tem uma cobrança esperando. Conclua ou cancele na maquininha e tente de novo.';
  }
  if (codigo === 'store_pos_not_found') return 'A maquininha não está vinculada a uma loja/caixa no Mercado Pago.';
  if (codigo === 'cannot_cancel_order') return 'A cobrança já está na tela da maquininha: cancele por lá.';
  const motivo = dados?.errors?.[0]?.message || dados?.message || codigo || `erro ${status}`;
  return `Mercado Pago recusou: ${String(motivo).slice(0, 160)}`;
}

module.exports = { criarMercadoPagoPoint, mapearStatus, detalhesDoPagamento, TIPOS };
