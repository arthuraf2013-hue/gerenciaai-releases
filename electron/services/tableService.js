const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const saleService = require('./saleService');

// ---------------------------------------------------------------- grupos de mesas
// Mesas unidas (juntarMesas): a PRINCIPAL é dona da comanda; cada unida tem
// `unida_a_mesa_id` = principal, o mesmo `sale_id` e status 'ocupada'. As
// unidas apontam SEMPRE direto para a principal (juntarMesas achata grupos),
// então achar a principal é no máximo um salto. Toda consulta que liga mesa a
// comanda por `sale_id` precisa filtrar `unida_a_mesa_id IS NULL`, senão o
// mesmo item aparece uma vez por mesa do grupo (ver kitchenService).

const LIMITE_NOME_PESSOA = 40;

function mesaPorId(db, id) {
  return db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(id);
}

function principalDe(db, table) {
  if (!table?.unida_a_mesa_id) return table;
  return mesaPorId(db, table.unida_a_mesa_id) || table;
}

function membrosDe(db, principalId) {
  return db.prepare(
    'SELECT * FROM restaurant_tables WHERE unida_a_mesa_id = ? ORDER BY CAST(numero AS INTEGER), numero'
  ).all(principalId);
}

/** Libera a principal e todas as unidas a ela de uma vez. */
const mesaLocal = () => require('./mesaLocalService');

function liberarGrupo(db, principalId, status) {
  const doGrupo = db.prepare('SELECT id FROM restaurant_tables WHERE id = ? OR unida_a_mesa_id = ?').all(principalId, principalId).map((m) => m.id);
  mesaLocal().esquecerMembros(db, doGrupo); // o próximo grupo começa sem integrantes
  try { // mesa fechou: os chamados dela acabaram
    const upd = db.prepare("UPDATE mesa_chamados SET atendido_em = datetime('now') WHERE table_id = ? AND atendido_em IS NULL");
    for (const id of doGrupo) upd.run(id);
  } catch { /* banco sem a tabela */ }
  db.prepare(
    `UPDATE restaurant_tables SET status = ?, sale_id = NULL, pessoas = NULL, unida_a_mesa_id = NULL
     WHERE id = ? OR unida_a_mesa_id = ?`
  ).run(status, principalId, principalId);
}

/**
 * Mesa presa em comanda que já fechou: a venda da mesa foi finalizada (ou
 * cancelada) mas a mesa continuou "ocupada" apontando para ela -- por
 * exemplo, a conta foi paga e alguém clicou "Voltar ao pedido" em vez de
 * "Concluir". Aí a mesa não limpa, e pagar de novo dá "Esta venda não está
 * mais aberta". Paga -> "aguardando limpeza"; cancelada -> "livre".
 * Roda antes de listar e de abrir. Devolve quantas mesas consertou.
 */
function repararMesasComVendaFechada(db, locationId = null) {
  const presas = db.prepare(
    `SELECT t.id, s.status FROM restaurant_tables t JOIN sales s ON s.id = t.sale_id
     WHERE t.status = 'ocupada' AND t.unida_a_mesa_id IS NULL AND s.status IN ('finalizada', 'cancelada', 'transferida')
       ${locationId ? 'AND t.location_id = ?' : ''}`
  ).all(...(locationId ? [locationId] : []));
  for (const m of presas) liberarGrupo(db, m.id, m.status === 'cancelada' ? 'livre' : 'aguardando_limpeza');
  return presas.length;
}

/** Venda finalizada que é a comanda de uma mesa: libera a mesa (e as unidas) na hora. */
function liberarMesaDaVenda(saleId) {
  const db = getDb();
  const venda = db.prepare('SELECT status FROM sales WHERE id = ?').get(saleId);
  if (!venda || venda.status !== 'finalizada') return { ok: true, liberou: false };
  const mesa = db.prepare(`SELECT id FROM restaurant_tables WHERE sale_id = ? AND unida_a_mesa_id IS NULL AND status = 'ocupada'`).get(saleId);
  if (!mesa) return { ok: true, liberou: false };
  liberarGrupo(db, mesa.id, 'aguardando_limpeza');
  return { ok: true, liberou: true };
}

function rotuloMesa(t) {
  return t.nome || `Mesa ${t.numero}`;
}

/**
 * Conserta mesa "unida" que perdeu o grupo: a principal não existe mais, não
 * está ocupada, está com outra comanda, ou a própria unida não está ocupada.
 * Nenhum caminho atual deixa isso (fechar, desocupar, transferir e separar
 * soltam o grupo inteiro), mas banco antigo, restauração de backup ou edição
 * manual podem deixar -- e aí a mesa fica presa: aparece "unida" a uma mesa
 * livre, sem comanda para abrir e sem ter de onde separar.
 *   - unida apontando para outra unida (grupo não achatado): passa a apontar
 *     para a principal de verdade, se ela estiver com a mesma comanda;
 *   - unida ocupada com uma comanda ABERTA que nenhuma outra mesa segura:
 *     vira a principal dessa comanda (nunca deixa comanda aberta sem mesa);
 *   - unida ocupada sem comanda aberta: vai para "aguardando limpeza";
 *   - unida em outro status: só sai do grupo.
 * Roda antes de listar e antes de abrir/juntar; só escreve se achar algo.
 * Devolve quantas mesas consertou.
 */
