// Modo TERMINAL: o celular passou a ser um caixa do GerenciaAI de um
// computador (o cliente começou só com o celular, comprou um computador,
// migrou os dados -- ver electron/services/pdvMobileMigracaoService.js --
// e na Central marcou o celular como terminal desse computador).
//
// O que muda em relação ao modo autônomo:
// - A VENDA continua 100% local e offline (mesmas regras, mesmo caixa
//   do celular). Cada fato que o computador precisa saber (venda, venda
//   cancelada, fiado recebido, cliente novo/editado) entra numa fila de
//   saída (tabela sync_saida) NA MESMA transação do fato -- não existe
//   venda sem evento. Ao virar terminal, entra também o "atraso": tudo o
//   que foi feito desde a migração (inclusive entradas/contagens de
//   estoque -- tipo 'estoque', que só o atraso gera). Quando tem internet, a fila sobe pra
//   installations/{id}/terminal_eventos e o computador aplica (ver
//   electron/services/pdvMobileTerminalService.js), devolvendo um
//   "recibo" em terminal_acks (com a NFC-e, se o computador emitir).
// - PRODUTOS, PREÇOS e ESTOQUE passam a ser do computador: ele publica
//   o catálogo em terminal_catalogo/ e o celular aplica. Cadastro e
//   estoque ficam bloqueados aqui (seria editar uma cópia).
// - O estoque mostrado é o do computador MENOS o que este celular já
//   vendeu e o computador ainda não recebeu.
// - A licença, os bloqueios da Central e os 3 dias sem internet seguem
//   iguais ao modo autônomo; o backup também continua.
import { novoId, agoraIso, agoraMs, ctx, definirContexto, lerConfig, gravarConfig, ErroDeNegocio, normalizarBusca, AGORA_SERVIDOR } from './base.js';

export const VERSAO_EVENTO = 1;
const INTERVALO_ENVIO_MS = 60 * 1000;
const LOTE_ENVIO = 40;

export function modoTerminal() { return !!ctx().modoTerminal; }

/** Guarda dos serviços de cadastro (produto/estoque): no terminal, quem manda é o computador. */
export function exigirModoAutonomo(acao = 'Isso') {
  if (!modoTerminal()) return;
  const nome = ctx().servidorNome || 'computador';
  throw new ErroDeNegocio(`${acao} é feito no ${nome}: este celular é terminal dele, e produtos, preços e estoque vêm de lá.`, 'modo_terminal');
}

// ---------------------------------------------------------------------------
// Montagem dos eventos (retrato do fato, lido DENTRO da transação dele)

// `criado_em` vai junto: o computador sabe se o produto nasceu depois da
// migração (aí o saldo dele vem só pelos eventos, desde zero).
const COLUNAS_PRODUTO = 'id, nome, codigo_barras, categoria, unidade, preco_centavos, custo_centavos, estoque_mil, estoque_minimo_mil, controla_estoque, criado_em';

const pessoa = async (tx, id) => (id ? (await tx.get('SELECT id, nome, papel, criado_em FROM usuarios WHERE id = ?', [id])) || { id, nome: 'Operador do celular', papel: 'operador' } : null);

async function eventoVenda(tx, vendaId) {
  const venda = await tx.get('SELECT * FROM vendas WHERE id = ?', [vendaId]);
  if (!venda) throw new Error(`venda ${vendaId} não encontrada pra montar o evento`);
  const itens = await tx.all('SELECT * FROM venda_itens WHERE venda_id = ? ORDER BY rowid', [vendaId]);
  const pagamentos = await tx.all('SELECT * FROM pagamentos WHERE venda_id = ? ORDER BY rowid', [vendaId]);
  const movimentos = await tx.all(`SELECT * FROM movimentos_estoque WHERE venda_id = ? AND tipo = 'venda' ORDER BY rowid`, [vendaId]);
  const fiado = await tx.all(`SELECT * FROM fiado_lancamentos WHERE venda_id = ? AND tipo = 'compra' ORDER BY rowid`, [vendaId]);
  const ids = [...new Set(itens.map((i) => i.produto_id))];
  const produtos = ids.length ? await tx.all(
    `SELECT ${COLUNAS_PRODUTO} FROM produtos WHERE id IN (${ids.map(() => '?').join(',')})`, ids,
  ) : [];
  const cliente = venda.cliente_id ? await tx.get('SELECT * FROM clientes WHERE id = ?', [venda.cliente_id]) : null;
  return {
    criadoEm: venda.criado_em,
    dados: {
      venda, itens, pagamentos, movimentos, fiado, produtos, cliente,
      operador: await pessoa(tx, venda.operador_id),
      autorizador: await pessoa(tx, venda.desconto_autorizado_por),
    },
  };
}

