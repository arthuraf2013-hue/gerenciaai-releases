const { getDb } = require('../db/database');
const timeService = require('./timeService');

/**
 * Automações proativas do WhatsApp — mensagens que o PRÓPRIO sistema
 * inicia sozinho (o bot já manda lembrete de reserva e status de
 * pedido; isso aqui estende a mesma ideia pra três casos a mais):
 *   1) reconquista automática — em vez de exigir que alguém abra
 *      "Clientes que sumiram" e clique no link manualmente, manda
 *      sozinho (com cooldown por cliente, ver customerService).
 *   2) alerta de estoque baixo — resumo diário pro telefone do dono.
 *   3) resumo diário de fechamento — vendas do dia, pro telefone do dono.
 * Chamado por um poller periódico em main.js (ver checarAutomacoesWhatsapp),
 * igual ao lembrete de reserva — cada `ultimo_envio_*` guarda a DATA
 * (não hora) da última vez que aquela automação de fato rodou, pra não
 * mandar de novo toda vez que o poller passar no mesmo dia.
 *
 * Mesmo aviso do resto da integração de WhatsApp (ver o topo de
 * whatsappBotService.js): mensagem iniciada pela LOJA (não resposta a
 * nada que o cliente/dono mandou) tem risco de bloqueio um pouco maior
 * — automações aqui são desligadas por padrão, o admin liga cada uma
 * na Configurações → WhatsApp depois de já confiar na conexão.
 */

function getConfig() {
  const db = getDb();
  return db.prepare('SELECT * FROM whatsapp_automation_config WHERE id = ?').get('default');
}

function updateConfig(payload) {
  const db = getDb();
  const current = getConfig();
  db.prepare(
    `UPDATE whatsapp_automation_config SET
       telefone_dono = ?, reconquista_automatica_ativa = ?, alerta_estoque_baixo_ativo = ?,
       resumo_diario_ativo = ?, resumo_diario_hora = ?
     WHERE id = 'default'`
  ).run(
    payload.telefoneDono !== undefined ? (payload.telefoneDono || null) : current.telefone_dono,
    payload.reconquistaAutomaticaAtiva ? 1 : 0,
    payload.alertaEstoqueBaixoAtivo ? 1 : 0,
    payload.resumoDiarioAtivo ? 1 : 0,
    payload.resumoDiarioHora || current.resumo_diario_hora
  );
  return { ok: true };
}

/** Cupom automático de aniversário — roda todo dia, credita pontos de
 * bônus só depois que a mensagem sai com sucesso (ver
 * customerService.creditarCupomAniversario). Não depende de
 * whatsapp_automation_config — mora em loyalty_config, já que é parte
 * do programa de fidelidade, não uma automação avulsa. */
async function executarCupomAniversario() {
  const customerService = require('./customerService');
  const whatsappBotService = require('./whatsappBotService');

  const loyaltyConfig = customerService.getLoyaltyConfig();
  if (!loyaltyConfig.ativado || !loyaltyConfig.ativar_cupom_aniversario) return;
  if (whatsappBotService.getStatus().status !== 'conectado') return;

  const hoje = timeService.hojeLocalISO(); // 'AAAA-MM-DD'
  const anoAtual = Number(hoje.slice(0, 4));
  const hojeMMDD = hoje.slice(5); // 'MM-DD'

  const aniversariantes = customerService.listAniversariantesHoje({ hojeMMDD, anoAtual });
  for (const cliente of aniversariantes) {
    const primeiroNome = cliente.nome.trim().split(' ')[0];
    const texto = `🎉 Feliz aniversário, ${primeiroNome}! Passando pra desejar um dia ótimo e deixar um presentinho: +${loyaltyConfig.pontos_bonus_aniversario} pontos de bônus no seu cadastro. Te esperamos! 😊`;
    const resultado = await whatsappBotService.enviarMensagem({ telefone: cliente.telefone, texto });
    if (resultado.ok) {
      customerService.creditarCupomAniversario(cliente.id, loyaltyConfig.pontos_bonus_aniversario, anoAtual);
    } else {
      console.error('[whatsappAutomationService] falha ao mandar cupom de aniversário', cliente.id, resultado.error);
    }
  }
}

/** Reconquista automática — mesma lista de "clientes que sumiram" já
 * usada pela tela manual, com cooldown por cliente pra não repetir a
 * mensagem toda vez que o poller passar (ver
 * customerService.listClientesQueSumiramParaAutomacao). */
async function executarReconquistaAutomatica() {
  const customerService = require('./customerService');
  const whatsappBotService = require('./whatsappBotService');

  const config = getConfig();
  if (!config.reconquista_automatica_ativa) return;
  if (whatsappBotService.getStatus().status !== 'conectado') return;

  const sumidos = customerService.listClientesQueSumiramParaAutomacao();
  for (const cliente of sumidos) {
    const texto = customerService.textoMensagemReconquista(cliente.nome);
    const resultado = await whatsappBotService.enviarMensagem({ telefone: cliente.telefone, texto });
    if (resultado.ok) {
      customerService.marcarReconquistaAutomaticaEnviada(cliente.id);
    } else {
      console.error('[whatsappAutomationService] falha ao mandar reconquista automática', cliente.id, resultado.error);
    }
  }
}