function repararMesasUnidas(db, locationId = null) {
  const suspeitas = db.prepare(
    `SELECT t.*, p.id AS p_id, p.status AS p_status, p.sale_id AS p_sale_id, p.unida_a_mesa_id AS p_unida
     FROM restaurant_tables t
     LEFT JOIN restaurant_tables p ON p.id = t.unida_a_mesa_id
     WHERE t.unida_a_mesa_id IS NOT NULL
       AND (? IS NULL OR t.location_id = ?)
       AND (p.id IS NULL OR p.unida_a_mesa_id IS NOT NULL OR p.status != 'ocupada' OR p.sale_id IS NULL
            OR t.status != 'ocupada' OR t.sale_id IS NULL OR t.sale_id != p.sale_id)`
  ).all(locationId, locationId);
  if (suspeitas.length === 0) return 0;

  let consertadas = 0;
  db.transaction(() => {
    for (const t of suspeitas) {
      const atual = mesaPorId(db, t.id);
      if (!atual?.unida_a_mesa_id) continue; // já consertada nesta passada

      // Grupo não achatado: a principal da principal segura a mesma comanda.
      if (t.p_unida && atual.status === 'ocupada' && atual.sale_id) {
        const raiz = mesaPorId(db, t.p_unida);
        if (raiz && !raiz.unida_a_mesa_id && raiz.status === 'ocupada' && raiz.sale_id === atual.sale_id) {
          db.prepare('UPDATE restaurant_tables SET unida_a_mesa_id = ?, pessoas = NULL WHERE id = ?').run(raiz.id, atual.id);
          consertadas += 1;
          continue;
        }
      }

      const antiga = t.p_id ? mesaPorId(db, t.p_id) : null;
      let destino;
      if (atual.status === 'ocupada' && atual.sale_id) {
        const venda = db.prepare('SELECT status FROM sales WHERE id = ?').get(atual.sale_id);
        const outraSegura = db.prepare(
          `SELECT 1 FROM restaurant_tables WHERE sale_id = ? AND id != ? AND unida_a_mesa_id IS NULL AND status = 'ocupada'`
        ).get(atual.sale_id, atual.id);
        if (venda?.status === 'aberta' && !outraSegura) {
          db.prepare('UPDATE restaurant_tables SET unida_a_mesa_id = NULL WHERE id = ?').run(atual.id);
          destino = 'ficou com a comanda dela';
        } else {
          db.prepare(
            `UPDATE restaurant_tables SET status = 'aguardando_limpeza', sale_id = NULL, pessoas = NULL, unida_a_mesa_id = NULL WHERE id = ?`
          ).run(atual.id);
          destino = 'foi para aguardando limpeza';
        }
      } else {
        const status = atual.status === 'ocupada' ? 'aguardando_limpeza' : atual.status;
        db.prepare(
          'UPDATE restaurant_tables SET status = ?, sale_id = NULL, pessoas = NULL, unida_a_mesa_id = NULL WHERE id = ?'
        ).run(status, atual.id);
        destino = status === 'aguardando_limpeza' ? 'foi para aguardando limpeza' : 'saiu do grupo';
      }
      registrarAuditoria(db, {
        tipo: 'mesa_separada', saleId: atual.sale_id, solicitanteId: null,
        motivo: `${rotuloMesa(atual)} separada automaticamente: estava unida a ${antiga ? rotuloMesa(antiga) : 'uma mesa que não existe mais'}, que não estava com a comanda do grupo (${destino})`,
      });
      consertadas += 1;
    }
  })();
  if (consertadas > 0) console.warn(`[tableService] ${consertadas} mesa(s) unida(s) sem grupo consertada(s).`);
  return consertadas;
}

function registrarAuditoria(db, { tipo, saleId, solicitanteId, motivo }) {
  const existe = solicitanteId && db.prepare('SELECT id FROM users WHERE id = ?').get(solicitanteId);
  db.prepare(
    'INSERT INTO audit_log (id, tipo_evento, sale_id, solicitante_id, motivo, sucesso) VALUES (?, ?, ?, ?, ?, 1)'
  ).run(randomUUID(), tipo, saleId || null, existe ? solicitanteId : null, motivo);
}

function recalcularTotal(db, saleId) {
  db.prepare(
    `UPDATE sales SET total = (SELECT COALESCE(SUM(preco_unitario * quantidade), 0) FROM sale_items WHERE sale_id = ? AND cancelado = 0)
     WHERE id = ?`
  ).run(saleId, saleId);
}

// ---------------------------------------------------------------- pessoas da comanda
// As pessoas são VAGAS numeradas 1..N da comanda (sale_items.pessoa_numero
// aponta para elas); `sale_people` só guarda o NOME de quem tem nome. N é o
// maior entre o número informado na mesa, a maior pessoa com nome e a maior
// pessoa com item -- nunca some uma pessoa que já tem item ou nome.

function totalDePessoas(db, saleId, pessoasDaMesa) {
  const comNome = db.prepare('SELECT MAX(numero) AS m FROM sale_people WHERE sale_id = ?').get(saleId).m || 0;
  const comItem = db.prepare('SELECT MAX(pessoa_numero) AS m FROM sale_items WHERE sale_id = ? AND cancelado = 0').get(saleId).m || 0;
  return Math.max(Number(pessoasDaMesa) || 0, comNome, comItem);
}

function listarPessoas(db, saleId, pessoasDaMesa) {
  const total = totalDePessoas(db, saleId, pessoasDaMesa);
  const linhas = new Map(db.prepare(
    `SELECT sp.numero, sp.nome, sp.customer_id, c.nome AS cliente_nome
     FROM sale_people sp LEFT JOIN customers c ON c.id = sp.customer_id WHERE sp.sale_id = ?`
  ).all(saleId).map((p) => [p.numero, p]));
  return Array.from({ length: total }, (_, i) => {
    const p = linhas.get(i + 1);
    return { numero: i + 1, nome: p?.nome || null, clienteId: p?.customer_id || null, clienteNome: p?.customer_id ? p.cliente_nome : null };
  });
}

function limparNome(nome) {
  const texto = String(nome ?? '').replace(/\s+/g, ' ').trim();
  return texto ? texto.slice(0, LIMITE_NOME_PESSOA) : null;
}

/** Comanda (e mesa principal) de qualquer mesa do grupo. */
function comandaDaMesa(db, tableId) {
  const table = mesaPorId(db, tableId);
  if (!table) return { erro: 'Mesa não encontrada.' };
  const principal = principalDe(db, table);
  if (principal.status !== 'ocupada' || !principal.sale_id) return { erro: 'A mesa não está ocupada.' };
  return { principal, saleId: principal.sale_id };
}

function numeroDePessoaValido(numero, total) {
  const n = Number(numero);
  return Number.isInteger(n) && n >= 1 && n <= total ? n : null;
}

/** Lista as mesas de um local, com o total atual da comanda (se ocupada). */
function listTables(locationId) {
  const db = getDb();
  repararMesasComVendaFechada(db, locationId);
  repararMesasUnidas(db, locationId);
  const mesas = db.prepare(
    `SELECT t.*, s.total as total_atual, s.criado_em as aberta_em,
            p.numero as unida_a_numero, p.nome as unida_a_nome
     FROM restaurant_tables t
     LEFT JOIN sales s ON s.id = t.sale_id
     LEFT JOIN restaurant_tables p ON p.id = t.unida_a_mesa_id
     WHERE t.location_id = ?
     ORDER BY (t.ordem IS NULL), t.ordem, CAST(t.numero AS INTEGER), t.numero`
  ).all(locationId);
  // Na principal: os números das mesas unidas a ela ("4 + 5"), na ordem da lista.
  const unidas = new Map();
  for (const m of mesas) {
    if (!m.unida_a_mesa_id) continue;
    if (!unidas.has(m.unida_a_mesa_id)) unidas.set(m.unida_a_mesa_id, []);
    unidas.get(m.unida_a_mesa_id).push(m.numero);
  }
  // Indicadores do QR no quadrado: chamados, pedidos esperando, celulares na mesa.
  let indicadores = new Map();
  try { indicadores = mesaLocal().indicadoresDasMesas(db, mesas); } catch (err) { console.error('[mesas] indicadores', err?.message || err); }
  return mesas.map((m) => ({
    ...m, mesas_unidas: unidas.has(m.id) ? unidas.get(m.id).join(' + ') : null,
    indicadores: (!m.unida_a_mesa_id && indicadores.get(m.id)) || null,
  }));
}