async function eventoCancelamento(tx, vendaId) {
  const venda = await tx.get('SELECT * FROM vendas WHERE id = ?', [vendaId]);
  if (!venda || venda.status !== 'cancelada') throw new Error(`venda ${vendaId} não está cancelada`);
  const movimentos = await tx.all(`SELECT * FROM movimentos_estoque WHERE venda_id = ? AND tipo = 'cancelamento_venda' ORDER BY rowid`, [vendaId]);
  const fiado = await tx.all(`SELECT * FROM fiado_lancamentos WHERE venda_id = ? AND tipo = 'estorno' ORDER BY rowid`, [vendaId]);
  const ids = [...new Set(movimentos.map((m) => m.produto_id))];
  const produtos = ids.length ? await tx.all(
    `SELECT ${COLUNAS_PRODUTO} FROM produtos WHERE id IN (${ids.map(() => '?').join(',')})`, ids,
  ) : [];
  return {
    criadoEm: venda.cancelada_em,
    dados: {
      vendaId, numero: venda.numero, canceladaEm: venda.cancelada_em, motivo: venda.motivo_cancelamento,
      cancelador: await pessoa(tx, venda.cancelada_por), movimentos, fiado, produtos,
      cliente: venda.cliente_id ? await tx.get('SELECT * FROM clientes WHERE id = ?', [venda.cliente_id]) : null,
    },
  };
}

async function eventoFiadoPagamento(tx, lancamentoId) {
  const lancamento = await tx.get('SELECT * FROM fiado_lancamentos WHERE id = ?', [lancamentoId]);
  if (!lancamento) throw new Error(`lançamento ${lancamentoId} não encontrado`);
  return {
    criadoEm: lancamento.criado_em,
    dados: { lancamento, cliente: await tx.get('SELECT * FROM clientes WHERE id = ?', [lancamento.cliente_id]), usuario: await pessoa(tx, lancamento.usuario_id) },
  };
}

async function eventoCliente(tx, clienteId) {
  const cliente = await tx.get('SELECT * FROM clientes WHERE id = ?', [clienteId]);
  if (!cliente) throw new Error(`cliente ${clienteId} não encontrado`);
  return { criadoEm: cliente.atualizado_em, dados: { cliente } };
}

/**
 * Entrada/contagem de estoque feita no celular ENTRE a migração e virar
 * terminal (no terminal, estoque é do computador e isso fica bloqueado).
 * Só o atraso (enfileirarDesdeCorte) gera este tipo.
 */
async function eventoEstoque(tx, movimentoId) {
  const movimento = await tx.get('SELECT * FROM movimentos_estoque WHERE id = ?', [movimentoId]);
  if (!movimento) throw new Error(`movimento ${movimentoId} não encontrado`);
  return {
    criadoEm: movimento.criado_em,
    dados: {
      movimento,
      produto: await tx.get(`SELECT ${COLUNAS_PRODUTO} FROM produtos WHERE id = ?`, [movimento.produto_id]),
      usuario: await pessoa(tx, movimento.usuario_id),
    },
  };
}

const MONTADORES = { venda: eventoVenda, venda_cancelada: eventoCancelamento, fiado_pagamento: eventoFiadoPagamento, cliente: eventoCliente, estoque: eventoEstoque };

// O serviço (quando ativo) se registra aqui pra mandar logo depois de um
// fato novo, sem esperar o ciclo de 1 min. Chamado fora da transação (com
// atraso): se ela for desfeita, o envio só não acha nada novo.
let aoNovoEvento = null;

