/**
 * Migração PDV mobile autônomo -> este computador.
 *
 * Cenário: o cliente começou vendendo só no celular (app GerenciaAI PDV,
 * pasta mobile/ do repositório) e agora comprou um computador. Este
 * serviço lê o backup que o celular sobe sozinho pra nuvem (mesmo Storage
 * do backup do desktop, formato "gerenciaai-pdv-mobile-backup" v1 --
 * ver mobile/src/services/backup.js) e converte pro banco daqui.
 *
 * Regras (o motivo de cada uma está no código abaixo):
 * - IDs do celular são preservados -> importar de novo NÃO duplica nada;
 *   a segunda importação traz só o que é novo (o "complemento").
 * - Estoque e fiado nunca são contados duas vezes: produto/cliente NOVO
 *   aqui recebe o SALDO do celular; o que já existia recebe só os
 *   movimentos do celular feitos DEPOIS da importação anterior (corte).
 *   As vendas entram como histórico (relatórios, ranking), sem mexer em
 *   estoque nem em fiado por conta própria.
 * - Tudo numa transação, com conferência no fim (totais de venda, por
 *   forma de pagamento, saldos de estoque e de fiado). Se qualquer número
 *   não bater, nada é gravado. A pré-visualização roda exatamente o mesmo
 *   código e desfaz no fim.
 * - Datas: o celular grava ISO ("2026-10-17T12:00:00.000Z"); aqui o
 *   padrão é "2026-10-17 12:00:00" (UTC) e os filtros de período comparam
 *   texto -- sem converter, venda importada sumiria dos relatórios.
 */
const { randomUUID, randomBytes } = require('crypto');
const zlib = require('zlib');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');

const FORMATO = 'gerenciaai-pdv-mobile-backup';
const VERSAO_FORMATO_MAX = 1;
const TIPO_INSTALACAO_MOBILE = 'pdv_mobile_autonomo';

const METODO = { dinheiro: 'dinheiro', credito: 'cartao_credito', debito: 'cartao_debito', pix: 'pix', fiado: 'fiado' };
const TIPO_MOV_ESTOQUE = { inicial: 'entrada', entrada: 'entrada', ajuste: 'ajuste', venda: 'venda', cancelamento_venda: 'estorno' };
const PAPEL = { admin: 'admin', gerente: 'gerente', operador: 'operador' };
const NOME_METODO = { dinheiro: 'dinheiro', cartao_credito: 'cartão de crédito', cartao_debito: 'cartão de débito', pix: 'Pix', fiado: 'fiado', outro: 'outros' };

class ErroMigracao extends Error {}
class DesfazerPrevia extends Error {}

const reais = (centavos) => Math.round(Number(centavos) || 0) / 100;
const qtd = (mil) => (Number(mil) || 0) / 1000;
const arred = (v) => Math.round(v * 100) / 100;