function createTable({ locationId, numero, nome }) {
  if (!numero || !String(numero).trim()) return { ok: false, error: 'Informe o número/nome da mesa.' };
  const db = getDb();
  const numeroLimpo = String(numero).trim();
  const existe = db.prepare('SELECT id FROM restaurant_tables WHERE location_id = ? AND numero = ?').get(locationId, numeroLimpo);
  if (existe) return { ok: false, error: 'Já existe uma mesa com esse número.' };

  const id = randomUUID();
  db.prepare(`INSERT INTO restaurant_tables (id, location_id, numero, nome, status) VALUES (?, ?, ?, ?, 'livre')`)
    .run(id, locationId, numeroLimpo, nome?.trim() || null);
  return { ok: true, id };
}

/**
 * Primeira faixa de números livres: o menor número (só dígitos) que não
 * está em uso e quantos seguidos estão livres a partir dele. Se as mesas
 * 1 e 2 foram excluídas e existem 3 a 22, é { numero: 1, buracos: 2 };
 * sem buraco, é o próximo depois da maior e `buracos` é 0.
 */
function proximaFaixaLivre(locationId) {
  const db = getDb();
  const usados = new Set(
    db.prepare('SELECT numero FROM restaurant_tables WHERE location_id = ?').all(locationId)
      .map((r) => String(r.numero).trim()).filter((n) => /^\d+$/.test(n)).map(Number)
  );
  if (!usados.size) return { numero: 1, buracos: 0 };
  const maior = Math.max(...usados);
  let n = 1;
  while (usados.has(n)) n += 1;
  if (n > maior) return { numero: n, buracos: 0 };
  let buracos = 0;
  while (n + buracos < maior && !usados.has(n + buracos)) buracos += 1;
  return { numero: n, buracos };
}

/** Próximo número livre: o menor que não está em uso (preenche mesa excluída antes de ir para o fim). */
function proximoNumeroDeMesa(locationId) {
  return proximaFaixaLivre(locationId).numero;
}

const MAX_MESAS_POR_VEZ = 200;

/**
 * Cadastro rápido: informa quantas mesas e de que número começa
 * (padrão: o próximo depois da maior que já existe). Número que já
 * existe é pulado -- não para tudo nem duplica. Tudo numa transação.
 */
function createTablesEmLote({ locationId, quantidade, inicio } = {}) {
  const qtd = Number(quantidade);
  if (!Number.isInteger(qtd) || qtd < 1) return { ok: false, error: 'Informe quantas mesas cadastrar.' };
  if (qtd > MAX_MESAS_POR_VEZ) return { ok: false, error: `No máximo ${MAX_MESAS_POR_VEZ} mesas de uma vez.` };
  if (!locationId) return { ok: false, error: 'Local não informado.' };
  const primeiro = inicio === undefined || inicio === null || inicio === '' ? proximoNumeroDeMesa(locationId) : Number(inicio);
  if (!Number.isInteger(primeiro) || primeiro < 1 || primeiro + qtd - 1 > 9999) {
    return { ok: false, error: 'Número inicial inválido (de 1 a 9999).' };
  }
  const db = getDb();
  const criadas = [];
  const jaExistiam = [];
  db.transaction(() => {
    const existe = db.prepare('SELECT 1 FROM restaurant_tables WHERE location_id = ? AND numero = ?');
    const inserir = db.prepare(`INSERT INTO restaurant_tables (id, location_id, numero, status) VALUES (?, ?, ?, 'livre')`);
    for (let n = primeiro; n < primeiro + qtd; n++) {
      const numero = String(n);
      if (existe.get(locationId, numero)) { jaExistiam.push(numero); continue; }
      inserir.run(randomUUID(), locationId, numero);
      criadas.push(numero);
    }
  })();
  return { ok: true, criadas, jaExistiam };
}

/**
 * Organizar a tela: grava a posição de cada mesa na ordem em que vieram.
 * `ids` vazio/ausente volta tudo para a ordem por número. Mesa de outro
 * local ou id que não existe é ignorado; mesa que ficou de fora da lista
 * vai para o fim (não some).
 */
function reorderTables({ locationId, ids } = {}) {
  if (!locationId) return { ok: false, error: 'Local não informado.' };
  const db = getDb();
  if (ids === undefined || ids === null || (Array.isArray(ids) && ids.length === 0)) {
    db.prepare('UPDATE restaurant_tables SET ordem = NULL WHERE location_id = ?').run(locationId);
    return { ok: true };
  }
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) return { ok: false, error: 'Ordem inválida.' };
  db.transaction(() => {
    const doLocal = new Set(db.prepare('SELECT id FROM restaurant_tables WHERE location_id = ?').all(locationId).map((r) => r.id));
    const ordem = [...new Set(ids)].filter((i) => doLocal.has(i));
    const resto = db.prepare(
      'SELECT id FROM restaurant_tables WHERE location_id = ? ORDER BY (ordem IS NULL), ordem, CAST(numero AS INTEGER), numero'
    ).all(locationId).map((r) => r.id).filter((i) => !ordem.includes(i));
    const gravar = db.prepare('UPDATE restaurant_tables SET ordem = ? WHERE id = ?');
    [...ordem, ...resto].forEach((id, i) => gravar.run(i + 1, id));
  })();
  return { ok: true };
}

function deleteTable(tableId) {
  const db = getDb();
  const table = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(tableId);
  if (!table) return { ok: false, error: 'Mesa não encontrada.' };
  if (table.status !== 'livre') return { ok: false, error: 'Só é possível excluir uma mesa livre.' };
  db.prepare('DELETE FROM restaurant_tables WHERE id = ?').run(tableId);
  return { ok: true };
}

/** Abre a mesa — cria uma comanda nova pra ela, ou devolve a que já
 * estava em andamento (ex: reabrir a mesma mesa depois de navegar pra
 * outra tela). Só permite abrir mesa livre ou reservada (chegou o
 * grupo que tinha reservado) — não dá pra abrir uma que ainda está
 * aguardando limpeza. */
function openTable({ tableId, locationId, operadorId, pessoas }) {
  const db = getDb();
  repararMesasComVendaFechada(db);
  repararMesasUnidas(db);
  const table = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(tableId);
  if (!table) return { ok: false, error: 'Mesa não encontrada.' };

  if (table.unida_a_mesa_id) {
    const principal = principalDe(db, table);
    return { ok: true, saleId: principal.sale_id, principalId: principal.id };
  }
  if (table.status === 'ocupada' && table.sale_id) {
    return { ok: true, saleId: table.sale_id };
  }
  if (table.status === 'aguardando_limpeza') {
    const foi = destinoDaTransferencia(db, table);
    if (foi) return { ok: false, error: `A comanda de ${rotuloMesa(table)} foi transferida para ${rotuloMesa(foi)}.`, transferidaPara: foi.id };
    return { ok: false, error: 'Essa mesa ainda está aguardando limpeza — marque como limpa antes de abrir de novo.' };
  }

  const { id: saleId } = saleService.openSale({ locationId, operadorId });
  db.prepare(`UPDATE restaurant_tables SET status = 'ocupada', sale_id = ?, pessoas = ?, reservado_para = NULL, transferida_para_id = NULL WHERE id = ?`)
    .run(saleId, pessoas ? Number(pessoas) : null, tableId);
  // Quem já tinha entrado na mesa pelo QR (celular) vira pessoa da comanda.
  mesaLocal().incluirMembrosPendentes(db, tableId, saleId);
  return { ok: true, saleId };
}