/** Grava o evento na fila (chamar dentro da transação do fato). */
export async function enfileirar(tx, tipo, refId) {
  const { criadoEm, dados } = await MONTADORES[tipo](tx, refId);
  const quando = criadoEm || agoraIso();
  const id = novoId();
  await tx.run(
    `INSERT INTO sync_saida (id, tipo, ref_id, dados, criado_em, criado_em_ms, status) VALUES (?, ?, ?, ?, ?, ?, 'pendente')`,
    [id, tipo, refId, JSON.stringify(dados), quando, Date.parse(quando)],
  );
  if (aoNovoEvento) aoNovoEvento();
  return id;
}

/** Usado pelos serviços de venda/fiado/cliente: só faz algo em modo terminal. */
export async function registrarSeTerminal(tx, tipo, refId) {
  if (!modoTerminal()) return null;
  return enfileirar(tx, tipo, refId);
}

/**
 * Ao virar terminal: põe na fila o que aconteceu a partir da migração (o
 * backup importado é um retrato com horário `corteMs`; o que tem a mesma
 * data dele pode ou não estar lá, então entra também -- o computador
 * aplica cada coisa uma vez só: venda/lançamento que já tem, ele ignora).
 */
export async function enfileirarDesdeCorte(tx, corteMs) {
  const corte = new Date(Number(corteMs) || 0).toISOString();
  let n = 0;
  for (const v of await tx.all('SELECT id FROM vendas WHERE criado_em >= ? ORDER BY criado_em', [corte])) { await enfileirar(tx, 'venda', v.id); n += 1; }
  for (const v of await tx.all(`SELECT id FROM vendas WHERE status = 'cancelada' AND cancelada_em >= ? ORDER BY cancelada_em`, [corte])) { await enfileirar(tx, 'venda_cancelada', v.id); n += 1; }
  for (const f of await tx.all(`SELECT id FROM fiado_lancamentos WHERE tipo = 'pagamento' AND criado_em >= ? ORDER BY criado_em`, [corte])) { await enfileirar(tx, 'fiado_pagamento', f.id); n += 1; }
  for (const c of await tx.all('SELECT id FROM clientes WHERE atualizado_em >= ? ORDER BY atualizado_em', [corte])) { await enfileirar(tx, 'cliente', c.id); n += 1; }
  for (const m of await tx.all(`SELECT id FROM movimentos_estoque WHERE tipo IN ('inicial', 'entrada', 'ajuste') AND criado_em >= ? ORDER BY criado_em`, [corte])) { await enfileirar(tx, 'estoque', m.id); n += 1; }
  return n;
}

// ---------------------------------------------------------------------------
// Catálogo vindo do computador

/** O que este celular já fez e o computador ainda não confirmou: estoque (por produto) e fiado (por cliente). */
export async function pendentesNaoConfirmados(db) {
  const linhas = await db.all(`SELECT id, tipo, dados FROM sync_saida WHERE status IN ('pendente', 'enviado')`);
  const estoque = new Map();
  const fiado = new Map();
  const clientesEditados = new Set();
  const somar = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  for (const l of linhas) {
    const d = JSON.parse(l.dados);
    if (l.tipo === 'venda' || l.tipo === 'venda_cancelada') {
      for (const mv of d.movimentos || []) somar(estoque, mv.produto_id, mv.qtd_mil);
      for (const f of d.fiado || []) somar(fiado, f.cliente_id, f.valor_centavos);
    } else if (l.tipo === 'fiado_pagamento') {
      somar(fiado, d.lancamento.cliente_id, d.lancamento.valor_centavos);
    } else if (l.tipo === 'estoque') {
      somar(estoque, d.movimento.produto_id, d.movimento.qtd_mil);
    } else if (l.tipo === 'cliente') {
      clientesEditados.add(d.cliente.id);
    }
  }
  return { estoque, fiado, clientesEditados };
}

/**
 * Aplica o catálogo publicado pelo computador. Produto que não veio fica
 * inativo (nunca apagado: as vendas antigas apontam pra ele). Código de
 * barras que agora é de outro produto (o computador "ligou" um produto
 * antigo do celular a um dele na migração) sai do antigo.
 */