/** ISO do celular -> formato de data do desktop (UTC, "YYYY-MM-DD HH:MM:SS"). */
function dataDesktop(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new ErroMigracao(`Data inválida no backup: ${iso}`);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Tabela do backup -> lista de objetos { coluna: valor }. */
function linhas(dump, tabela) {
  const t = dump.tabelas?.[tabela];
  if (!t) return [];
  return t.linhas.map((l) => Object.fromEntries(t.colunas.map((c, i) => [c, l[i]])));
}

function validarDump(dump) {
  if (!dump || dump.formato !== FORMATO) throw new ErroMigracao('Esse arquivo não é um backup do PDV mobile.');
  if (!(dump.versaoFormato <= VERSAO_FORMATO_MAX)) {
    throw new ErroMigracao('Esse backup é de uma versão mais nova do app do celular. Atualize o GerenciaAI deste computador antes de migrar.');
  }
  if (!dump.installId) throw new ErroMigracao('Backup sem identificação do celular.');
}

function garantirTabela(db) {
  // Registro de cada importação: dá o "corte" da próxima (só o que o
  // celular fez DEPOIS) e o histórico pra tela.
  db.exec(`CREATE TABLE IF NOT EXISTS pdv_mobile_migracoes (
    id TEXT PRIMARY KEY,
    install_id_mobile TEXT NOT NULL,
    nome_mobile TEXT,
    gerado_em_ms INTEGER NOT NULL,
    importado_em TEXT NOT NULL DEFAULT (NOW_SYNCED()),
    operador_id TEXT,
    resumo TEXT
  )`);
}

function corteAnterior(db, installId) {
  garantirTabela(db);
  const r = db.prepare('SELECT MAX(gerado_em_ms) AS corte FROM pdv_mobile_migracoes WHERE install_id_mobile = ?').get(installId);
  return r?.corte ?? null;
}

function saldoEstoque(db, productId, locationId) {
  return db.prepare('SELECT COALESCE(SUM(quantidade), 0) AS s FROM stock_movements WHERE product_id = ? AND location_id = ?').get(productId, locationId).s;
}
function saldoFiado(db, customerId) {
  return db.prepare(`SELECT COALESCE(SUM(CASE WHEN tipo = 'divida' THEN valor ELSE -valor END), 0) AS s FROM customer_credit_movements WHERE customer_id = ?`).get(customerId).s;
}

/**
 * Aplica o backup no banco. `previa: true` roda tudo (inclusive a
 * conferência) e desfaz no fim -- é a pré-visualização.
 */
function importarDump(dump, { operadorId, previa = false } = {}) {
  validarDump(dump);
  const db = getDb();
  garantirTabela(db);
  const installId = dump.installId;
  const deviceId = `pdv-mobile:${installId}`;
  const location = db.prepare('SELECT id FROM locations ORDER BY criado_em LIMIT 1').get();
  if (!location) throw new ErroMigracao('Este computador ainda não tem loja configurada.');
  const locationId = location.id;
  const operador = db.prepare('SELECT id FROM users WHERE id = ?').get(operadorId);
  if (!operador) throw new ErroMigracao('Operador inválido para registrar a migração.');

  const corte = corteAnterior(db, installId);
  const corteIso = corte != null ? new Date(corte).toISOString() : null;
  if (corte != null && dump.geradoEmMs <= corte) {
    throw new ErroMigracao('Esse backup é igual ou mais antigo que o da última importação deste celular -- nada novo para trazer. Peça um backup novo no celular e tente de novo.');
  }

  const m = {
    usuarios: linhas(dump, 'usuarios'), produtos: linhas(dump, 'produtos'), clientes: linhas(dump, 'clientes'),
    caixas: linhas(dump, 'caixas'), vendas: linhas(dump, 'vendas'), itens: linhas(dump, 'venda_itens'),
    pagamentos: linhas(dump, 'pagamentos'), movimentos: linhas(dump, 'movimentos_estoque'), fiado: linhas(dump, 'fiado_lancamentos'),
  };

  const resumo = {
    celular: { installId, geradoEm: new Date(dump.geradoEmMs).toISOString(), primeiraImportacao: corte == null },
    usuarios: { novos: 0, existentes: 0 },
    produtos: { novos: 0, existentes: 0, ligadosPorCodigo: 0, estoqueMantidoDoComputador: [] },
    clientes: { novos: 0, existentes: 0, ligadosPorDocumento: 0 },
    vendas: { novas: 0, jaImportadas: 0, canceladasDepois: 0, ignoradas: 0 },
    estoque: { saldosIniciais: 0, movimentosReplicados: 0 },
    fiado: { saldosIniciais: 0, lancamentosReplicados: 0 },
    caixas: { importados: 0, abertoNoCelularNaoImportado: false },
    conferencia: null,
  };

  const executar = db.transaction(() => {
    // --- Usuários: entram DESATIVADOS. O PIN do celular usa outro hash
    // (PBKDF2) e não dá pra converter; quem for usar este computador é
    // reativado em Usuários com um PIN novo. Servem pra manter o "quem
    // vendeu" do histórico.
    const mapaUsuario = new Map();
    for (const u of m.usuarios) {
      if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(u.id)) { resumo.usuarios.existentes += 1; mapaUsuario.set(u.id, u.id); continue; }
      db.prepare(`INSERT INTO users (id, nome, role, pin_hash, pin_temporario, ativo, criado_em) VALUES (?, ?, ?, ?, 1, 0, ?)`)
        .run(u.id, `${u.nome} (celular)`, PAPEL[u.papel] || 'operador', bcrypt.hashSync(randomBytes(24).toString('hex'), 8), dataDesktop(u.criado_em));
      mapaUsuario.set(u.id, u.id);
      resumo.usuarios.novos += 1;
    }
    const usuario = (id) => (id && mapaUsuario.get(id)) || operadorId;

    // --- Produtos
    const mapaProduto = new Map(); // id celular -> { id, novo }
    for (const p of m.produtos) {
      if (db.prepare('SELECT 1 FROM products WHERE id = ?').get(p.id)) {
        mapaProduto.set(p.id, { id: p.id, novo: false, controla: !!p.controla_estoque });
        resumo.produtos.existentes += 1;
        continue;
      }
      const mapeado = db.prepare(`SELECT p.id, p.nome FROM pdv_terminal_mapa m JOIN products p ON p.id = m.id_local
        WHERE m.install_id = ? AND m.tipo = 'produto' AND m.id_mobile = ?`).get(installId, p.id);
      const porCodigo = mapeado || (p.codigo_barras ? db.prepare('SELECT id, nome FROM products WHERE codigo_barras = ?').get(p.codigo_barras) : null);
      if (porCodigo) {
        // Guarda a ligação (o modo terminal precisa dela depois que o
        // código de barras do produto do celular for limpo).
        db.prepare(`INSERT OR IGNORE INTO pdv_terminal_mapa (install_id, tipo, id_mobile, id_local) VALUES (?, 'produto', ?, ?)`).run(installId, p.id, porCodigo.id);
        // Mesmo produto já cadastrado aqui: liga os dois. Na PRIMEIRA
        // importação o estoque deste computador é mantido (não dá pra
        // saber se é a mesma mercadoria física contada duas vezes).
        mapaProduto.set(p.id, { id: porCodigo.id, novo: false, controla: !!p.controla_estoque, porCodigo: true });
        resumo.produtos.ligadosPorCodigo += 1;
        if (corte == null && p.controla_estoque) resumo.produtos.estoqueMantidoDoComputador.push({ nome: porCodigo.nome, saldoNoCelular: qtd(p.estoque_mil) });
        continue;
      }
      db.prepare(
        `INSERT INTO products (id, codigo_barras, nome, categoria, preco, custo, unidade, estoque_minimo, tipo, ativo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(p.id, p.codigo_barras || null, p.nome, p.categoria || null, reais(p.preco_centavos), reais(p.custo_centavos),
        p.unidade === 'kg' ? 'kg' : 'un', qtd(p.estoque_minimo_mil), p.controla_estoque ? 'produto' : 'servico', p.ativo ? 1 : 0);
      mapaProduto.set(p.id, { id: p.id, novo: true, controla: !!p.controla_estoque });
      resumo.produtos.novos += 1;
    }

    // --- Clientes
    const mapaCliente = new Map();
    for (const c of m.clientes) {
      if (db.prepare('SELECT 1 FROM customers WHERE id = ?').get(c.id)) { mapaCliente.set(c.id, { id: c.id, novo: false }); resumo.clientes.existentes += 1; continue; }
      const doc = String(c.documento || '').replace(/\D/g, '');
      const mapeado = db.prepare(`SELECT c.id FROM pdv_terminal_mapa m JOIN customers c ON c.id = m.id_local
        WHERE m.install_id = ? AND m.tipo = 'cliente' AND m.id_mobile = ?`).get(installId, c.id);
      const porDoc = mapeado || doc.length === 11 ? db.prepare(`SELECT id FROM customers WHERE REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), ' ', '') = ?`).get(doc)
        : doc.length === 14 ? db.prepare(`SELECT id FROM customers WHERE REPLACE(REPLACE(REPLACE(REPLACE(cnpj, '.', ''), '-', ''), '/', ''), ' ', '') = ?`).get(doc) : null;
      if (porDoc) {
        db.prepare(`INSERT OR IGNORE INTO pdv_terminal_mapa (install_id, tipo, id_mobile, id_local) VALUES (?, 'cliente', ?, ?)`).run(installId, c.id, porDoc.id);
        mapaCliente.set(c.id, { id: porDoc.id, novo: false, porDocumento: true });
        resumo.clientes.ligadosPorDocumento += 1;
        continue;
      }
      db.prepare('INSERT INTO customers (id, nome, telefone, cpf, cnpj, ativo, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(c.id, c.nome, c.telefone || null, doc.length === 11 ? doc : null, doc.length === 14 ? doc : null, c.ativo ? 1 : 0, dataDesktop(c.criado_em));
      mapaCliente.set(c.id, { id: c.id, novo: true });
      resumo.clientes.novos += 1;
    }

    // --- Caixas fechados (histórico de fechamento). O aberto fica no celular.
    for (const cx of m.caixas) {
      if (cx.status !== 'fechado') { resumo.caixas.abertoNoCelularNaoImportado = true; continue; }
      if (db.prepare('SELECT 1 FROM cash_sessions WHERE id = ?').get(cx.id)) continue;
      db.prepare(
        `INSERT INTO cash_sessions (id, location_id, operador_abertura_id, valor_abertura, aberta_em, operador_fechamento_id,
           valor_fechamento_informado, valor_fechamento_esperado, diferenca, fechada_em, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fechada')`,
      ).run(cx.id, locationId, usuario(cx.aberto_por), reais(cx.valor_abertura_centavos), dataDesktop(cx.aberto_em), usuario(cx.fechado_por),
        reais(cx.valor_contado_centavos), reais(cx.valor_esperado_centavos), reais((cx.valor_contado_centavos || 0) - (cx.valor_esperado_centavos || 0)), dataDesktop(cx.fechado_em));
      resumo.caixas.importados += 1;
    }

    // --- Vendas (histórico). Sem estoque/fiado aqui: isso vem pelas regras de saldo/corte abaixo.
    const itensPorVenda = new Map();
    for (const i of m.itens) { if (!itensPorVenda.has(i.venda_id)) itensPorVenda.set(i.venda_id, []); itensPorVenda.get(i.venda_id).push(i); }
    const pagPorVenda = new Map();
    for (const p of m.pagamentos) { if (!pagPorVenda.has(p.venda_id)) pagPorVenda.set(p.venda_id, []); pagPorVenda.get(p.venda_id).push(p); }

    for (const v of m.vendas) {
      if (!['finalizada', 'cancelada'].includes(v.status)) { resumo.vendas.ignoradas += 1; continue; }
      const existente = db.prepare('SELECT status FROM sales WHERE id = ?').get(v.id);
      if (existente) {
        if (existente.status === 'finalizada' && v.status === 'cancelada') {
          db.prepare(`UPDATE sales SET status = 'cancelada', cancelada_em = ?, cancelada_por_id = ?, motivo_cancelamento = ? WHERE id = ?`)
            .run(dataDesktop(v.cancelada_em), usuario(v.cancelada_por), v.motivo_cancelamento ? `${v.motivo_cancelamento} (cancelada no PDV mobile)` : 'Cancelada no PDV mobile', v.id);
          resumo.vendas.canceladasDepois += 1;
        } else {
          resumo.vendas.jaImportadas += 1;
        }
        continue;
      }
      const criado = dataDesktop(v.criado_em);
      db.prepare(
        `INSERT INTO sales (id, location_id, operador_id, customer_id, desconto, desconto_gerente, desconto_gerente_motivo, desconto_autorizado_por_id,
           status, total, criado_em, finalizada_em, cancelada_em, cancelada_por_id, motivo_cancelamento)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(v.id, locationId, usuario(v.operador_id), v.cliente_id ? mapaCliente.get(v.cliente_id)?.id || null : null,
        reais(v.desconto_centavos), v.desconto_centavos ? 'Desconto dado no PDV mobile' : null, v.desconto_autorizado_por ? usuario(v.desconto_autorizado_por) : null,
        v.status, reais(v.subtotal_centavos), criado, criado,
        v.status === 'cancelada' ? dataDesktop(v.cancelada_em) : null, v.status === 'cancelada' ? usuario(v.cancelada_por) : null,
        v.status === 'cancelada' ? (v.motivo_cancelamento || 'Cancelada no PDV mobile') : null);

      for (const i of itensPorVenda.get(v.id) || []) {
        const prod = mapaProduto.get(i.produto_id);
        if (!prod) throw new ErroMigracao(`Item da venda ${v.numero} aponta pra um produto que não está no backup.`);
        const nomeAqui = db.prepare('SELECT nome FROM products WHERE id = ?').get(prod.id)?.nome;
        db.prepare(
          `INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario, criado_em, nome_personalizado) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(i.id, v.id, prod.id, qtd(i.qtd_mil), reais(i.preco_unit_centavos), criado, nomeAqui !== i.nome ? i.nome : null);
      }
      for (const p of pagPorVenda.get(v.id) || []) {
        const detalhes = { origem: 'pdv_mobile', numeroPdvMobile: v.numero };
        if (p.metodo === 'dinheiro' && p.recebido_centavos != null && p.recebido_centavos > p.valor_centavos) {
          detalhes.valorRecebido = reais(p.recebido_centavos);
          detalhes.troco = reais(p.recebido_centavos - p.valor_centavos);
        }
        db.prepare('INSERT INTO payments (id, sale_id, metodo, valor, detalhes, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
          .run(p.id, v.id, METODO[p.metodo] || 'outro', reais(p.valor_centavos), JSON.stringify(detalhes), criado);
      }
      resumo.vendas.novas += 1;
    }

    // --- Estoque
    for (const p of m.produtos) {
      const alvo = mapaProduto.get(p.id);
      if (!alvo.controla) continue;
      if (alvo.novo) {
        if (p.estoque_mil !== 0) {
          db.prepare(
            `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, operador_id, device_id, criado_em)
             VALUES (?, ?, ?, 'ajuste', ?, ?, ?, ?, NOW_SYNCED())`,
          ).run(`migr-${installId}-${p.id}`, alvo.id, locationId, qtd(p.estoque_mil), 'Saldo migrado do PDV mobile', operadorId, deviceId);
          resumo.estoque.saldosIniciais += 1;
        }
      }
    }
    if (corte != null) {
      for (const mv of m.movimentos) {
        if (mv.criado_em <= corteIso) continue;
        const alvo = mapaProduto.get(mv.produto_id);
        if (!alvo || alvo.novo || !alvo.controla) continue; // produto novo já veio com o saldo completo
        if (db.prepare('SELECT 1 FROM stock_movements WHERE id = ?').get(mv.id)) continue;
        const vendaAqui = mv.venda_id && db.prepare('SELECT 1 FROM sales WHERE id = ?').get(mv.venda_id) ? mv.venda_id : null;
        db.prepare(
          `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, sale_id, operador_id, device_id, criado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(mv.id, alvo.id, locationId, TIPO_MOV_ESTOQUE[mv.tipo] || 'ajuste', qtd(mv.qtd_mil), mv.motivo ? `${mv.motivo} (PDV mobile)` : 'PDV mobile',
          vendaAqui, usuario(mv.usuario_id), deviceId, dataDesktop(mv.criado_em));
        resumo.estoque.movimentosReplicados += 1;
      }
    }

    // --- Fiado
    for (const c of m.clientes) {
      const alvo = mapaCliente.get(c.id);
      const primeiraVezDesteCliente = alvo.novo || (corte == null);
      if (!primeiraVezDesteCliente || c.saldo_fiado_centavos === 0) continue;
      const idMov = `migr-${installId}-${c.id}`;
      if (db.prepare('SELECT 1 FROM customer_credit_movements WHERE id = ?').get(idMov)) continue;
      const devendo = c.saldo_fiado_centavos > 0;
      db.prepare(
        `INSERT INTO customer_credit_movements (id, customer_id, tipo, valor, motivo, operador_id, criado_em) VALUES (?, ?, ?, ?, ?, ?, NOW_SYNCED())`,
      ).run(idMov, alvo.id, devendo ? 'divida' : 'pagamento', reais(Math.abs(c.saldo_fiado_centavos)), 'Saldo de fiado migrado do PDV mobile', operadorId);
      resumo.fiado.saldosIniciais += 1;
    }
    if (corte != null) {
      for (const f of m.fiado) {
        if (f.criado_em <= corteIso) continue;
        const alvo = mapaCliente.get(f.cliente_id);
        if (!alvo || alvo.novo) continue;
        if (db.prepare('SELECT 1 FROM customer_credit_movements WHERE id = ?').get(f.id)) continue;
        const ehDivida = f.valor_centavos > 0;
        db.prepare(
          `INSERT INTO customer_credit_movements (id, customer_id, tipo, valor, sale_id, motivo, operador_id, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(f.id, alvo.id, ehDivida ? 'divida' : 'pagamento', reais(Math.abs(f.valor_centavos)),
          f.venda_id && db.prepare('SELECT 1 FROM sales WHERE id = ?').get(f.venda_id) ? f.venda_id : null,
          f.tipo === 'estorno' ? 'Estorno de venda cancelada (PDV mobile)' : 'PDV mobile', usuario(f.usuario_id), dataDesktop(f.criado_em));
        resumo.fiado.lancamentosReplicados += 1;
      }
    }

    resumo.conferencia = conferir(db, m, { mapaProduto, mapaCliente, locationId });

    db.prepare('INSERT INTO pdv_mobile_migracoes (id, install_id_mobile, nome_mobile, gerado_em_ms, operador_id, resumo) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), installId, dump.nomeNegocio || null, dump.geradoEmMs, operadorId, JSON.stringify(resumo));

    if (previa) throw new DesfazerPrevia();
  });

  try {
    executar();
  } catch (err) {
    if (!(err instanceof DesfazerPrevia)) throw err;
  }
  return resumo;
}

/**
 * Conferência lado a lado, dentro da transação: se algo não bater, lança
 * e a transação inteira é desfeita.
 */
function conferir(db, m, { mapaProduto, mapaCliente, locationId }) {
  const linhasConf = [];
  const checar = (rotulo, celular, computador) => {
    const ok = Math.abs(celular - computador) < 0.005;
    linhasConf.push({ rotulo, celular: arred(celular), computador: arred(computador), ok });
    return ok;
  };

  // Integridade do próprio backup, venda a venda: itens = subtotal e
  // pagamentos = total. Pega arquivo corrompido/adulterado -- comparar só
  // "computador x backup" deixaria passar um backup errado de forma consistente.
  const somaItens = new Map();
  for (const i of m.itens) somaItens.set(i.venda_id, (somaItens.get(i.venda_id) || 0) + i.total_centavos);
  const somaPag = new Map();
  for (const p of m.pagamentos) somaPag.set(p.venda_id, (somaPag.get(p.venda_id) || 0) + p.valor_centavos);
  let vendasIntegras = 0;
  for (const v of m.vendas) {
    if (!['finalizada', 'cancelada'].includes(v.status)) continue;
    const itensOk = (somaItens.get(v.id) || 0) === v.subtotal_centavos;
    const pagOk = (somaPag.get(v.id) || 0) === v.total_centavos;
    if (!itensOk) checar(`Venda ${v.numero}: itens x subtotal`, reais(somaItens.get(v.id) || 0), reais(v.subtotal_centavos));
    if (!pagOk) checar(`Venda ${v.numero}: pagamentos x total`, reais(somaPag.get(v.id) || 0), reais(v.total_centavos));
    if (itensOk && pagOk) vendasIntegras += 1;
  }
  linhasConf.unshift({ rotulo: `Integridade do backup: vendas com itens e pagamentos fechando`, celular: vendasIntegras, computador: vendasIntegras, ok: true });

  // Vendas: compara venda a venda as que estão finalizadas nos DOIS lados
  // (uma venda já importada e depois cancelada AQUI no computador sai da
  // conta dos dois lados, senão a segunda importação nunca passaria).
  const finalizadasCel = m.vendas.filter((v) => v.status === 'finalizada');
  const conferidas = [];
  for (const v of finalizadasCel) {
    const aqui = db.prepare('SELECT status, total - desconto - desconto_gerente AS liquido FROM sales WHERE id = ?').get(v.id);
    if (!aqui) throw new ErroMigracao(`Venda ${v.numero} do celular não entrou no computador -- nada foi gravado.`);
    if (aqui.status === 'finalizada') conferidas.push({ v, liquido: aqui.liquido });
  }
  checar(`Vendas finalizadas (${conferidas.length})`, conferidas.reduce((s, c) => s + reais(c.v.total_centavos), 0), conferidas.reduce((s, c) => s + c.liquido, 0));
  const idsConferidos = new Set(conferidas.map((c) => c.v.id));
  const porMetodoCel = {};
  for (const p of m.pagamentos) {
    if (!idsConferidos.has(p.venda_id)) continue;
    const met = METODO[p.metodo] || 'outro';
    porMetodoCel[met] = (porMetodoCel[met] || 0) + reais(p.valor_centavos);
  }
  const porMetodoAqui = {};
  const ids = [...idsConferidos];
  for (let i = 0; i < ids.length; i += 500) {
    const lote = ids.slice(i, i + 500);
    for (const r of db.prepare(`SELECT metodo, SUM(valor) AS t FROM payments WHERE sale_id IN (${lote.map(() => '?').join(',')}) GROUP BY metodo`).all(...lote)) {
      porMetodoAqui[r.metodo] = (porMetodoAqui[r.metodo] || 0) + r.t;
    }
  }
  for (const met of new Set([...Object.keys(porMetodoCel), ...Object.keys(porMetodoAqui)])) {
    checar(`Recebido em ${NOME_METODO[met] || met}`, porMetodoCel[met] || 0, porMetodoAqui[met] || 0);
  }

  // Saldos: só exige igualdade no que nasceu NESTA importação (produto/
  // cliente novo aqui). O que já existia também é movimentado pelo
  // próprio computador (vendeu aqui, recebeu fiado aqui), então o saldo
  // dos dois lados pode -- e deve -- ser diferente.
  for (const p of m.produtos) {
    const alvo = mapaProduto.get(p.id);
    if (!alvo.controla || !alvo.novo) continue;
    checar(`Estoque: ${p.nome}`, qtd(p.estoque_mil), saldoEstoque(db, alvo.id, locationId));
  }
  for (const c of m.clientes) {
    const alvo = mapaCliente.get(c.id);
    if (!alvo.novo) continue;
    checar(`Fiado: ${c.nome}`, reais(c.saldo_fiado_centavos), saldoFiado(db, alvo.id));
  }

  const erros = linhasConf.filter((l) => !l.ok);
  if (erros.length) {
    const lista = erros.slice(0, 5).map((e) => `${e.rotulo}: celular ${e.celular.toFixed(2)} x computador ${e.computador.toFixed(2)}`).join('; ');
    throw new ErroMigracao(`A conferência não bateu (${erros.length} item(ns)) -- nada foi gravado. ${lista}`);
  }
  return { linhas: linhasConf, tudoBateu: true };
}

// ---------------------------------------------------------------------------
// Parte de rede (Firestore/Storage do mesmo projeto do licenciamento).

function nuvem() {
  const licenseService = require('./licenseService');
  const app = licenseService.getLicenseApp();
  const fs = require('firebase/firestore');
  const st = require('firebase/storage');
  return { app, fs, st, db: fs.getFirestore(app), storage: st.getStorage(app) };
}

function msDe(ts) {
  return ts && typeof ts.toMillis === 'function' ? ts.toMillis() : null;
}

async function meuClienteId() {
  const { fs, db } = nuvem();
  const meuId = require('./pdvRegistryService').getOrCreateDeviceUid();
  const snap = await fs.getDoc(fs.doc(db, 'installations', meuId));
  return { meuId, clienteId: snap.exists() ? snap.data().clienteId || null : null, nomeNegocio: snap.exists() ? snap.data().nomeNegocio || null : null };
}

/** Celulares PDV mobile autônomo do mesmo cliente deste computador (vínculo feito na Central). */
async function listarCelularesDoCliente() {
  const { fs, db } = nuvem();
  const { clienteId } = await meuClienteId();
  if (!clienteId) {
    return { ok: false, error: 'Este computador ainda não está vinculado a um cliente na Central. Peça ao suporte para vincular (Central → Vincular a cliente) e tente de novo.' };
  }
  const snap = await fs.getDocs(fs.query(fs.collection(db, 'installations'), fs.where('clienteId', '==', clienteId)));
  const celulares = snap.docs
    .filter((d) => d.data().tipo === TIPO_INSTALACAO_MOBILE)
    .map((d) => {
      const x = d.data();
      return {
        installId: d.id, nomeNegocio: x.nomeNegocio || 'PDV mobile', versaoApp: x.versaoApp || null,
        ultimoContatoMs: msDe(x.ultimoPing) || msDe(x.ultimoContato), ultimoBackupMs: msDe(x.ultimoBackupNuvemEm),
        migradoParaNome: x.migradoParaNome || null, migradoEmMs: msDe(x.migradoEm),
      };
    });
  const db2 = getDb();
  for (const c of celulares) c.importadoAquiEmMs = corteAnterior(db2, c.installId);
  return { ok: true, celulares };
}

async function backupsDoCelular(installId) {
  const { fs, db } = nuvem();
  const snap = await fs.getDocs(fs.query(fs.collection(db, 'installations', installId, 'backups'), fs.orderBy('criadoEm', 'desc'), fs.limit(10)));
  return snap.docs.map((d) => ({ ...d.data(), criadoEmMs: d.data().criadoEmMs || msDe(d.data().criadoEm) }))
    .filter((b) => b.formato === 'mobile-json-gz' && b.caminhoStorage);
}

/**
 * Pede ao celular um backup novo (se estiver online ele sobe em segundos)
 * e baixa o mais recente. Se o celular não responder a tempo, usa o
 * último que já estiver na nuvem -- e avisa a idade dele.
 */
async function baixarBackupMaisRecente(installId, { esperarMs = 45000, aoProgresso = () => {} } = {}) {
  const { fs, st, db, storage } = nuvem();
  const antes = (await backupsDoCelular(installId))[0];
  const pedidoEm = Date.now();
  await fs.setDoc(fs.doc(db, 'installations', installId), { backupSolicitadoEm: pedidoEm }, { merge: true });
  aoProgresso('pedindo');
  let escolhido = antes;
  const limite = Date.now() + esperarMs;
  while (Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 3000));
    const atual = (await backupsDoCelular(installId))[0];
    if (atual && (!antes || atual.nomeArquivo !== antes.nomeArquivo) && atual.criadoEmMs >= pedidoEm - 60000) { escolhido = atual; break; }
  }
  if (!escolhido) throw new ErroMigracao('Esse celular ainda não tem nenhum backup na nuvem. Abra o app no celular com internet e tente de novo.');
  aoProgresso('baixando');
  const bytes = await st.getBytes(st.ref(storage, escolhido.caminhoStorage));
  const dump = JSON.parse(zlib.gunzipSync(Buffer.from(bytes)).toString('utf-8'));
  validarDump(dump);
  if (dump.installId !== installId) throw new ErroMigracao('O backup baixado não é deste celular.');
  return { dump, arquivo: escolhido.nomeArquivo, recente: escolhido !== antes, idadeMs: Date.now() - (dump.geradoEmMs || 0) };
}