/** Devolve os itens e o total já lançados na comanda da mesa — pra
 * reconstruir o carrinho ao reabrir uma mesa que já estava ocupada. */
function getTableCart(saleId) {
  const db = getDb();
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { items: [], total: 0 };

  const items = db.prepare(
    `SELECT si.*, p.nome, p.unidade FROM sale_items si JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ? AND si.cancelado = 0 ORDER BY si.criado_em`
  ).all(saleId);

  const principal = db.prepare('SELECT * FROM restaurant_tables WHERE sale_id = ? AND unida_a_mesa_id IS NULL').get(saleId);
  const resumoMesa = (t) => ({ id: t.id, numero: t.numero, nome: t.nome || null });

  // Quanto cada pessoa já pagou da parte dela (pagamento individual).
  const pagoPorPessoa = {};
  for (const r of db.prepare(
    `SELECT spp.pessoa_numero AS n, SUM(p.valor) AS v FROM sale_person_payments spp
     JOIN payments p ON p.id = spp.payment_id WHERE spp.sale_id = ? GROUP BY spp.pessoa_numero`
  ).all(saleId)) pagoPorPessoa[r.n] = r.v;
  const totalPago = db.prepare('SELECT COALESCE(SUM(valor), 0) AS t FROM payments WHERE sale_id = ?').get(saleId).t;

  return {
    total: sale.total,
    taxaServicoPercentual: sale.taxa_servico_percentual || 0,
    desconto: (sale.desconto || 0) + (sale.desconto_gerente || 0),
    totalPago,
    pagoPorPessoa,
    pessoas: listarPessoas(db, saleId, principal?.pessoas),
    grupo: principal ? { principal: resumoMesa(principal), unidas: membrosDe(db, principal.id).map(resumoMesa) } : null,
    items: items.map((i) => ({
      id: i.id, nome: i.nome, quantidade: i.quantidade, precoUnitario: i.preco_unitario, cancelado: false,
      observacao: i.observacao || '', pessoaNumero: i.pessoa_numero || null,
      ajustavel: saleService.itemAjustavel(db, i, { unidade: i.unidade }),
    })),
  };
}

/** Libera a mesa depois que a comanda é paga — vai pra "aguardando
 * limpeza" em vez de direto pra "livre", já que normalmente alguém
 * precisa limpar a mesa antes do próximo cliente sentar. */
function releaseTable(tableId) {
  const db = getDb();
  const table = mesaPorId(db, tableId);
  if (!table) return { ok: false, error: 'Mesa não encontrada.' };
  // Fechar a conta de um grupo (pela principal ou por qualquer unida) libera todas.
  liberarGrupo(db, principalDe(db, table).id, 'aguardando_limpeza');
  return { ok: true };
}

/** Confirma que a mesa foi limpa — volta a ficar disponível. */
function markCleaned(tableId) {
  const db = getDb();
  const table = db.prepare('SELECT status FROM restaurant_tables WHERE id = ?').get(tableId);
  if (!table) return { ok: false, error: 'Mesa não encontrada.' };
  if (table.status !== 'aguardando_limpeza') return { ok: false, error: 'Essa mesa não está aguardando limpeza.' };
  db.prepare(`UPDATE restaurant_tables SET status = 'livre', sale_id = NULL, pessoas = NULL, unida_a_mesa_id = NULL, transferida_para_id = NULL WHERE id = ?`).run(tableId);
  mesaLocal().esquecerMembros(db, [tableId]);
  return { ok: true };
}

/** Marca uma mesa livre como reservada — pra guardar pra um horário
 * combinado sem deixar ela disponível pra outro grupo sentar. */
function markReserved(tableId, reservadoPara) {
  const db = getDb();
  const table = db.prepare('SELECT status FROM restaurant_tables WHERE id = ?').get(tableId);
  if (!table) return { ok: false, error: 'Mesa não encontrada.' };
  if (table.status !== 'livre') return { ok: false, error: 'Só é possível reservar uma mesa livre.' };
  db.prepare(`UPDATE restaurant_tables SET status = 'reservada', reservado_para = ? WHERE id = ?`).run(reservadoPara || null, tableId);
  return { ok: true };
}

/** Cancela uma reserva — volta a ficar livre pra qualquer grupo. */
function cancelReservation(tableId) {
  const db = getDb();
  const table = db.prepare('SELECT status FROM restaurant_tables WHERE id = ?').get(tableId);
  if (!table) return { ok: false, error: 'Mesa não encontrada.' };
  if (table.status !== 'reservada') return { ok: false, error: 'Essa mesa não está reservada.' };
  db.prepare(`UPDATE restaurant_tables SET status = 'livre', reservado_para = NULL, unida_a_mesa_id = NULL WHERE id = ?`).run(tableId);
  return { ok: true };
}

/** Transfere a comanda inteira de uma mesa ocupada pra outra mesa livre
 * — pro caso do grupo pedir pra mudar de lugar. A mesa de origem vai
 * pra "aguardando limpeza" (alguém sentou lá, precisa limpar antes do
 * próximo grupo), a de destino assume a comanda como se tivesse sido
 * aberta ali desde o início (mesmos itens, mesmo total, mesma hora de
 * abertura, mesmas pessoas e contas por pessoa).
 *
 * Junto com a comanda vão:
 *   - os pedidos do QR/WhatsApp ainda não lançados (mesa_numero);
 *   - o "endereço" da mesa antiga (transferida_para_id): um pedido que
 *     ainda chegue para ela (cliente com a página do QR aberta) entra na
 *     mesa nova, e o celular do garçom recebe "foi para a Mesa X".
 * Mesa sendo paga em outro caixa não muda de lugar. */
