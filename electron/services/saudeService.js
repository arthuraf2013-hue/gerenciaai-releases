const { getDb } = require('../db/database');
const { utcSqlAtras } = require('./timeService');

/**
 * "O que pede atenção" e "a loja está pronta?" -- só LEITURA, sem rede.
 *
 * Reúne num lugar coisas que hoje só aparecem quando alguém liga pro
 * suporte: venda presa esperando o estoque do grupo, variação do estoque
 * do grupo que não subiu, NFC-e rejeitada/em contingência, caixa aberto
 * há mais de um dia, backup que não deu certo, evento do celular terminal
 * recusado. Usado no fechamento de caixa, no resumo diário do WhatsApp e
 * no resumo que vai pra Central (licenseService) -- a mesma lista nos três.
 *
 * Cada verificação roda isolada: se uma tabela não existir (banco antigo,
 * perfil sem o recurso) ou der erro, ela só fica de fora.
 */

const HORAS_CAIXA_ABERTO = 24;
const HORAS_SEM_BACKUP = 48;

function contar(db, sql, params = []) {
  try { return db.prepare(sql).get(...params)?.c || 0; } catch { return 0; }
}

/**
 * @returns {{id: string, gravidade: 'alta'|'media', titulo: string, detalhe: string, tela: string|null, quantidade: number}[]}
 */
function listarPendencias({ locationId } = {}) {
  const db = getDb();
  const itens = [];
  const add = (item) => { if (item.quantidade > 0) itens.push(item); };

  add({
    id: 'vendas_presas_grupo', gravidade: 'alta', tela: 'pos',
    quantidade: contar(db, `SELECT COUNT(*) AS c FROM sales WHERE status = 'aberta' AND pendente_estoque_grupo = 1`),
    titulo: 'Venda esperando o estoque do grupo',
    detalhe: 'Sem conexão com o computador servidor do grupo. Tenta sozinha quando a internet voltar.',
  });
  add({
    id: 'estoque_grupo_nao_enviado', gravidade: 'media', tela: null,
    quantidade: contar(db, 'SELECT COUNT(*) AS c FROM estoque_grupo_pendente WHERE criado_em < ?', [utcSqlAtras({ minutos: 10 })]),
    titulo: 'Estoque do grupo não atualizado',
    detalhe: 'Entradas/devoluções deste computador ainda não chegaram ao estoque compartilhado (sem internet?).',
  });
  add({
    id: 'nfce_problema', gravidade: 'alta', tela: 'history',
    quantidade: contar(db, `SELECT COUNT(*) AS c FROM nfce_emitidas WHERE status IN ('rejeitada','contingencia','pendente')
      AND criado_em >= ?`, [utcSqlAtras({ dias: 30 })]),
    titulo: 'NFC-e rejeitada, pendente ou em contingência',
    detalhe: 'Abra a venda no Histórico e reenvie. Nota em contingência tem prazo para ser transmitida.',
  });
  add({
    id: 'caixa_aberto_antigo', gravidade: 'media', tela: 'pos',
    quantidade: contar(db, `SELECT COUNT(*) AS c FROM cash_sessions WHERE status = 'aberta'
      AND aberta_em < ?${locationId ? ' AND location_id = ?' : ''}`,
    locationId ? [utcSqlAtras({ horas: HORAS_CAIXA_ABERTO }), locationId] : [utcSqlAtras({ horas: HORAS_CAIXA_ABERTO })]),
    titulo: `Caixa aberto há mais de ${HORAS_CAIXA_ABERTO} horas`,
    detalhe: 'Feche o caixa do dia anterior para o fechamento bater.',
  });
  try {
    const b = db.prepare(`SELECT ultimo_backup_em, ultimo_backup_ok FROM backup_config WHERE id = 'default'`).get();
    const semBackupRecente = !b?.ultimo_backup_em
      || String(b.ultimo_backup_em) < utcSqlAtras({ horas: HORAS_SEM_BACKUP });
    if (b && (b.ultimo_backup_ok === 0 || semBackupRecente)) {
      itens.push({
        id: 'backup', gravidade: 'alta', tela: 'settings', quantidade: 1,
        titulo: b.ultimo_backup_ok === 0 ? 'O último backup falhou' : `Sem backup há mais de ${HORAS_SEM_BACKUP} horas`,
        detalhe: 'Em Configurações → Backup, rode "Fazer backup agora" e veja a mensagem.',
      });
    }
  } catch { /* sem tabela de backup */ }
  add({
    id: 'terminal_recusado', gravidade: 'media', tela: 'settings',
    quantidade: contar(db, `SELECT COUNT(*) AS c FROM pdv_terminal_eventos WHERE status = 'erro'`),
    titulo: 'Venda do celular terminal recusada',
    detalhe: 'Em Configurações → Celulares terminais, veja o motivo e use "Tentar de novo".',
  });
  add({
    id: 'vendas_abertas_antigas', gravidade: 'media', tela: 'pos',
    quantidade: contar(db, `SELECT COUNT(*) AS c FROM sales s WHERE s.status = 'aberta' AND s.pendente_estoque_grupo = 0
      AND s.criado_em < ?
      AND EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id AND si.cancelado = 0)`, [utcSqlAtras({ horas: 24 })]),
    titulo: 'Venda aberta há mais de um dia',
    detalhe: 'Venda com itens que nunca foi finalizada nem cancelada (o estoque já foi baixado).',
  });

  return itens.sort((a, b) => (a.gravidade === b.gravidade ? 0 : a.gravidade === 'alta' ? -1 : 1));
}

