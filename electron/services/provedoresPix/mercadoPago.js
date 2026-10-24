/**
 * Pix automático pelo Mercado Pago (API de pagamentos).
 *
 *   criar      POST /v1/payments  { payment_method_id: 'pix', ... }
 *              -> point_of_interaction.transaction_data.qr_code (copia e cola)
 *   consultar  GET  /v1/payments/{id}
 *   cancelar   PUT  /v1/payments/{id}  { status: 'cancelled' }
 *   testar     GET  /users/me  (confere se o token é válido)
 *
 * Documentação (consultada em 10/2026): o Pix vence entre 30 min e 30 dias
 * depois de criado (`date_of_expiration`, formato yyyy-MM-dd'T'HH:mm:ss.SSS-03:00);
 * `X-Idempotency-Key` evita criar dois pagamentos se a mesma chamada for
 * repetida. Status: pending, approved, authorized, in_process, in_mediation,
 * rejected, cancelled (status_detail 'expired' quando venceu), refunded,
 * charged_back.
 *
 * Todo provedor devolve o mesmo formato (ver pixAutomaticoService.js), pra
 * dar pra trocar de banco sem mexer no resto.
 */

const API = 'https://api.mercadopago.com';
const TIMEOUT_MS = 15000;

/** ISO no fuso de Brasília (-03:00), que é o formato que a API aceita. */
function dataMercadoPago(ms) {
  const local = new Date(ms - 3 * 3600000);
  return `${local.toISOString().slice(0, 23)}-03:00`;
}

function mapearStatus(status, detalhe) {
  switch (status) {
    case 'approved': return 'pago';
    case 'pending': case 'in_process': case 'authorized': case 'in_mediation': return 'pendente';
    case 'cancelled': return detalhe === 'expired' ? 'expirado' : 'cancelado';
    case 'rejected': return 'falhou';
    case 'refunded': case 'charged_back': return 'estornado';
    default: return 'pendente';
  }
}

function criarMercadoPago({ fetch: fetchImpl = globalThis.fetch } = {}) {
  async function chamar(caminho, { token, metodo = 'GET', corpo, idempotencia } = {}) {
    let resposta;
    try {
      resposta = await fetchImpl(`${API}${caminho}`, {
        method: metodo,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(idempotencia ? { 'X-Idempotency-Key': idempotencia } : {}),
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
      if (resposta.status === 401 || resposta.status === 403) throw new Error('Token do Mercado Pago inválido ou sem permissão. Confira em Configurações → Pagamento.');
      const motivo = dados?.message || dados?.error || `erro ${resposta.status}`;
      throw new Error(`Mercado Pago recusou: ${String(motivo).slice(0, 160)}`);
    }
    return dados;
  }

  return {
    id: 'mercadopago',
    nome: 'Mercado Pago',

    async criar({ token, valor, descricao, referencia, idempotencia, expiraEmMs, emailPagador }) {
      const dados = await chamar('/v1/payments', {
        token, metodo: 'POST', idempotencia,
        corpo: {
          transaction_amount: Math.round(valor * 100) / 100,
          description: String(descricao || 'Venda').slice(0, 120),
          payment_method_id: 'pix',
          external_reference: referencia,
          date_of_expiration: dataMercadoPago(expiraEmMs),
          payer: { email: emailPagador },
        },
      });
      const copiaECola = dados?.point_of_interaction?.transaction_data?.qr_code;
      if (!dados?.id || !copiaECola) throw new Error('O Mercado Pago não devolveu o código Pix.');
      return { provedorId: String(dados.id), copiaECola, status: mapearStatus(dados.status, dados.status_detail) };
    },

    async consultar({ token, provedorId }) {
      const dados = await chamar(`/v1/payments/${encodeURIComponent(provedorId)}`, { token });
      return {
        status: mapearStatus(dados?.status, dados?.status_detail),
        valorPago: Number(dados?.transaction_details?.total_paid_amount ?? dados?.transaction_amount) || null,
        pagoEm: dados?.date_approved || null,
      };
    },

    async cancelar({ token, provedorId }) {
      await chamar(`/v1/payments/${encodeURIComponent(provedorId)}`, { token, metodo: 'PUT', corpo: { status: 'cancelled' } });
    },

    async testar({ token }) {
      const dados = await chamar('/users/me', { token });
      return { conta: String(dados?.nickname || dados?.id || 'conta Mercado Pago') };
    },
  };
}

module.exports = { criarMercadoPago, mapearStatus, dataMercadoPago };
