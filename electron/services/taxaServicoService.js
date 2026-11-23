// Taxa de serviço fixa da casa (mesas).
//
// Ligada, toda mesa que abre já nasce com essa % (tableService.openTable e a
// cópia de contingência do caixa) e a nota e a pré-nota da MESA sempre trazem
// os dois totais: sem serviço e com serviço (opcional). A taxa continua
// opcional para o cliente: quem atende ainda tira ou muda na conta.
//
// Configuração por instalação (tabela taxa_servico_config do schema.sql,
// CREATE TABLE IF NOT EXISTS, sem migração). No grupo de caixas quem abre a
// mesa é o servidor, então vale a configuração dele; a nota sai com a da
// máquina que imprime -- por isso a tela pede para ligar igual em todos.

const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

const PERCENTUAL_PADRAO = 10;
const PERCENTUAL_MAXIMO = 30;

const arred = (v) => Math.round((Number(v) || 0) * 100) / 100;

function getConfig() {
  let linha = null;
  try {
    linha = getDb().prepare("SELECT ativa, percentual FROM taxa_servico_config WHERE id = 'default'").get();
  } catch { linha = null; }
  const percentual = Number(linha?.percentual);
  return {
    ok: true,
    ativa: linha?.ativa === 1,
    percentual: Number.isFinite(percentual) && percentual > 0 && percentual <= PERCENTUAL_MAXIMO ? percentual : PERCENTUAL_PADRAO,
  };
}

/** % que entra sozinha na mesa nova (0 = desligada). */
function percentualFixo() {
  const c = getConfig();
  return c.ativa ? c.percentual : 0;
}

/** % que o botão "Taxa de serviço" põe quando alguém marca: a fixa ou 10%. */
function percentualSugerido() {
  return percentualFixo() || PERCENTUAL_PADRAO;
}

function salvar({ ativa, percentual, operadorId } = {}) {
  const atual = getConfig();
  const ligar = typeof ativa === 'boolean' ? ativa : atual.ativa;
  let pct = atual.percentual;
  if (percentual !== undefined && percentual !== null && percentual !== '') {
    const n = Number(String(percentual).replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0 || n > PERCENTUAL_MAXIMO) {
      return { ok: false, error: `Taxa de serviço inválida: use um valor acima de 0 e até ${PERCENTUAL_MAXIMO}%.` };
    }
    pct = arred(n);
  }
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO taxa_servico_config (id, ativa, percentual) VALUES ('default', ?, ?)
      ON CONFLICT(id) DO UPDATE SET ativa = excluded.ativa, percentual = excluded.percentual, atualizado_em = NOW_SYNCED()`)
      .run(ligar ? 1 : 0, pct);
    const mudou = ligar !== atual.ativa || pct !== atual.percentual;
    if (mudou) {
      const descreve = (a, p) => (a ? `ligada (${p}%)` : 'desligada');
      db.prepare('INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso) VALUES (?, ?, ?, ?, 1)')
        .run(randomUUID(), 'taxa_servico_fixa', operadorId || null,
          `Taxa de serviço fixa: ${descreve(atual.ativa, atual.percentual)} -> ${descreve(ligar, pct)}`);
    }
  })();
  return getConfig();
}

/**
 * Configuração do estúdio para imprimir uma conta. Com a taxa fixa ligada,
 * a nota e a pré-nota de MESA sempre mostram os dois totais e, se a conta
 * ficou sem taxa (o cliente não quis), a % fixa entra como "com serviço,
 * opcional". Balcão e comanda da cozinha não mudam.
 */
function aplicarNaImpressao(tipo, config, { mesa } = {}) {
  if (!config || (tipo !== 'nota' && tipo !== 'prenota') || !mesa) return config;
  const pct = percentualFixo();
  if (!(pct > 0)) return config;
  return { ...config, mostrarComESemServico: true, taxaSugeridaPercentual: pct };
}

module.exports = {
  PERCENTUAL_PADRAO, PERCENTUAL_MAXIMO,
  getConfig, salvar, percentualFixo, percentualSugerido, aplicarNaImpressao,
};