/**
 * Primeiros passos da implantação, conferidos no banco (não marcados à
 * mão). Cada item diz onde resolver.
 */
function progressoImplantacao() {
  const db = getDb();
  const umValor = (sql, params = []) => { try { return db.prepare(sql).get(...params); } catch { return null; } };
  const pix = umValor(`SELECT pix_chave FROM payment_config WHERE id = 'default'`);
  const recibo = umValor(`SELECT impressora_padrao FROM receipt_config LIMIT 1`);
  const backup = umValor(`SELECT pasta_secundaria, ultimo_backup_ok FROM backup_config WHERE id = 'default'`);
  const usuarios = contar(db, `SELECT COUNT(*) AS c FROM users WHERE ativo = 1`);
  const produtos = contar(db, `SELECT COUNT(*) AS c FROM products WHERE ativo = 1 AND COALESCE(tipo, 'produto') != 'servico'`);
  const produtosComCusto = contar(db, `SELECT COUNT(*) AS c FROM products WHERE ativo = 1 AND COALESCE(tipo, 'produto') != 'servico' AND custo > 0`);
  const vendas = contar(db, `SELECT COUNT(*) AS c FROM sales WHERE status = 'finalizada'`);
  const caixasFechados = contar(db, `SELECT COUNT(*) AS c FROM cash_sessions WHERE status = 'fechada'`);

  const passos = [
    { id: 'produtos', titulo: 'Cadastrar os produtos', feito: produtos >= 5, detalhe: produtos >= 5 ? `${produtos} produtos` : 'Importe a planilha ou cadastre por foto', tela: 'products' },
    { id: 'custos', titulo: 'Informar o custo dos produtos', feito: produtos > 0 && produtosComCusto / produtos >= 0.8, detalhe: produtos ? `${produtosComCusto} de ${produtos} com custo — sem custo, margem e lucro saem errados` : 'Depois de cadastrar os produtos', tela: 'products' },
    { id: 'pix', titulo: 'Configurar a chave Pix', feito: !!pix?.pix_chave, detalhe: 'Para o QR Code do Pix sair no caixa', tela: 'settings' },
    { id: 'impressora', titulo: 'Escolher a impressora do recibo', feito: !!recibo?.impressora_padrao, detalhe: 'Senão o sistema pergunta a cada venda', tela: 'settings' },
    { id: 'usuarios', titulo: 'Criar os usuários da equipe', feito: usuarios >= 2, detalhe: 'Cada um com seu PIN — a Auditoria mostra quem fez o quê', tela: 'users' },
    { id: 'backup', titulo: 'Backup em um segundo lugar', feito: !!backup?.pasta_secundaria, detalhe: 'Pendrive ou pasta do Google Drive/OneDrive', tela: 'settings' },
    { id: 'primeira_venda', titulo: 'Fazer a primeira venda', feito: vendas > 0, detalhe: vendas ? `${vendas} vendas` : 'Abra o caixa e venda', tela: 'pos' },
    { id: 'primeiro_fechamento', titulo: 'Fechar o caixa pela primeira vez', feito: caixasFechados > 0, detalhe: 'Confere se o dinheiro bate', tela: 'pos' },
  ];
  return { passos, feitos: passos.filter((p) => p.feito).length, total: passos.length };
}

/** Versão curta pra mandar à Central junto do contato periódico. */
function resumoParaCentral({ locationId } = {}) {
  const pendencias = listarPendencias({ locationId });
  const implantacao = progressoImplantacao();
  return {
    pendencias: pendencias.map((p) => ({ id: p.id, gravidade: p.gravidade, quantidade: p.quantidade, titulo: p.titulo })),
    pendenciasAltas: pendencias.filter((p) => p.gravidade === 'alta').length,
    implantacaoFeitos: implantacao.feitos,
    implantacaoTotal: implantacao.total,
    implantacaoFaltando: implantacao.passos.filter((p) => !p.feito).map((p) => p.titulo),
  };
}

module.exports = { listarPendencias, progressoImplantacao, resumoParaCentral };