/** Alerta de estoque baixo pro telefone do dono — roda no máximo uma
 * vez por dia (ver ultimo_envio_estoque_baixo), juntando o alerta
 * reativo (abaixo do mínimo) com a previsão de ruptura (vai faltar em
 * breve mesmo sem ter batido o mínimo ainda) — mesmas duas fontes já
 * usadas na tela de Alertas, só que num resumo mandado, não esperando
 * alguém abrir a tela. */
async function executarAlertaEstoqueBaixo({ locationId }) {
  const stockService = require('./stockService');
  const whatsappBotService = require('./whatsappBotService');

  const config = getConfig();
  if (!config.alerta_estoque_baixo_ativo || !config.telefone_dono) return;
  if (whatsappBotService.getStatus().status !== 'conectado') return;

  const hoje = timeService.hojeLocalISO();
  if (config.ultimo_envio_estoque_baixo === hoje) return;

  const baixoEstoque = stockService.listLowStock(locationId);
  const ruptura = stockService.previsaoDeRuptura(locationId);
  if (baixoEstoque.length === 0 && ruptura.length === 0) {
    marcarEnvioHoje('ultimo_envio_estoque_baixo', hoje);
    return; // nada pra avisar hoje -- ainda assim marca, pra não checar de novo várias vezes no mesmo dia
  }

  const linhasBaixo = baixoEstoque.slice(0, 10).map((p) => `⚠ ${p.nome} — ${p.estoque_atual} restante(s) (mínimo: ${p.estoque_minimo})`);
  const linhasRuptura = ruptura.slice(0, 10).map((p) => `⏳ ${p.nome} — acaba em ~${p.diasRestantes} dia(s) no ritmo atual`);
  const partes = [
    '📉 *Resumo de estoque de hoje — GerenciaAI*',
    linhasBaixo.length ? `\n*Abaixo do mínimo:*\n${linhasBaixo.join('\n')}` : null,
    linhasRuptura.length ? `\n*Previsão de faltar em breve:*\n${linhasRuptura.join('\n')}` : null,
  ].filter(Boolean);
  const totalOmitido = Math.max(0, baixoEstoque.length - 10) + Math.max(0, ruptura.length - 10);
  if (totalOmitido > 0) partes.push(`\n(+${totalOmitido} outro(s) item(ns) — veja a lista completa em Alertas.)`);

  const resultado = await whatsappBotService.enviarMensagem({ telefone: config.telefone_dono, texto: partes.join('\n') });
  if (resultado.ok) {
    marcarEnvioHoje('ultimo_envio_estoque_baixo', hoje);
  } else {
    console.error('[whatsappAutomationService] falha ao mandar alerta de estoque baixo', resultado.error);
  }
}

/** Resumo diário de fechamento pro telefone do dono — só depois do
 * horário configurado (resumo_diario_hora), e no máximo uma vez por dia. */
async function executarResumoDiario({ locationId }) {
  const dashboardService = require('./dashboardService');
  const whatsappBotService = require('./whatsappBotService');

  const config = getConfig();
  if (!config.resumo_diario_ativo || !config.telefone_dono) return;
  if (whatsappBotService.getStatus().status !== 'conectado') return;

  const hoje = timeService.hojeLocalISO();
  if (config.ultimo_envio_resumo_diario === hoje) return;

  const agora = timeService.getBrasiliaNowParts().hora; // 'HH:MM:SS'
  if (agora.slice(0, 5) < config.resumo_diario_hora) return; // ainda não chegou o horário configurado

  const resumo = dashboardService.getSummary({ locationId, dataInicio: hoje, dataFim: hoje });
  const topLinhas = (resumo.topProdutos || []).slice(0, 5).map((p) => `• ${p.nome} — ${p.quantidade}un`);
  const partes = [
    `📊 *Fechamento de hoje — GerenciaAI*`,
    `Vendas: ${resumo.totais?.totalVendas ?? 0}`,
    `Faturado: R$ ${Number(resumo.totais?.totalFaturado ?? 0).toFixed(2).replace('.', ',')}`,
    topLinhas.length ? `\nMais vendidos hoje:\n${topLinhas.join('\n')}` : null,
  ].filter(Boolean);

  const resultado = await whatsappBotService.enviarMensagem({ telefone: config.telefone_dono, texto: partes.join('\n') });
  if (resultado.ok) {
    marcarEnvioHoje('ultimo_envio_resumo_diario', hoje);
  } else {
    console.error('[whatsappAutomationService] falha ao mandar resumo diário', resultado.error);
  }
}

function marcarEnvioHoje(coluna, hoje) {
  const db = getDb();
  db.prepare(`UPDATE whatsapp_automation_config SET ${coluna} = ? WHERE id = 'default'`).run(hoje);
}

module.exports = {
  getConfig, updateConfig,
  executarCupomAniversario, executarReconquistaAutomatica, executarAlertaEstoqueBaixo, executarResumoDiario,
};