function transferTable({ fromTableId, toTableId, operadorId = null }) {
  const db = getDb();
  if (!fromTableId || !toTableId) return { ok: false, error: 'Escolha a mesa de destino.' };
  if (fromTableId === toTableId) return { ok: false, error: 'Escolha outra mesa para transferir.' };
  repararMesasComVendaFechada(db);
  repararMesasUnidas(db);
  const from = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(fromTableId);
  const to = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(toTableId);
  if (!from || !to) return { ok: false, error: 'Mesa não encontrada.' };
  if (from.location_id !== to.location_id) return { ok: false, error: 'As duas mesas precisam ser do mesmo local.' };
  if (from.unida_a_mesa_id || membrosDe(db, from.id).length > 0) {
    return { ok: false, error: 'Separe as mesas unidas antes de transferir.' };
  }
  if (from.status !== 'ocupada' || !from.sale_id) return { ok: false, error: `${rotuloMesa(from)} não está ocupada (atualize a tela de mesas).` };
  const venda = db.prepare('SELECT status FROM sales WHERE id = ?').get(from.sale_id);
  if (!venda || venda.status !== 'aberta') return { ok: false, error: `A comanda de ${rotuloMesa(from)} já foi fechada.` };
  if (from.fechando_caixa_id) return { ok: false, error: `${rotuloMesa(from)} está sendo paga no ${from.fechando_caixa_nome || 'outro caixa'}. Espere terminar o pagamento lá.` };
  if (to.status !== 'livre' || to.sale_id || to.unida_a_mesa_id) {
    const motivo = to.status === 'ocupada' ? 'está ocupada' : to.status === 'reservada' ? 'está reservada' : to.status === 'aguardando_limpeza' ? 'está aguardando limpeza' : 'não está livre';
    return { ok: false, error: `${rotuloMesa(to)} ${motivo}. A mesa de destino precisa estar livre.` };
  }

  let pedidosMovidos = 0;
  const tx = db.transaction(() => {
    // Condição no WHERE: se outra tela mexeu numa das mesas no meio, nada muda.
    const r1 = db.prepare(`UPDATE restaurant_tables SET status = 'ocupada', sale_id = ?, pessoas = ?, reservado_para = NULL, transferida_para_id = NULL
                           WHERE id = ? AND status = 'livre' AND sale_id IS NULL`).run(from.sale_id, from.pessoas, toTableId);
    const r2 = db.prepare(`UPDATE restaurant_tables SET status = 'aguardando_limpeza', sale_id = NULL, pessoas = NULL, transferida_para_id = ?
                           WHERE id = ? AND status = 'ocupada' AND sale_id = ?`).run(toTableId, fromTableId, from.sale_id);
    if (r1.changes !== 1 || r2.changes !== 1) throw new Error('MESA_MUDOU');
    mesaLocal().moverMembros(db, fromTableId, toTableId); // os celulares vão junto
    try { db.prepare('UPDATE mesa_chamados SET table_id = ? WHERE table_id = ? AND atendido_em IS NULL').run(toTableId, fromTableId); } catch { /* banco sem a tabela */ }
    // Quem tinha transferido PARA a origem passa a apontar para o destino.
    db.prepare('UPDATE restaurant_tables SET transferida_para_id = ? WHERE transferida_para_id = ?').run(toTableId, fromTableId);
    try {
      pedidosMovidos = db.prepare(`UPDATE bot_orders SET mesa_numero = ? WHERE location_id = ? AND mesa_numero = ? AND status IN ('novo','em_separacao','pronto')`)
        .run(to.numero, from.location_id, from.numero).changes;
    } catch { /* banco sem a tabela de pedidos */ }
  });
  try { tx(); } catch (err) {
    if (err.message === 'MESA_MUDOU') return { ok: false, error: 'Uma das mesas mudou agora há pouco em outra tela. Atualize e tente de novo.' };
    throw err;
  }

  try {
    require('./authService').registrarEventoAuditoria({
      tipoEvento: 'mesa_transferida', solicitanteId: operadorId, saleId: from.sale_id,
      motivo: `${rotuloMesa(from)} -> ${rotuloMesa(to)}${pedidosMovidos ? ` (${pedidosMovidos} pedido(s) do QR/WhatsApp foram junto)` : ''}`,
    });
  } catch { /* auditoria é extra */ }
  return { ok: true, saleId: from.sale_id, destino: { id: to.id, numero: to.numero, nome: to.nome }, pedidosMovidos };
}

/**
 * Para onde foi a comanda de uma mesa transferida (a mesa nova, se ainda
 * estiver com uma comanda aberta), ou null. Segue no máximo 5 saltos.
 */
function destinoDaTransferencia(db, mesa) {
  let atual = mesa;
  for (let i = 0; i < 5 && atual && atual.transferida_para_id && atual.status !== 'ocupada'; i++) {
    atual = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(atual.transferida_para_id);
  }
  if (!atual || atual.id === mesa.id || atual.status !== 'ocupada' || !atual.sale_id) return null;
  return principalDe(db, atual);
}

/** Atualiza o número de pessoas de uma mesa já ocupada — pra quando o
 * grupo cresce (chegou mais gente) ou diminui depois de já ter aberto
 * a mesa. Só funciona em mesa ocupada — pessoas é definido de novo do
 * zero toda vez que a mesa abre. */
function updateTablePeople({ tableId, pessoas }) {
  const db = getDb();
  const table = mesaPorId(db, tableId);
  if (!table) return { ok: false, error: 'Mesa não encontrada.' };
  const principal = principalDe(db, table);
  if (principal.status !== 'ocupada' || !principal.sale_id) return { ok: false, error: 'Só é possível alterar o número de pessoas numa mesa ocupada.' };
  const novo = Number(pessoas);
  if (!Number.isInteger(novo) || novo < 1) return { ok: false, error: 'Informe um número de pessoas válido.' };

  // Não pode sumir uma pessoa que já tem nome ou item -- para isso existe
  // removerPessoa, que devolve os itens para "não atribuído".
  const minimo = totalDePessoas(db, principal.sale_id, 0);
  if (novo < minimo) {
    return { ok: false, error: `A pessoa ${minimo} tem nome ou item. Para diminuir, remova as pessoas pela lista de pessoas da mesa.` };
  }
  db.prepare('UPDATE restaurant_tables SET pessoas = ? WHERE id = ?').run(novo, principal.id);
  return { ok: true, pessoas: listarPessoas(db, principal.sale_id, novo) };
}

/**
 * Desocupa uma mesa direto, sem precisar passar pelo pagamento — pra
 * quando a mesa foi aberta por engano, ou o cliente foi embora sem
 * pedir nada (ou sem fechar a conta). Cancela a comanda em aberto
 * vinculada à mesa.
 *
 * Se a comanda estiver VAZIA (nenhum item lançado ainda), libera
 * direto pra "livre", sem pedir autorização de gerente — não tem
 * risco nenhum de fraude em cancelar algo que nunca teve nada dentro.
 *
 * Se já tiver item lançado, passa pelo cancelamento de venda normal
 * (mesma trilha de auditoria e mesma exigência de autorização — ou
 * não, dependendo da configuração em Configurações → Segurança), e
 * a mesa vai pra "aguardando limpeza" (algo aconteceu ali, mesmo sem
 * ter sido pago).
 */