export async function aplicarCatalogo(banco, { versao, produtos = [], clientes = [], eventosAplicados = [] }) {
  return banco.transacao(async (tx) => {
    // O catálogo já inclui o efeito destes eventos (o computador aplicou):
    // é como se o recibo tivesse chegado -- não descontar de novo.
    for (let i = 0; i < eventosAplicados.length; i += 400) {
      const lote = eventosAplicados.slice(i, i + 400);
      await tx.run(
        `UPDATE sync_saida SET status = 'aplicado', confirmado_em = ? WHERE status IN ('pendente', 'enviado') AND id IN (${lote.map(() => '?').join(',')})`,
        [agoraIso(), ...lote],
      );
    }
    const pend = await pendentesNaoConfirmados(tx);
    const agora = agoraIso();
    const recebidos = new Set();
    // "Apelidos": produto/cliente do celular que o computador ligou a um
    // dele (mesmo código de barras / CPF-CNPJ na migração). O do celular
    // sai de cena e o que ele ainda tem pendente conta no do computador.
    const pendDe = (mapa, item) => [item.id, ...(item.apelidos || [])].reduce((s, id) => s + (mapa.get(id) || 0), 0);
    for (const p of produtos) {
      recebidos.add(p.id);
      if (p.codigo_barras) {
        await tx.run(`UPDATE produtos SET codigo_barras = NULL, ativo = 0, atualizado_em = ? WHERE codigo_barras = ? AND id != ?`, [agora, p.codigo_barras, p.id]);
      }
      const estoque = (p.estoque_mil || 0) + pendDe(pend.estoque, p);
      const existe = await tx.get('SELECT id FROM produtos WHERE id = ?', [p.id]);
      const unidade = p.unidade === 'kg' ? 'kg' : 'un';
      if (existe) {
        await tx.run(
          `UPDATE produtos SET nome = ?, nome_busca = ?, codigo_barras = ?, categoria = ?, unidade = ?, preco_centavos = ?, custo_centavos = ?,
             estoque_mil = ?, estoque_minimo_mil = ?, controla_estoque = ?, ativo = 1, atualizado_em = ? WHERE id = ?`,
          [p.nome, normalizarBusca(p.nome), p.codigo_barras || null, p.categoria || null, unidade, p.preco_centavos, p.custo_centavos || 0,
            estoque, p.estoque_minimo_mil || 0, p.controla_estoque ? 1 : 0, agora, p.id],
        );
      } else {
        await tx.run(
          `INSERT INTO produtos (id, nome, nome_busca, codigo_barras, categoria, unidade, preco_centavos, custo_centavos, estoque_mil,
             estoque_minimo_mil, controla_estoque, ativo, criado_em, atualizado_em, dispositivo_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'computador')`,
          [p.id, p.nome, normalizarBusca(p.nome), p.codigo_barras || null, p.categoria || null, unidade, p.preco_centavos, p.custo_centavos || 0,
            estoque, p.estoque_minimo_mil || 0, p.controla_estoque ? 1 : 0, agora, agora],
        );
      }
    }
    const locais = await tx.all('SELECT id FROM produtos WHERE ativo = 1');
    let desativados = 0;
    for (const { id } of locais) {
      if (!recebidos.has(id)) { await tx.run('UPDATE produtos SET ativo = 0, atualizado_em = ? WHERE id = ?', [agora, id]); desativados += 1; }
    }

    for (const c of clientes) {
      for (const apelido of c.apelidos || []) {
        if (apelido !== c.id) await tx.run('UPDATE clientes SET ativo = 0, atualizado_em = ? WHERE id = ?', [agora, apelido]);
      }
      if ([c.id, ...(c.apelidos || [])].some((id) => pend.clientesEditados.has(id))) continue; // a edição feita aqui ainda não chegou lá -- não desfaz
      const saldo = (c.saldo_fiado_centavos || 0) + pendDe(pend.fiado, c);
      const existe = await tx.get('SELECT id FROM clientes WHERE id = ?', [c.id]);
      if (existe) {
        await tx.run(
          'UPDATE clientes SET nome = ?, nome_busca = ?, telefone = ?, documento = ?, saldo_fiado_centavos = ?, ativo = ?, atualizado_em = ? WHERE id = ?',
          [c.nome, normalizarBusca(c.nome), c.telefone || null, c.documento || null, saldo, c.ativo === false ? 0 : 1, agora, c.id],
        );
      } else {
        await tx.run(
          `INSERT INTO clientes (id, nome, nome_busca, telefone, documento, saldo_fiado_centavos, limite_fiado_centavos, ativo, criado_em, atualizado_em, dispositivo_id)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'computador')`,
          [c.id, c.nome, normalizarBusca(c.nome), c.telefone || null, c.documento || null, saldo, c.ativo === false ? 0 : 1, agora, agora],
        );
      }
    }
    // Cliente que o computador não tem mais (desativado lá) sai daqui também --
    // menos o que este celular cadastrou/mexeu e o computador ainda não recebeu.
    const clientesRecebidos = new Set(clientes.flatMap((c) => [c.id, ...(c.apelidos || [])]));
    for (const { id } of await tx.all('SELECT id FROM clientes WHERE ativo = 1')) {
      if (!clientesRecebidos.has(id) && !pend.clientesEditados.has(id) && !pend.fiado.has(id)) {
        await tx.run('UPDATE clientes SET ativo = 0, atualizado_em = ? WHERE id = ?', [agora, id]);
      }
    }
    const info = { versao, aplicadoEmMs: agoraMs(), produtos: produtos.length, clientes: clientes.length, desativados };
    await gravarConfig(tx, 'terminal_catalogo', info);
    return info;
  });
}