async function nomeDoNegocioDoCelular(installId) {
  const { fs, db } = nuvem();
  const snap = await fs.getDoc(fs.doc(db, 'installations', installId));
  return snap.exists() ? snap.data().nomeNegocio || null : null;
}

/** Pré-visualização: baixa, roda a importação inteira com conferência e desfaz. */
async function previsualizar(installId, { operadorId }) {
  try {
    const b = await baixarBackupMaisRecente(installId);
    b.dump.nomeNegocio = await nomeDoNegocioDoCelular(installId);
    const resumo = importarDump(b.dump, { operadorId, previa: true });
    return { ok: true, resumo, arquivo: b.arquivo, backupRecente: b.recente, idadeMinutos: Math.round(b.idadeMs / 60000) };
  } catch (err) {
    return { ok: false, error: err instanceof ErroMigracao ? err.message : `Falha ao preparar a migração: ${err.message}` };
  }
}

/** Importa de verdade e marca na Central que este celular foi migrado pra cá (item "histórico" do painel). */
async function importar(installId, { operadorId }) {
  try {
    const b = await baixarBackupMaisRecente(installId);
    b.dump.nomeNegocio = await nomeDoNegocioDoCelular(installId);
    const resumo = importarDump(b.dump, { operadorId });
    try {
      const { fs, db } = nuvem();
      const { meuId, nomeNegocio } = await meuClienteId();
      await fs.setDoc(fs.doc(db, 'installations', installId), {
        migradoPara: meuId,
        migradoParaNome: nomeNegocio || 'computador',
        migradoEm: fs.serverTimestamp(),
        migradoBackupArquivo: b.arquivo,
        // Horário do retrato importado: se o celular virar terminal daqui,
        // ele manda tudo o que fez a partir deste instante.
        migradoCorteMs: b.dump.geradoEmMs,
        // Mantém o máximo de histórico de backup do celular depois de migrar.
        backupRetencaoDias: 30,
      }, { merge: true });
    } catch (err) {
      console.warn('[pdvMobileMigracao] importado, mas não consegui registrar na Central:', err.message);
      resumo.avisoCentral = 'Dados importados, mas não consegui registrar a migração na Central (sem internet?). Os dados já estão neste computador.';
    }
    return { ok: true, resumo, arquivo: b.arquivo, backupRecente: b.recente, idadeMinutos: Math.round(b.idadeMs / 60000) };
  } catch (err) {
    return { ok: false, error: err instanceof ErroMigracao ? err.message : `Falha na migração: ${err.message}` };
  }
}

function historico() {
  const db = getDb();
  garantirTabela(db);
  return db.prepare(
    `SELECT m.*, u.nome AS operador_nome FROM pdv_mobile_migracoes m LEFT JOIN users u ON u.id = m.operador_id ORDER BY m.importado_em DESC LIMIT 20`,
  ).all().map((r) => ({ ...r, resumo: JSON.parse(r.resumo || '{}') }));
}

module.exports = {
  importarDump, validarDump, dataDesktop, listarCelularesDoCliente, previsualizar, importar, historico, ErroMigracao,
  // Usados pelo modo terminal (pdvMobileTerminalService.js) -- mesmas regras de conversão.
  garantirTabela, corteAnterior, METODO, TIPO_MOV_ESTOQUE, PAPEL, reais, qtd, nuvem, meuClienteId, TIPO_INSTALACAO_MOBILE,
};