function desocuparMesa({ tableId, locationId, currentOperatorId, candidateManagerId, pin, motivo, deviceId }) {
  const db = getDb();
  const mesaClicada = mesaPorId(db, tableId);
  if (!mesaClicada) return { ok: false, error: 'Mesa não encontrada.' };
  // Desocupar qualquer mesa de um grupo desocupa o grupo inteiro (é uma comanda só).
  const table = principalDe(db, mesaClicada);
  if (table.status !== 'ocupada' || !table.sale_id) return { ok: false, error: 'Essa mesa não está ocupada.' };
  // Comanda que já fechou (paga ou cancelada): só solta a mesa. Nunca cancela
  // uma venda já paga (ver repararMesasComVendaFechada).
  const venda = db.prepare('SELECT status FROM sales WHERE id = ?').get(table.sale_id);
  if (venda && venda.status !== 'aberta') {
    const statusFinal = venda.status === 'finalizada' ? 'aguardando_limpeza' : 'livre';
    liberarGrupo(db, table.id, statusFinal);
    return { ok: true, statusFinal, autorizadoPor: null, jaFechada: true };
  }

  const itensAtivos = db.prepare('SELECT COUNT(*) as c FROM sale_items WHERE sale_id = ? AND cancelado = 0').get(table.sale_id).c;
  // Antes de liberar: a venda cancelada também mostra de qual mesa veio no histórico.
  saleService.registrarMesasDaVenda(db, table.sale_id);

  if (itensAtivos === 0) {
    db.prepare(
      `UPDATE sales SET status = 'cancelada', cancelada_em = NOW_SYNCED(), cancelada_por_id = ?, motivo_cancelamento = ? WHERE id = ?`
    ).run(currentOperatorId, motivo || 'Mesa desocupada sem consumo', table.sale_id);
    liberarGrupo(db, table.id, 'livre');
    return { ok: true, statusFinal: 'livre', autorizadoPor: null };
  }

  const result = saleService.cancelSale({ saleId: table.sale_id, locationId, currentOperatorId, candidateManagerId, pin, motivo, deviceId });
  if (!result.ok) return result;

  liberarGrupo(db, table.id, 'aguardando_limpeza');
  return { ok: true, statusFinal: 'aguardando_limpeza', autorizadoPor: result.autorizadoPor };
}

/** Existe uma mesa com esse número nesse local? Usado pelo chatbot
 * (whatsappBotHandler) pra validar o "Mesa N" que chega pré-preenchido
 * no link do QR code antes de aceitar o pedido — sem isso, um número
 * digitado errado (ou o QR de uma mesa que já foi excluída) criaria um
 * pedido "fantasma" sem mesa nenhuma pra receber. */
function existeMesa(locationId, numero) {
  const db = getDb();
  const numeroLimpo = String(numero ?? '').trim();
  if (!numeroLimpo) return false;
  return !!db.prepare('SELECT id FROM restaurant_tables WHERE location_id = ? AND numero = ?').get(locationId, numeroLimpo);
}

/** Monta o link de WhatsApp (e o QR code pronto pra imprimir e colar na
 * mesa) que já abre a conversa com "Mesa N" preenchido — assim que o
 * cliente manda a mensagem sem editar nada, o bot já sabe de qual mesa
 * veio o pedido (ver fluxo "Mesa N" em whatsappBotHandler.js). Precisa
 * do número da loja conectado (mesma conexão do chatbot normal — não é
 * um canal separado), senão não tem pra onde o QR apontar. Assíncrona
 * só por causa da geração da imagem do QR (mesma lib `qrcode` já usada
 * pro QR de conexão do WhatsApp em whatsappBotService.js). */
async function montarLinkPedidoMesa({ tableId }) {
  const db = getDb();
  const table = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(tableId);
  if (!table) return { ok: false, error: 'Mesa não encontrada.' };

  // Vitrine com pedido direto no sistema: o QR abre o cardápio da loja já
  // com a mesa (vitrineService.qrDaMesa) -- o cliente escolhe, informa o
  // nome e o atendente confirma na Separação. Sem ela, o QR do WhatsApp.
  try {
    const viaVitrine = await require('./vitrineService').qrDaMesa(tableId);
    if (viaVitrine) return { ok: true, ...viaVitrine, mensagem: null };
  } catch (err) {
    console.error('[tableService] QR da vitrine da mesa', err?.message || err);
  }

  const whatsappBotService = require('./whatsappBotService');
  const status = whatsappBotService.getStatus();
  if (status.status !== 'conectado' || !status.numero) {
    return { ok: false, error: 'Conecte o WhatsApp em Configurações antes de gerar o link/QR code da mesa.' };
  }

  const mensagem = `Mesa ${table.numero}`;
  const url = `https://wa.me/${status.numero}?text=${encodeURIComponent(mensagem)}`;

  let qrCodeDataUrl = null;
  try {
    const QRCode = require('qrcode');
    qrCodeDataUrl = await QRCode.toDataURL(url);
  } catch (err) {
    console.error('[tableService] falha ao gerar QR code da mesa', err);
  }

  return { ok: true, url, mensagem, qrCodeDataUrl };
}

/**
 * Junta outras mesas à mesa `tableId` (que vira a PRINCIPAL do grupo, ou a
 * principal do grupo dela, se ela já for unida). Para cada mesa escolhida:
 *   - livre: só fica unida (ocupada, mesma comanda);
 *   - ocupada: os itens e as pessoas (com nome) dela entram na comanda
 *     principal, renumerando as pessoas depois das da principal; a comanda
 *     dela, já vazia, é cancelada com o motivo; se ela era principal de
 *     outro grupo, o grupo inteiro vem junto.
 * Movimentos de estoque NÃO são mexidos (o livro-razão nunca é editado):
 * o movimento da venda continua citando a comanda onde o item foi lançado,
 * e um estorno futuro sai pela comanda principal -- o saldo é o mesmo.
 * Recusa mesa reservada, aguardando limpeza, unida a OUTRA principal, ou
 * cuja comanda tenha pagamento, desconto, pontos ou Pix em andamento.
 */