// ---------------------------------------------------------------------------
// Serviço (rede)

export class ServicoTerminal {
  constructor({ db, nuvem, licenca, atrasoAposFatoMs = 1500 }) {
    this.db = db;
    this.atrasoAposFatoMs = atrasoAposFatoMs;
    this.nuvem = nuvem;
    this.licenca = licenca;
    this.ativo = false;
    this.servidorId = null;
    this.paradas = [];
    this.timer = null;
    this.enviando = null;
    this.ouvintes = new Set();
    this.ultimoRelato = null;
    this.ultimoErroRede = null;
  }

  aoMudar(fn) { this.ouvintes.add(fn); return () => this.ouvintes.delete(fn); }
  #avisar() { for (const fn of this.ouvintes) { try { fn(); } catch { /* tela desmontada */ } } }

  iniciar() {
    if (this.desligarLicenca) return Promise.resolve();
    this.desligarLicenca = this.licenca.aoMudar(() => { this.sincronizarModo().catch((err) => console.error('[terminal] troca de modo falhou', err)); });
    return this.sincronizarModo();
  }

  /** Liga/desliga o modo conforme o que a Central mandou (estado da licença). Uma troca por vez. */
  sincronizarModo() {
    const proxima = (this.fila || Promise.resolve()).catch(() => {}).then(() => this.#sincronizarModo());
    this.fila = proxima;
    return proxima;
  }

  async #sincronizarModo() {
    const lic = this.licenca.estado;
    const querTerminal = !!(lic?.ativado && lic.modoOperacao === 'terminal' && lic.servidorInstallId);
    definirContexto({ modoTerminal: querTerminal, servidorNome: querTerminal ? (lic.servidorNome || 'computador') : null });
    if (querTerminal && (!this.ativo || this.servidorId !== lic.servidorInstallId)) {
      await this.#ativar(lic);
    } else if (!querTerminal && this.ativo) {
      this.#desligarEscutas();
      this.ativo = false;
      this.servidorId = null;
      // Se um dia voltar a ser terminal, o que for feito a partir de agora
      // (autônomo) vai junto no atraso.
      await this.db.transacao(async (tx) => {
        await gravarConfig(tx, 'terminal_saiu_em_ms', agoraMs());
        await tx.run(`DELETE FROM config WHERE chave = 'terminal_backlog_feito'`);
      });
      this.#avisar();
    }
    if (!querTerminal) this.#drenarSeSobrou();
  }