function juntarMesas({ tableId, mesaIds, currentOperatorId } = {}) {
  const db = getDb();
  repararMesasUnidas(db);
  const base = mesaPorId(db, tableId);
  if (!base) return { ok: false, error: 'Mesa não encontrada.' };
  const principal = principalDe(db, base);
  if (principal.status !== 'ocupada' || !principal.sale_id) {
    return { ok: false, error: 'Abra a mesa antes de juntar outras a ela.' };
  }
  const ids = [...new Set((Array.isArray(mesaIds) ? mesaIds : []).filter((id) => id && id !== principal.id))];
  if (ids.length === 0) return { ok: false, error: 'Escolha pelo menos uma mesa para juntar.' };

  const outras = [];
  for (const id of ids) {
    const t = mesaPorId(db, id);
    if (!t || t.location_id !== principal.location_id) return { ok: false, error: 'Mesa não encontrada.' };
    const rotulo = rotuloMesa(t);
    if (t.unida_a_mesa_id === principal.id) return { ok: false, error: `${rotulo} já está unida a esta mesa.` };
    if (t.unida_a_mesa_id) {
      const dona = mesaPorId(db, t.unida_a_mesa_id);
      return { ok: false, error: `${rotulo} está unida a ${dona ? rotuloMesa(dona) : 'outra mesa'}. Junte a mesa principal do grupo ou separe antes.` };
    }
    if (t.status === 'reservada') return { ok: false, error: `${rotulo} está reservada. Cancele a reserva antes de juntar.` };
    if (t.status === 'aguardando_limpeza') return { ok: false, error: `${rotulo} está aguardando limpeza.` };
    if (t.status === 'ocupada' && t.sale_id) {
      const venda = db.prepare('SELECT * FROM sales WHERE id = ?').get(t.sale_id);
      if (!venda || venda.status !== 'aberta') return { ok: false, error: `A comanda de ${rotulo} não está aberta.` };
      const pagamentos = db.prepare('SELECT COUNT(*) AS c FROM payments WHERE sale_id = ?').get(t.sale_id).c;
      if (pagamentos > 0) return { ok: false, error: `${rotulo} já tem pagamento lançado. Finalize ou remova o pagamento antes de juntar.` };
      if ((venda.desconto || 0) > 0 || (venda.desconto_gerente || 0) > 0 || (venda.pontos_resgatados || 0) > 0) {
        return { ok: false, error: `${rotulo} tem desconto ou pontos aplicados. Remova antes de juntar.` };
      }
      const pix = db.prepare(`SELECT COUNT(*) AS c FROM pix_cobrancas WHERE sale_id = ? AND status IN ('criando', 'pendente')`).get(t.sale_id).c;
      if (pix > 0) return { ok: false, error: `${rotulo} tem uma cobrança Pix em andamento.` };
    }
    outras.push(t);
  }

  const saleId = principal.sale_id;
  const tx = db.transaction(() => {
    let pessoas = totalDePessoas(db, saleId, principal.pessoas);
    for (const t of outras) {
      if (t.status === 'ocupada' && t.sale_id) {
        const origem = t.sale_id;
        // A comanda que vai ser cancelada guarda a mesa dela para o histórico.
        saleService.registrarMesasDaVenda(db, origem);
        const deslocamento = pessoas;
        const pessoasDaOutra = totalDePessoas(db, origem, t.pessoas);
        db.prepare('UPDATE sale_items SET pessoa_numero = pessoa_numero + ? WHERE sale_id = ? AND pessoa_numero IS NOT NULL')
          .run(deslocamento, origem);
        db.prepare('UPDATE sale_items SET sale_id = ? WHERE sale_id = ?').run(saleId, origem);
        db.prepare(
          `INSERT INTO sale_people (id, sale_id, numero, nome, customer_id, aparelho, criado_em)
           SELECT lower(hex(randomblob(16))), ?, numero + ?, nome, customer_id, aparelho, criado_em FROM sale_people WHERE sale_id = ?`
        ).run(saleId, deslocamento, origem);
        db.prepare('DELETE FROM sale_people WHERE sale_id = ?').run(origem);
        // Pedidos do garçom/WhatsApp lançados nela passam a apontar para a comanda que tem os itens.
        db.prepare('UPDATE bot_orders SET sale_id = ? WHERE sale_id = ?').run(saleId, origem);
        db.prepare(
          `UPDATE sales SET status = 'cancelada', total = 0, cancelada_em = NOW_SYNCED(), cancelada_por_id = ?, motivo_cancelamento = ?
           WHERE id = ?`
        ).run(currentOperatorId || null, `${rotuloMesa(t)} unida a ${rotuloMesa(principal)} (itens levados para a comanda dela)`, origem);
        // Se ela era principal de outro grupo, as unidas dela vêm junto.
        db.prepare('UPDATE restaurant_tables SET unida_a_mesa_id = ?, sale_id = ?, pessoas = NULL WHERE unida_a_mesa_id = ?')
          .run(principal.id, saleId, t.id);
        pessoas += pessoasDaOutra;
      }
      db.prepare(
        `UPDATE restaurant_tables SET status = 'ocupada', sale_id = ?, pessoas = NULL, reservado_para = NULL, unida_a_mesa_id = ?
         WHERE id = ?`
      ).run(saleId, principal.id, t.id);
      // Celulares que entraram pelo QR desta mesa passam a ser da principal.
      mesaLocal().moverMembros(db, t.id, principal.id);
      try { db.prepare('UPDATE mesa_local_membros SET sale_id = ? WHERE table_id = ? AND sale_id IS NOT NULL').run(saleId, principal.id); } catch { /* banco sem a tabela */ }
    }
    mesaLocal().incluirMembrosPendentes(db, principal.id, saleId);
    db.prepare('UPDATE restaurant_tables SET pessoas = ? WHERE id = ?').run(pessoas || null, principal.id);
    recalcularTotal(db, saleId);
    registrarAuditoria(db, {
      tipo: 'mesas_unidas', saleId, solicitanteId: currentOperatorId,
      motivo: `${outras.map(rotuloMesa).join(', ')} unida(s) a ${rotuloMesa(principal)}`,
    });
  });
  tx();

  const venda = db.prepare('SELECT total FROM sales WHERE id = ?').get(saleId);
  return { ok: true, saleId, principalId: principal.id, total: venda.total };
}

/** Tira uma mesa do grupo. O consumo continua na comanda principal (não dá
 * para saber com segurança o que era de cada mesa); a mesa vai para
 * "aguardando limpeza". */
function separarMesa({ tableId, currentOperatorId } = {}) {
  const db = getDb();
  const table = mesaPorId(db, tableId);
  if (!table) return { ok: false, error: 'Mesa não encontrada.' };
  if (!table.unida_a_mesa_id) return { ok: false, error: 'Essa mesa não está unida a outra.' };
  const principal = mesaPorId(db, table.unida_a_mesa_id);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE restaurant_tables SET status = 'aguardando_limpeza', sale_id = NULL, pessoas = NULL, unida_a_mesa_id = NULL WHERE id = ?`
    ).run(tableId);
    registrarAuditoria(db, {
      tipo: 'mesa_separada', saleId: principal?.sale_id, solicitanteId: currentOperatorId,
      motivo: `${rotuloMesa(table)} separada de ${principal ? rotuloMesa(principal) : 'grupo'}`,
    });
  });
  tx();
  return { ok: true };
}

/** Acrescenta uma pessoa (com ou sem nome) -- sem limite de quantidade. */
function adicionarPessoa({ tableId, nome } = {}) {
  const db = getDb();
  const c = comandaDaMesa(db, tableId);
  if (c.erro) return { ok: false, error: c.erro };
  const numero = db.transaction(() => {
    const proximo = totalDePessoas(db, c.saleId, c.principal.pessoas) + 1;
    const nomeLimpo = limparNome(nome);
    if (nomeLimpo) {
      db.prepare('INSERT INTO sale_people (id, sale_id, numero, nome) VALUES (?, ?, ?, ?)').run(randomUUID(), c.saleId, proximo, nomeLimpo);
    }
    db.prepare('UPDATE restaurant_tables SET pessoas = ? WHERE id = ?').run(proximo, c.principal.id);
    return proximo;
  })();
  return { ok: true, numero, pessoas: listarPessoas(db, c.saleId, numero) };
}

/** Dá (ou troca, ou apaga com nome vazio) o nome de uma pessoa. */
function renomearPessoa({ tableId, numero, nome } = {}) {
  const db = getDb();
  const c = comandaDaMesa(db, tableId);
  if (c.erro) return { ok: false, error: c.erro };
  const total = totalDePessoas(db, c.saleId, c.principal.pessoas);
  const n = numeroDePessoaValido(numero, total);
  if (!n) return { ok: false, error: 'Pessoa não encontrada nesta mesa.' };
  const nomeLimpo = limparNome(nome);
  if (nomeLimpo) {
    db.prepare(
      `INSERT INTO sale_people (id, sale_id, numero, nome) VALUES (?, ?, ?, ?)
       ON CONFLICT(sale_id, numero) DO UPDATE SET nome = excluded.nome`
    ).run(randomUUID(), c.saleId, n, nomeLimpo);
  } else {
    // Pessoa vinculada a um cliente não fica sem nome: volta para o nome do cadastro.
    const vinculada = db.prepare(
      `SELECT c.nome FROM sale_people sp JOIN customers c ON c.id = sp.customer_id WHERE sp.sale_id = ? AND sp.numero = ?`
    ).get(c.saleId, n);
    if (vinculada) {
      db.prepare('UPDATE sale_people SET nome = ? WHERE sale_id = ? AND numero = ?').run(limparNome(vinculada.nome), c.saleId, n);
    } else {
      db.prepare('DELETE FROM sale_people WHERE sale_id = ? AND numero = ?').run(c.saleId, n);
    }
  }
  return { ok: true, pessoas: listarPessoas(db, c.saleId, c.principal.pessoas) };
}

/**
 * Liga (ou, com customerId vazio, desliga) uma pessoa da comanda a um
 * cliente do cadastro -- o consumo dela passa a aparecer na ficha dele. Não
 * muda o cliente da venda (quem paga, fiado, pontos). Pessoa sem nome recebe
 * o nome do cadastro; com nome (apelido), mantém. O mesmo cliente não fica
 * em duas pessoas da mesma comanda.
 */
function vincularClientePessoa({ tableId, numero, customerId } = {}) {
  const db = getDb();
  const c = comandaDaMesa(db, tableId);
  if (c.erro) return { ok: false, error: c.erro };
  const total = totalDePessoas(db, c.saleId, c.principal.pessoas);
  const n = numeroDePessoaValido(numero, total);
  if (!n) return { ok: false, error: 'Pessoa não encontrada nesta mesa.' };
  if (!customerId) {
    db.prepare('UPDATE sale_people SET customer_id = NULL WHERE sale_id = ? AND numero = ?').run(c.saleId, n);
    return { ok: true, pessoas: listarPessoas(db, c.saleId, c.principal.pessoas) };
  }
  const cliente = db.prepare('SELECT id, nome FROM customers WHERE id = ? AND ativo = 1').get(customerId);
  if (!cliente) return { ok: false, error: 'Cliente não encontrado no cadastro (ou desativado).' };
  const outra = db.prepare('SELECT numero FROM sale_people WHERE sale_id = ? AND customer_id = ? AND numero != ?').get(c.saleId, cliente.id, n);
  if (outra) return { ok: false, error: `${cliente.nome} já está na Pessoa ${outra.numero} desta mesa.` };
  db.prepare(
    `INSERT INTO sale_people (id, sale_id, numero, nome, customer_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sale_id, numero) DO UPDATE SET customer_id = excluded.customer_id, nome = COALESCE(sale_people.nome, excluded.nome)`
  ).run(randomUUID(), c.saleId, n, limparNome(cliente.nome), cliente.id);
  return { ok: true, pessoas: listarPessoas(db, c.saleId, c.principal.pessoas) };
}

/** Remove uma pessoa: os itens dela voltam para "não atribuído" e as
 * pessoas seguintes sobem um número (com os itens e nomes delas). */
function removerPessoa({ tableId, numero } = {}) {
  const db = getDb();
  const c = comandaDaMesa(db, tableId);
  if (c.erro) return { ok: false, error: c.erro };
  const total = totalDePessoas(db, c.saleId, c.principal.pessoas);
  const n = numeroDePessoaValido(numero, total);
  if (!n) return { ok: false, error: 'Pessoa não encontrada nesta mesa.' };
  const pagou = db.prepare('SELECT COUNT(*) AS c FROM sale_person_payments WHERE sale_id = ? AND pessoa_numero = ?').get(c.saleId, n).c;
  if (pagou > 0) return { ok: false, error: 'Esta pessoa já pagou a parte dela: não dá para removê-la da mesa.' };
  db.transaction(() => {
    db.prepare('UPDATE sale_items SET pessoa_numero = NULL WHERE sale_id = ? AND pessoa_numero = ?').run(c.saleId, n);
    db.prepare('UPDATE sale_items SET pessoa_numero = pessoa_numero - 1 WHERE sale_id = ? AND pessoa_numero > ?').run(c.saleId, n);
    // Quem pagou continua sendo a mesma pessoa depois que as de baixo sobem um número.
    db.prepare('UPDATE sale_person_payments SET pessoa_numero = pessoa_numero - 1 WHERE sale_id = ? AND pessoa_numero > ?').run(c.saleId, n);
    db.prepare('DELETE FROM sale_people WHERE sale_id = ? AND numero = ?').run(c.saleId, n);
    // Em dois passos por causa do UNIQUE(sale_id, numero): sobe para longe e desce de volta.
    db.prepare('UPDATE sale_people SET numero = numero + 1000000 WHERE sale_id = ? AND numero > ?').run(c.saleId, n);
    db.prepare('UPDATE sale_people SET numero = numero - 1000001 WHERE sale_id = ? AND numero > 1000000').run(c.saleId);
    db.prepare('UPDATE restaurant_tables SET pessoas = ? WHERE id = ?').run(total - 1 || null, c.principal.id);
  })();
  return { ok: true, pessoas: listarPessoas(db, c.saleId, total - 1) };
}

module.exports = {
  createTablesEmLote,
  proximoNumeroDeMesa,
  proximaFaixaLivre,
  reorderTables,
  listTables, createTable, deleteTable, openTable, getTableCart, releaseTable, repararMesasUnidas,
  repararMesasComVendaFechada, liberarMesaDaVenda,
  markCleaned, markReserved, cancelReservation, transferTable, destinoDaTransferencia, updateTablePeople, desocuparMesa,
  existeMesa, montarLinkPedidoMesa,
  juntarMesas, separarMesa, adicionarPessoa, renomearPessoa, removerPessoa, vincularClientePessoa,
  _totalDePessoas: totalDePessoas,
};