  /**
   * Voltou a autônomo com algo ainda na fila (sem internet na hora em que
   * a Central mudou): continua mandando até esvaziar -- a Central mantém o
   * vínculo com o computador justamente pra isso chegar lá.
   */
  async #drenarSeSobrou() {
    if (this.timerDreno || !(await this.#temPendente())) return;
    this.timerDreno = setInterval(async () => {
      if (this.ativo || !(await this.#temPendente())) { clearInterval(this.timerDreno); this.timerDreno = null; return; }
      this.enviarPendentes().catch(() => {});
    }, INTERVALO_ENVIO_MS);
    this.enviarPendentes().catch(() => {});
  }

  async #temPendente() {
    return (await this.db.valor(`SELECT COUNT(*) FROM sync_saida WHERE status = 'pendente'`)) > 0;
  }

  async #ativar(lic) {
    this.#desligarEscutas();
    // Primeira vez como terminal DESTE computador: põe na fila o que
    // aconteceu depois da migração.
    const feito = await lerConfig(this.db, 'terminal_backlog_feito', null);
    if (feito !== lic.servidorInstallId) {
      // Corte: a migração (o que veio antes está no computador) ou, se já
      // foi terminal e voltou a autônomo, a saída (antes disso já foi
      // mandado como terminal). O mais recente dos dois.
      const saiuEm = Number(await lerConfig(this.db, 'terminal_saiu_em_ms', 0)) || 0;
      await this.db.transacao(async (tx) => {
        const n = await enfileirarDesdeCorte(tx, Math.max(Number(lic.migradoCorteMs) || 0, saiuEm));
        await gravarConfig(tx, 'terminal_backlog_feito', lic.servidorInstallId);
        await gravarConfig(tx, 'terminal_desde_ms', agoraMs());
        return n;
      });
    }
    this.ativo = true;
    this.servidorId = lic.servidorInstallId;
    const id = lic.installId;
    this.paradas.push(this.nuvem.escutarAcksTerminal(id, (acks) => { this.#processarAcks(acks).catch((err) => console.error('[terminal] confirmação falhou', err)); }));
    this.paradas.push(this.nuvem.escutarCatalogoTerminal(id, (meta) => { this.#aoReceberMetaCatalogo(meta).catch((err) => console.error('[terminal] catálogo falhou', err)); }));
    this.timer = setInterval(() => { this.enviarPendentes().catch(() => {}); }, INTERVALO_ENVIO_MS);
    if (this.atrasoAposFatoMs != null) {
      aoNovoEvento = () => {
        clearTimeout(this.timerFato);
        this.timerFato = setTimeout(() => { this.enviarPendentes().catch(() => {}); }, this.atrasoAposFatoMs);
      };
    }
    this.#avisar();
    this.enviarPendentes().catch(() => {});
  }

  #desligarEscutas() {
    for (const p of this.paradas) { try { p(); } catch { /* já parada */ } }
    this.paradas = [];
    clearInterval(this.timer);
    this.timer = null;
    clearTimeout(this.timerFato);
    aoNovoEvento = null;
  }

  parar() {
    this.#desligarEscutas();
    clearInterval(this.timerDreno);
    this.timerDreno = null;
    if (this.desligarLicenca) { this.desligarLicenca(); this.desligarLicenca = null; }
  }

  /** Sobe a fila (na ordem em que os fatos aconteceram). Um envio por vez. */
  enviarPendentes() {
    if (!this.enviando) this.enviando = this.#enviar().finally(() => { this.enviando = null; });
    return this.enviando;
  }

  async #enviar() {
    // Mesmo depois de voltar a autônomo, o que ficou na fila ainda sobe
    // (é o computador quem decide se aceita) -- nada fica perdido no celular.
    const installId = this.licenca.estado?.installId;
    if (!installId) return { enviados: 0 };
    let enviados = 0;
    for (;;) {
      const lote = await this.db.all(`SELECT * FROM sync_saida WHERE status = 'pendente' ORDER BY criado_em_ms, rowid LIMIT ?`, [LOTE_ENVIO]);
      if (lote.length === 0) break;
      for (const ev of lote) {
        try {
          await this.nuvem.enviarEventoTerminal(installId, {
            id: ev.id, tipo: ev.tipo, versao: VERSAO_EVENTO, refId: ev.ref_id, criadoEmMs: ev.criado_em_ms,
            dadosJson: ev.dados, tentativa: ev.tentativas + 1,
          });
        } catch (err) {
          this.ultimoErroRede = String(err?.message || err);
          await this.db.run('UPDATE sync_saida SET tentativas = tentativas + 1 WHERE id = ?', [ev.id]);
          await this.#relatar();
          this.#avisar();
          return { enviados, erro: this.ultimoErroRede };
        }
        await this.db.run(`UPDATE sync_saida SET status = 'enviado', enviado_em = ?, tentativas = tentativas + 1, erro = NULL WHERE id = ? AND status = 'pendente'`, [agoraIso(), ev.id]);
        enviados += 1;
      }
    }
    this.ultimoErroRede = null;
    if (enviados) await gravarConfig(this.db, 'terminal_ultimo_envio_ms', agoraMs());
    await this.#relatar();
    this.#avisar();
    return { enviados };
  }

  async #processarAcks(acks) {
    const installId = this.licenca.estado?.installId;
    for (const a of acks) {
      const status = ['aplicado', 'ignorado', 'erro'].includes(a.status) ? a.status : null;
      if (status) {
        await this.db.run(
          `UPDATE sync_saida SET status = ?, erro = ?, resultado = ?, confirmado_em = ? WHERE id = ?`,
          [status, status === 'erro' ? String(a.erro || 'Erro no computador') : null, a.resultadoJson || null, agoraIso(), a.id],
        );
      }
      await this.nuvem.apagarAckTerminal(installId, a.id).catch(() => {});
    }
    if (acks.length) { await this.#relatar(); this.#avisar(); }
  }

  async #aoReceberMetaCatalogo(meta) {
    if (!meta?.versao) return;
    const atual = await lerConfig(this.db, 'terminal_catalogo', null);
    if (atual?.versao === meta.versao) return;
    const catalogo = await this.nuvem.lerCatalogoTerminal(this.licenca.estado.installId, meta);
    await aplicarCatalogo(this.db, { versao: meta.versao, ...catalogo });
    this.#avisar();
  }

  /** O computador recusou um evento: depois de corrigir lá (ou se foi falha passageira), manda de novo. */
  async tentarNovamente(eventoId) {
    await this.db.run(`UPDATE sync_saida SET status = 'pendente', erro = NULL WHERE id = ? AND status = 'erro'`, [eventoId]);
    this.#avisar();
    return this.enviarPendentes();
  }

  async resumo() {
    const cont = await this.db.all('SELECT status, COUNT(*) AS n FROM sync_saida GROUP BY status');
    const n = Object.fromEntries(cont.map((c) => [c.status, c.n]));
    const erros = await this.db.all(`SELECT id, tipo, ref_id, erro, criado_em FROM sync_saida WHERE status = 'erro' ORDER BY criado_em_ms DESC LIMIT 20`);
    return {
      ativo: this.ativo,
      servidorNome: ctx().servidorNome,
      pendentes: (n.pendente || 0) + (n.enviado || 0),
      naoEnviados: n.pendente || 0,
      confirmados: (n.aplicado || 0) + (n.ignorado || 0),
      erros,
      ultimoEnvioMs: await lerConfig(this.db, 'terminal_ultimo_envio_ms', null),
      catalogo: await lerConfig(this.db, 'terminal_catalogo', null),
      ultimoErroRede: this.ultimoErroRede,
    };
  }

  /** Situação de envio de uma venda (pra lista de vendas e o recibo). */
  async situacaoDaVenda(vendaId) {
    const linhas = await this.db.all('SELECT tipo, status, erro, resultado FROM sync_saida WHERE ref_id = ? ORDER BY criado_em_ms', [vendaId]);
    return linhas.map((l) => ({ ...l, resultado: l.resultado ? JSON.parse(l.resultado) : null }));
  }

  /** Conta na Central quanto falta subir (a Central não deixa "voltar a autônomo" com coisa pendente). */
  async #relatar() {
    const installId = this.licenca.estado?.installId;
    if (!installId) return;
    const cont = await this.db.all(`SELECT status, COUNT(*) AS n FROM sync_saida WHERE status IN ('pendente', 'enviado', 'erro') GROUP BY status`);
    const n = Object.fromEntries(cont.map((c) => [c.status, c.n]));
    const relato = { terminalPendentes: (n.pendente || 0) + (n.enviado || 0), terminalErros: n.erro || 0 };
    const chave = JSON.stringify(relato);
    if (chave === this.ultimoRelato) return;
    try {
      await this.nuvem.atualizarInstalacao(installId, { ...relato, terminalRelatoEm: AGORA_SERVIDOR });
      this.ultimoRelato = chave;
    } catch { /* sem rede: relata na próxima */ }
  }
}
