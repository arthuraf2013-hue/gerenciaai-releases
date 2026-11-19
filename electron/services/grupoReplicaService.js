// Caixas do grupo como extensão um do outro: produtos, clientes e o fiado
// iguais em todos (usuários e PINs ficam no userSyncService).
//
// Cada caixa tem a cópia completa no próprio banco -- continua vendendo
// sem internet e acerta quando a conexão volta. Pelo Firestore:
//   grupos_sincronizacao/{g}/produtos/{doc}   cadastro do produto
//   grupos_sincronizacao/{g}/clientes/{doc}   cadastro do cliente
//   grupos_sincronizacao/{g}/fiado/{id}       lançamento do fiado (só inclusão)
//
// Regras:
// - O que muda AQUI entra na fila pelos triggers (migração 13) -- vale
//   para qualquer caminho (tela, planilha, nota de entrada, promoção) --
//   e vai para o grupo em segundo plano. O que vem DO grupo é gravado com
//   a marca `grupo_replica_aplicando`, e não volta para a fila.
// - Vence a alteração mais nova (versaoMs). Docs de versões antigas do app
//   (sem versaoMs) valem pela hora do servidor (atualizadoEm).
// - Caixa que entra no grupo casa o que já tinha com o do grupo: produto
//   pelo código de barras (ou SKU; sem os dois, pelo nome), cliente pelo
//   CPF/CNPJ (ou nome + telefone). O id local pode ser diferente do id no
//   grupo (`grupo_replica`); o estoque do grupo usa o id do grupo
//   (paraGrupo). Nada é apagado nem mesclado sozinho.
// - Dois caixas que publicaram o MESMO produto antes de se verem: fica o
//   documento de id menor (os dois chegam à mesma escolha) e o outro vira
//   lápide (`excluido`, `substituidoPor`).
// - Fiado: cada lançamento vai uma vez e entra uma vez; o saldo do cliente
//   (soma do livro) fica igual em todos os caixas. O lançamento de fora
//   não aponta para venda local (sale_id nulo) -- a venda está no outro caixa.
// - Foto do produto: coleção própria ('fotos'), o produto leva só o
//   fotoHash -- ver grupoFotoService.
// - Fica por caixa: estoque físico (o do grupo é o contador do servidor),
//   pontos de fidelidade, controles de automação.

const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const syncStateService = require('./syncStateService');

const LOTE = 400; // Firestore recusa mais de 500 escritas por lote

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function grupoAtual() {
  try { return syncStateService.getGrupoSincronizacaoId() || null; } catch { return null; }
}

function origemDesteCaixa() {
  try { return require('./pdvRegistryService').getOrCreateDeviceUid(); } catch { return null; }
}

function nomeDesteCaixa() {
  try { return require('./licenseService').nomeDoComputador() || null; } catch { return null; }
}

function normalizarTexto(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

const soDigitos = (t) => String(t || '').replace(/\D/g, '');

/** Versão do documento: versaoMs; doc antigo, a hora do servidor. */
function versaoDoDoc(d) {
  if (Number.isFinite(d?.versaoMs) && d.versaoMs > 0) return d.versaoMs;
  const t = d?.atualizadoEm;
  if (t && typeof t.toMillis === 'function') return t.toMillis();
  if (Number.isFinite(t?.seconds)) return t.seconds * 1000;
  return 1;
}

const numOuNulo = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const textoOuNulo = (v, max = 200) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim().slice(0, max));

/** Grava sem os triggers devolverem a alteração para a fila. */
function comoDoGrupo(db, fn) {
  db.prepare('INSERT OR IGNORE INTO grupo_replica_aplicando (id) VALUES (1)').run();
  try { return fn(); } finally { db.prepare('DELETE FROM grupo_replica_aplicando').run(); }
}

// ---------------------------------------------------------------------------
// Entidades
// ---------------------------------------------------------------------------

const PRODUTOS = {
  nome: 'produtos',
  ler: (db, id) => db.prepare('SELECT * FROM products WHERE id = ?').get(id),
  listar: (db) => db.prepare('SELECT * FROM products').all(),
  // Produto inativo que nunca foi para o grupo não precisa ir.
  podeEntrar: (p) => p.ativo === 1,
  paraDoc: (p) => ({
    nome: p.nome, categoria: p.categoria ?? null, preco: Number(p.preco) || 0, custo: Number(p.custo) || 0,
    unidade: p.unidade || 'un', sku: p.sku ?? null, codigoBarras: p.codigo_barras ?? null,
    ncm: p.ncm ?? null, cest: p.cest ?? null, cfop: p.cfop ?? null, cstCsosn: p.cst_csosn ?? null,
    origemMercadoria: p.origem_mercadoria ?? '0', estoqueMinimo: Number(p.estoque_minimo) || 0,
    ativo: p.ativo === 1, tipo: p.tipo || 'produto',
    precoPromocional: p.preco_promocional ?? null, promocaoValidaAte: p.promocao_valida_ate ?? null,
    codigoBalanca: p.codigo_balanca ?? null, customFields: p.custom_fields ?? null,
    excluido: false,
  }),
  docValido: (d) => !!d && (d.excluido === true
    || (typeof d.nome === 'string' && d.nome.trim().length > 0 && d.nome.length <= 300
      && Number.isFinite(Number(d.preco)) && Number(d.preco) >= 0)),
  /** Produto daqui, ainda sem vínculo, que é o mesmo do documento. */
  acharEquivalente(db, d, vinculados) {
    const livre = (p) => p && !vinculados.has(p.id);
    if (d.codigoBarras) {
      const p = db.prepare('SELECT * FROM products WHERE codigo_barras = ?').get(String(d.codigoBarras));
      return livre(p) ? p.id : null;
    }
    if (d.sku) {
      const p = db.prepare('SELECT * FROM products WHERE sku = ?').get(String(d.sku));
      return livre(p) ? p.id : null;
    }
    const alvo = normalizarTexto(d.nome);
    const p = db.prepare(`SELECT * FROM products WHERE ativo = 1 AND codigo_barras IS NULL AND sku IS NULL`).all()
      .find((x) => livre(x) && normalizarTexto(x.nome) === alvo && (x.unidade || 'un') === (d.unidade || 'un'));
    return p ? p.id : null;
  },
  /** Produto daqui JÁ vinculado a outro documento, com a mesma chave. */
  acharVinculadoComMesmaChave(db, d, docIdDoLocal) {
    let p = null;
    if (d.codigoBarras) p = db.prepare('SELECT * FROM products WHERE codigo_barras = ?').get(String(d.codigoBarras));
    else if (d.sku) p = db.prepare('SELECT * FROM products WHERE sku = ?').get(String(d.sku));
    if (!p) return null;
    const docId = docIdDoLocal(p.id);
    return docId ? { localId: p.id, docId } : null;
  },
  aplicar(db, localId, d) {
    // Código de barras / SKU que outro produto daqui já usa: grava sem,
    // e guarda o código como conflito (mesmo mecanismo da tela de Produtos).
    const ocupado = (col, valor) => valor && db.prepare(`SELECT 1 FROM products WHERE ${col} = ? AND id <> ?`).get(valor, localId);
    const codigo = textoOuNulo(d.codigoBarras, 64);
    const sku = textoOuNulo(d.sku, 64);
    const codigoLivre = ocupado('codigo_barras', codigo) ? null : codigo;
    const valores = {
      id: localId, nome: String(d.nome).trim().slice(0, 300), categoria: textoOuNulo(d.categoria),
      preco: Number(d.preco) || 0, custo: Number(d.custo) || 0, unidade: textoOuNulo(d.unidade, 10) || 'un',
      sku: ocupado('sku', sku) ? null : sku, codigoBarras: codigoLivre,
      conflito: codigo && !codigoLivre ? codigo : null,
      ncm: textoOuNulo(d.ncm, 20), cest: textoOuNulo(d.cest, 20), cfop: textoOuNulo(d.cfop, 10),
      cstCsosn: textoOuNulo(d.cstCsosn, 10), origem: textoOuNulo(d.origemMercadoria, 2) || '0',
      estoqueMinimo: Number(d.estoqueMinimo) || 0, ativo: d.ativo === false ? 0 : 1,
      tipo: d.tipo === 'servico' ? 'servico' : 'produto',
      precoPromocional: numOuNulo(d.precoPromocional), promocaoValidaAte: textoOuNulo(d.promocaoValidaAte, 40),
      codigoBalanca: textoOuNulo(d.codigoBalanca, 20),
      customFields: typeof d.customFields === 'string' ? d.customFields.slice(0, 20000) : null,
    };
    db.prepare(
      `INSERT INTO products (id, nome, categoria, preco, custo, unidade, sku, codigo_barras, conflito_codigo_barras_pendente,
         ncm, cest, cfop, cst_csosn, origem_mercadoria, estoque_minimo, ativo, tipo, preco_promocional,
         promocao_valida_ate, codigo_balanca, custom_fields)
       VALUES (@id, @nome, @categoria, @preco, @custo, @unidade, @sku, @codigoBarras, @conflito,
         @ncm, @cest, @cfop, @cstCsosn, @origem, @estoqueMinimo, @ativo, @tipo, @precoPromocional,
         @promocaoValidaAte, @codigoBalanca, COALESCE(@customFields, '{}'))
       ON CONFLICT(id) DO UPDATE SET
         nome = excluded.nome, categoria = excluded.categoria, preco = excluded.preco, custo = excluded.custo,
         unidade = excluded.unidade, sku = excluded.sku, codigo_barras = excluded.codigo_barras,
         conflito_codigo_barras_pendente = excluded.conflito_codigo_barras_pendente,
         ncm = excluded.ncm, cest = excluded.cest, cfop = excluded.cfop, cst_csosn = excluded.cst_csosn,
         origem_mercadoria = excluded.origem_mercadoria, estoque_minimo = excluded.estoque_minimo,
         ativo = excluded.ativo, tipo = excluded.tipo, preco_promocional = excluded.preco_promocional,
         promocao_valida_ate = excluded.promocao_valida_ate, codigo_balanca = excluded.codigo_balanca,
         custom_fields = COALESCE(@customFields, products.custom_fields)`
    ).run(valores);
  },
  /** Lápide do grupo: igual a excluir aqui (libera código e SKU). */
  desativar(db, localId) {
    db.prepare('UPDATE products SET ativo = 0, codigo_barras = NULL, sku = NULL WHERE id = ?').run(localId);
  },
  /** Depois de gravar o que veio do grupo: a foto (grupoFotoService). */
  depoisDeAplicar(db, grupoId, localId, docId, d) {
    require('./grupoFotoService').aoReceberProduto(db, grupoId, localId, docId, d);
  },
  /** Campos que dependem de mais que a linha do produto. */
  extrasDoDoc(db, grupoId, p) {
    return require('./grupoFotoService').campoDaFoto(db, grupoId, p);
  },
};

const CLIENTES = {
  nome: 'clientes',
  ler: (db, id) => db.prepare('SELECT * FROM customers WHERE id = ?').get(id),
  listar: (db) => db.prepare('SELECT * FROM customers').all(),
  podeEntrar: (c) => c.ativo === 1,
  paraDoc: (c) => ({
    nome: c.nome, telefone: c.telefone ?? null, cpf: c.cpf ?? null, cnpj: c.cnpj ?? null,
    ativo: c.ativo === 1, dataNascimento: c.data_nascimento ?? null,
    limiteFiado: c.limite_fiado ?? null, fiadoBloqueado: c.fiado_bloqueado === 1,
    excluido: false,
  }),
  docValido: (d) => !!d && (d.excluido === true
    || (typeof d.nome === 'string' && d.nome.trim().length > 0 && d.nome.length <= 200)),
  acharEquivalente(db, d, vinculados) {
    const todos = db.prepare('SELECT * FROM customers').all().filter((c) => !vinculados.has(c.id));
    const cpf = soDigitos(d.cpf);
    const cnpj = soDigitos(d.cnpj);
    if (cpf.length === 11) { const c = todos.find((x) => soDigitos(x.cpf) === cpf); if (c) return c.id; }
    if (cnpj.length === 14) { const c = todos.find((x) => soDigitos(x.cnpj) === cnpj); if (c) return c.id; }
    const tel = soDigitos(d.telefone);
    if (tel.length >= 8) {
      const nome = normalizarTexto(d.nome);
      const c = todos.find((x) => soDigitos(x.telefone) === tel && normalizarTexto(x.nome) === nome);
      if (c) return c.id;
    }
    return null;
  },
  acharVinculadoComMesmaChave(db, d, docIdDoLocal) {
    const cpf = soDigitos(d.cpf);
    const cnpj = soDigitos(d.cnpj);
    let c = null;
    if (cpf.length === 11) c = db.prepare('SELECT * FROM customers').all().find((x) => soDigitos(x.cpf) === cpf);
    else if (cnpj.length === 14) c = db.prepare('SELECT * FROM customers').all().find((x) => soDigitos(x.cnpj) === cnpj);
    if (!c) return null;
    const docId = docIdDoLocal(c.id);
    return docId ? { localId: c.id, docId } : null;
  },
  aplicar(db, localId, d) {
    const limite = numOuNulo(d.limiteFiado);
    db.prepare(
      `INSERT INTO customers (id, nome, telefone, cpf, cnpj, ativo, data_nascimento, limite_fiado, fiado_bloqueado)
       VALUES (@id, @nome, @telefone, @cpf, @cnpj, @ativo, @nascimento, @limite, @bloqueado)
       ON CONFLICT(id) DO UPDATE SET
         nome = excluded.nome, telefone = excluded.telefone, cpf = excluded.cpf, cnpj = excluded.cnpj,
         ativo = excluded.ativo, data_nascimento = excluded.data_nascimento,
         limite_fiado = excluded.limite_fiado, fiado_bloqueado = excluded.fiado_bloqueado`
    ).run({
      id: localId, nome: String(d.nome).trim().slice(0, 200), telefone: textoOuNulo(d.telefone, 30),
      cpf: textoOuNulo(d.cpf, 20), cnpj: textoOuNulo(d.cnpj, 25), ativo: d.ativo === false ? 0 : 1,
      nascimento: textoOuNulo(d.dataNascimento, 10), limite: limite !== null && limite >= 0 ? limite : null,
      bloqueado: d.fiadoBloqueado === true ? 1 : 0,
    });
  },
  desativar(db, localId) {
    db.prepare('UPDATE customers SET ativo = 0 WHERE id = ?').run(localId);
  },
};

const ENTIDADES = { produtos: PRODUTOS, clientes: CLIENTES };

// ---------------------------------------------------------------------------
// Vínculos (grupo_replica)
// ---------------------------------------------------------------------------

function vinculos(db, entidade, grupoId) {
  const linhas = db.prepare('SELECT local_id, doc_id, versao_ms FROM grupo_replica WHERE entidade = ? AND grupo_id = ?').all(entidade, grupoId);
  return {
    porDoc: new Map(linhas.map((v) => [v.doc_id, v])),
    porLocal: new Map(linhas.map((v) => [v.local_id, v])),
  };
}

function gravarVinculo(db, entidade, grupoId, localId, docId, versao, mapa) {
  // Um doc só pode estar ligado a um registro daqui (e vice-versa).
  db.prepare('DELETE FROM grupo_replica WHERE entidade = ? AND grupo_id = ? AND (doc_id = ? OR local_id = ?)').run(entidade, grupoId, docId, localId);
  db.prepare('INSERT INTO grupo_replica (entidade, local_id, grupo_id, doc_id, versao_ms) VALUES (?, ?, ?, ?, ?)')
    .run(entidade, localId, grupoId, docId, versao);
  if (mapa) {
    const antigo = mapa.porLocal.get(localId);
    if (antigo) mapa.porDoc.delete(antigo.doc_id);
    const v = { local_id: localId, doc_id: docId, versao_ms: versao };
    mapa.porDoc.set(docId, v);
    mapa.porLocal.set(localId, v);
  }
}

function enfileirar(db, entidade, localId) {
  db.prepare(`INSERT INTO grupo_replica_pendente (entidade, local_id, marca) VALUES (?, ?, abs(random()))
              ON CONFLICT(entidade, local_id) DO UPDATE SET marca = abs(random())`).run(entidade, localId);
}

/** Id do produto no grupo (o contador de estoque usa este). */
function paraGrupo(productId) {
  try {
    const grupoId = grupoAtual();
    if (!grupoId || !productId) return productId;
    const v = getDb().prepare(`SELECT doc_id FROM grupo_replica WHERE entidade = 'produtos' AND grupo_id = ? AND local_id = ?`).get(grupoId, productId);
    return v?.doc_id || productId;
  } catch { return productId; }
}

/** Cliente daqui ligado a este documento do grupo. */
function localDoCliente(db, grupoId, docId) {
  return db.prepare(`SELECT local_id FROM grupo_replica WHERE entidade = 'clientes' AND grupo_id = ? AND doc_id = ?`).get(grupoId, docId)?.local_id || null;
}

// ---------------------------------------------------------------------------
// Juntar o que veio do grupo
// ---------------------------------------------------------------------------

/**
 * @param {string} entidade 'produtos' | 'clientes'
 * @param {Map<string, object>} remotos docId -> dados (todos, ou só os que mudaram)
 * @param {{completo?: boolean}} opcoes completo = é o grupo inteiro (põe na fila quem ainda não foi)
 * @returns {Array<{docId, dados}>} lápides a publicar já (documentos substituídos)
 */
function mesclar(entidade, grupoId, remotos, { completo = false } = {}) {
  const E = ENTIDADES[entidade];
  const db = getDb();
  const lapides = [];

  db.transaction(() => comoDoGrupo(db, () => {
    const mapa = vinculos(db, entidade, grupoId);
    const docDoLocal = (localId) => mapa.porLocal.get(localId)?.doc_id || null;

    // Ordem estável: o mesmo resultado em todos os caixas.
    for (const docId of [...remotos.keys()].sort()) {
      const d = remotos.get(docId);
      if (!E.docValido(d)) continue;
      const versao = versaoDoDoc(d);
      let v = mapa.porDoc.get(docId);

      if (!v) {
        if (d.excluido === true) continue; // lápide de algo que nunca esteve aqui
        // Mesmo id já aqui (trazido antes pelo "importar do grupo"): é ele.
        const mesmoId = E.ler(db, docId) && !mapa.porLocal.has(docId) ? docId : null;
        const equivalente = mesmoId || E.acharEquivalente(db, d, new Set(mapa.porLocal.keys()));
        if (equivalente) {
          gravarVinculo(db, entidade, grupoId, equivalente, docId, 0, mapa);
          v = mapa.porDoc.get(docId);
        } else {
          const outro = E.acharVinculadoComMesmaChave(db, d, docDoLocal);
          if (outro && outro.docId !== docId) {
            // Os dois caixas publicaram o mesmo antes de se verem: vale o id menor.
            if (docId > outro.docId) continue;
            gravarVinculo(db, entidade, grupoId, outro.localId, docId, 0, mapa);
            lapides.push({ docId: outro.docId, dados: { excluido: true, ativo: false, substituidoPor: docId } });
            v = mapa.porDoc.get(docId);
          } else {
            const localId = E.ler(db, docId) ? randomUUID() : docId;
            E.aplicar(db, localId, d);
            E.depoisDeAplicar?.(db, grupoId, localId, docId, d);
            gravarVinculo(db, entidade, grupoId, localId, docId, versao, mapa);
            continue;
          }
        }
      }

      if (versao > v.versao_ms) {
        if (d.excluido === true) E.desativar(db, v.local_id);
        else {
          E.aplicar(db, v.local_id, d);
          E.depoisDeAplicar?.(db, grupoId, v.local_id, docId, d);
        }
        gravarVinculo(db, entidade, grupoId, v.local_id, docId, versao, mapa);
      } else if (versao < v.versao_ms && E.ler(db, v.local_id)) {
        enfileirar(db, entidade, v.local_id); // daqui é mais novo: sobe de novo
      }
    }

    if (!completo) return;
    for (const linha of E.listar(db)) {
      const v = mapa.porLocal.get(linha.id);
      if (!v && E.podeEntrar(linha)) enfileirar(db, entidade, linha.id);
      else if (v && !remotos.has(v.doc_id)) enfileirar(db, entidade, linha.id); // grupo recriado
    }
  }))();

  return lapides;
}

// ---------------------------------------------------------------------------
// Fiado (livro só de inclusão)
// ---------------------------------------------------------------------------

function fiadoValido(d) {
  return !!d && ['divida', 'pagamento'].includes(d.tipo) && Number.isFinite(Number(d.valor))
    && Number(d.valor) > 0 && Number(d.valor) < 1e7 && typeof d.clienteDoc === 'string' && d.clienteDoc.length > 0;
}

/** Lançamentos do grupo que ainda não estão aqui. Devolve os que esperam o cliente chegar. */
function receberFiado(grupoId, remotos) {
  const db = getDb();
  const aguardando = new Map();
  db.transaction(() => comoDoGrupo(db, () => {
    const jaTem = db.prepare(`SELECT 1 FROM grupo_replica_livro WHERE livro = 'fiado' AND grupo_id = ? AND item_id = ?`);
    const marcar = db.prepare(`INSERT OR IGNORE INTO grupo_replica_livro (livro, grupo_id, item_id) VALUES ('fiado', ?, ?)`);
    for (const [id, d] of remotos) {
      if (!fiadoValido(d) || jaTem.get(grupoId, id)) continue;
      if (db.prepare('SELECT 1 FROM customer_credit_movements WHERE id = ?').get(id)) { marcar.run(grupoId, id); continue; }
      const clienteId = localDoCliente(db, grupoId, d.clienteDoc);
      if (!clienteId) { aguardando.set(id, d); continue; }
      const onde = d.nomeComputador ? ` (caixa ${String(d.nomeComputador).slice(0, 63)})` : ' (outro caixa)';
      const motivo = (textoOuNulo(d.motivo, 300) || (d.tipo === 'divida' ? 'Fiado' : 'Pagamento de fiado')) + onde;
      db.prepare(
        `INSERT INTO customer_credit_movements (id, customer_id, tipo, valor, sale_id, motivo, operador_id, criado_em)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, COALESCE(?, NOW_SYNCED()))`
      ).run(id, clienteId, d.tipo, Math.round(Number(d.valor) * 100) / 100, motivo, textoOuNulo(d.criadoEm, 30));
      marcar.run(grupoId, id);
    }
  }))();
  return aguardando;
}

/** Lançamentos daqui que ainda não foram (só de cliente que já está no grupo). */
function fiadoParaEnviar(db, grupoId) {
  return db.prepare(
    `SELECT m.*, r.doc_id AS cliente_doc FROM customer_credit_movements m
     JOIN grupo_replica r ON r.entidade = 'clientes' AND r.grupo_id = ? AND r.local_id = m.customer_id
     WHERE NOT EXISTS (SELECT 1 FROM grupo_replica_livro l WHERE l.livro = 'fiado' AND l.grupo_id = ? AND l.item_id = m.id)
     LIMIT 2000`
  ).all(grupoId, grupoId);
}

// ---------------------------------------------------------------------------
// Firestore (trocável nos testes)
// ---------------------------------------------------------------------------

// Rede local (grupoTransporteService): com servidor na loja, tudo vai por
// ele; senão, Firestore.
let backend = {
  async lerTodos(grupoId, colecao) {
    const lan = require('./grupoTransporteService').backend('replica');
    if (lan) return lan.lerTodos(grupoId, colecao);
    const firestore = require('./licenseService').getLicenseFirestore();
    const { collection, getDocs } = require('firebase/firestore');
    const snap = await getDocs(collection(firestore, 'grupos_sincronizacao', grupoId, colecao));
    return new Map(snap.docs.map((d) => [d.id, d.data()]));
  },
  /** Só os documentos pedidos (fotos). */
  async lerAlguns(grupoId, colecao, ids) {
    const lan = require('./grupoTransporteService').backend('replica');
    if (lan) return lan.lerAlguns(grupoId, colecao, ids);
    const firestore = require('./licenseService').getLicenseFirestore();
    const { doc, getDoc } = require('firebase/firestore');
    const { comPrazo } = require('./nuvemDisjuntorService');
    const snaps = await Promise.all(ids.map((id) => comPrazo(getDoc(doc(firestore, 'grupos_sincronizacao', grupoId, colecao, id)), 30000, 'foto do grupo')));
    return new Map(snaps.filter((s) => s.exists()).map((s) => [s.id, s.data()]));
  },
  async gravarLote(grupoId, colecao, itens) {
    const lan = require('./grupoTransporteService').backend('replica');
    if (lan) return lan.gravarLote(grupoId, colecao, itens);
    const firestore = require('./licenseService').getLicenseFirestore();
    const { doc, writeBatch, serverTimestamp } = require('firebase/firestore');
    require('./nuvemDisjuntorService').contar(`grupo_${colecao}`, itens.length);
    for (let i = 0; i < itens.length; i += LOTE) {
      const batch = writeBatch(firestore);
      for (const { docId, dados } of itens.slice(i, i + LOTE)) {
        batch.set(doc(firestore, 'grupos_sincronizacao', grupoId, colecao, docId), { ...dados, atualizadoEm: serverTimestamp() });
      }
      await batch.commit();
    }
  },
  escutar(grupoId, colecao, aoMudar, aoErrar) {
    const lan = require('./grupoTransporteService').backend('replica');
    if (lan) return lan.escutar(grupoId, colecao, aoMudar, aoErrar);
    const firestore = require('./licenseService').getLicenseFirestore();
    const { collection, onSnapshot } = require('firebase/firestore');
    return onSnapshot(collection(firestore, 'grupos_sincronizacao', grupoId, colecao), (snap) => {
      const mudou = new Map();
      for (const ch of snap.docChanges()) if (ch.type !== 'removed') mudou.set(ch.doc.id, ch.doc.data());
      aoMudar(mudou);
    }, aoErrar);
  },
};
function _definirBackendParaTeste(b) { backend = { ...backend, ...b }; }

// ---------------------------------------------------------------------------
// Enviar o que mudou aqui
// ---------------------------------------------------------------------------

let enviando = null;
let enviarDeNovo = false;

/**
 * Manda a fila (produtos, clientes) e o fiado novo. Um envio por vez: quem
 * pede enquanto um envio está andando ganha UMA passada a mais no fim (o que
 * mudou nesse meio tempo). Antes cada pedido encadeava o seu próprio envio e
 * eles rodavam juntos, cada um lendo a fila inteira -- salvar 500 produtos de
 * uma planilha mandava a fila 500 vezes (centenas de milhares de gravações,
 * muito acima da cota do Firestore).
 */
function enviarPendentes() {
  if (enviando) { enviarDeNovo = true; return enviando; }
  enviando = (async () => {
    let r;
    do {
      enviarDeNovo = false;
      r = await enviarPendentesAgora();
    } while (enviarDeNovo);
    return r;
  })().finally(() => { enviando = null; });
  return enviando;
}

// Só envia depois de juntar o que já estava no grupo -- senão um caixa
// que acabou de entrar publicaria a própria cópia antes de casar com a
// do grupo (e o cadastro velho dele podia vencer o do grupo).
let juntouComGrupo = null;

async function enviarPendentesAgora() {
  const grupoId = grupoAtual();
  if (!grupoId) return { ok: true, grupo: false };
  if (juntouComGrupo !== grupoId) return { ok: true, grupo: true, esperando: true };
  // Sem cota de escrita hoje: a fila (grupo_replica_pendente) fica como está
  // e sai inteira quando a cota voltar.
  if (!require('./grupoTransporteService').backend('replica') && !require('./nuvemDisjuntorService').podeEscrever()) return { ok: true, grupo: true, esperando: true, semCota: true };
  const db = getDb();
  const origem = origemDesteCaixa();
  let enviados = 0;
  try {
    for (const entidade of ['produtos', 'clientes']) {
      const E = ENTIDADES[entidade];
      // marca é um inteiro de 64 bits (abs(random())): lido como número do JS
      // perde precisão e o DELETE abaixo nunca batia -- a fila não esvaziava e
      // tudo era reenviado a cada 5 s, gastando a cota do Firestore. Como texto
      // a comparação é exata.
      const fila = db.prepare('SELECT local_id, CAST(marca AS TEXT) AS marca FROM grupo_replica_pendente WHERE entidade = ?').all(entidade);
      if (fila.length === 0) continue;
      const itens = [];
      const prontos = [];
      db.transaction(() => {
        const mapa = vinculos(db, entidade, grupoId);
        const agora = Date.now();
        for (const { local_id: localId, marca } of fila) {
          const linha = E.ler(db, localId);
          const v = mapa.porLocal.get(localId);
          if (!linha) {
            // Apagado aqui (ex.: mesclado): lápide no grupo, se já tinha ido.
            if (v) {
              const versao = Math.max(agora, v.versao_ms + 1);
              itens.push({ docId: v.doc_id, dados: { excluido: true, ativo: false, versaoMs: versao, origem } });
              db.prepare('DELETE FROM grupo_replica WHERE entidade = ? AND grupo_id = ? AND local_id = ?').run(entidade, grupoId, localId);
            }
            prontos.push({ localId, marca });
            continue;
          }
          if (!v && !E.podeEntrar(linha)) { prontos.push({ localId, marca }); continue; }
          const versao = Math.max(agora, (v?.versao_ms || 0) + 1);
          let docId = v?.doc_id;
          if (!docId) docId = mapa.porDoc.has(localId) ? randomUUID() : localId;
          gravarVinculo(db, entidade, grupoId, localId, docId, versao, mapa);
          itens.push({ docId, dados: { ...E.paraDoc(linha), ...(E.extrasDoDoc?.(db, grupoId, linha) || {}), versaoMs: versao, origem } });
          prontos.push({ localId, marca });
        }
      })();
      if (itens.length) await backend.gravarLote(grupoId, entidade, itens);
      const tirar = db.prepare('DELETE FROM grupo_replica_pendente WHERE entidade = ? AND local_id = ? AND CAST(marca AS TEXT) = ?');
      db.transaction(() => { for (const p of prontos) tirar.run(entidade, p.localId, p.marca); })();
      enviados += itens.length;
    }

    // Fiado: depois dos clientes (o lançamento aponta para o cliente do grupo).
    const lancamentos = fiadoParaEnviar(db, grupoId);
    if (lancamentos.length) {
      const operadores = new Map(db.prepare('SELECT id, nome FROM users').all().map((u) => [u.id, u.nome]));
      const nomeCaixa = nomeDesteCaixa();
      await backend.gravarLote(grupoId, 'fiado', lancamentos.map((m) => ({
        docId: m.id,
        dados: {
          clienteDoc: m.cliente_doc, tipo: m.tipo, valor: Number(m.valor), motivo: m.motivo ?? null,
          criadoEm: m.criado_em, operadorNome: operadores.get(m.operador_id) || null,
          nomeComputador: nomeCaixa, origem,
        },
      })));
      const marcar = db.prepare(`INSERT OR IGNORE INTO grupo_replica_livro (livro, grupo_id, item_id) VALUES ('fiado', ?, ?)`);
      db.transaction(() => { for (const m of lancamentos) marcar.run(grupoId, m.id); })();
      enviados += lancamentos.length;
    }
    return { ok: true, grupo: true, enviados };
  } catch (err) {
    console.error('[grupoReplicaService] não foi possível enviar para o grupo (vai de novo depois):', err.message);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Ligar / desligar
// ---------------------------------------------------------------------------

let paradas = [];
let relogio = null;
let geracao = 0;
let fiadoAguardando = new Map();

function aplicarMudancas(entidade, grupoId, mudou, completo = false) {
  const lapides = mesclar(entidade, grupoId, mudou, { completo });
  if (lapides.length) {
    const origem = origemDesteCaixa();
    const versao = Date.now();
    backend.gravarLote(grupoId, entidade, lapides.map((l) => ({ docId: l.docId, dados: { ...l.dados, versaoMs: versao, origem } })))
      .catch((err) => console.error('[grupoReplicaService] lápide não foi:', err.message));
  }
  if (entidade === 'produtos') {
    try { require('./productSyncService').atualizarCacheDoGrupo(mudou); } catch { /* cache de consulta */ }
  }
  if (entidade === 'clientes' && fiadoAguardando.size) {
    fiadoAguardando = receberFiado(grupoId, fiadoAguardando);
  }
}

/** Lê o grupo inteiro e junta (na entrada no grupo e ao abrir o app). */
async function sincronizarTudo() {
  const grupoId = grupoAtual();
  if (!grupoId) return { ok: true, grupo: false };
  try {
    for (const entidade of ['produtos', 'clientes']) {
      aplicarMudancas(entidade, grupoId, await backend.lerTodos(grupoId, entidade), true);
    }
    fiadoAguardando = receberFiado(grupoId, await backend.lerTodos(grupoId, 'fiado'));
    juntouComGrupo = grupoId;
    const envio = await enviarPendentes();
    return { ok: envio.ok, grupo: true };
  } catch (err) {
    console.error('[grupoReplicaService] falha ao sincronizar com o grupo:', err.message);
    return { ok: false, error: err.message };
  }
}

function parar() {
  geracao++;
  juntouComGrupo = null;
  for (const p of paradas) { try { p(); } catch { /* já parado */ } }
  paradas = [];
  if (relogio) clearInterval(relogio);
  relogio = null;
  fiadoAguardando = new Map();
}

/** Liga (ou religa ao trocar de grupo): sincroniza, escuta e envia a fila a cada 5 s. */
function iniciar() {
  parar();
  const minha = geracao;
  const grupoId = grupoAtual();
  if (!grupoId) return Promise.resolve();
  return sincronizarTudo().then(() => {
    if (minha !== geracao || grupoAtual() !== grupoId) return;
    const erro = (colecao) => (err) => console.error(`[grupoReplicaService] escuta de ${colecao} falhou:`, err?.message || err);
    for (const entidade of ['produtos', 'clientes']) {
      try {
        paradas.push(backend.escutar(grupoId, entidade, (mudou) => {
          if (grupoAtual() !== grupoId) return;
          try { aplicarMudancas(entidade, grupoId, mudou); } catch (err) { console.error('[grupoReplicaService]', err.message); }
        }, erro(entidade)));
      } catch (err) { console.error('[grupoReplicaService]', err.message); }
    }
    try {
      paradas.push(backend.escutar(grupoId, 'fiado', (mudou) => {
        if (grupoAtual() !== grupoId) return;
        try {
          const juntos = new Map([...fiadoAguardando, ...mudou]);
          fiadoAguardando = receberFiado(grupoId, juntos);
        } catch (err) { console.error('[grupoReplicaService]', err.message); }
      }, erro('fiado')));
    } catch (err) { console.error('[grupoReplicaService]', err.message); }
    let ultimaTentativa = Date.now();
    relogio = setInterval(() => {
      try {
        // Abriu sem internet: tenta juntar com o grupo de novo a cada minuto
        // (até lá, o que muda aqui fica na fila).
        if (juntouComGrupo !== grupoId) {
          if (Date.now() - ultimaTentativa >= 60000) { ultimaTentativa = Date.now(); sincronizarTudo(); }
          return;
        }
        const db = getDb();
        const tem = db.prepare('SELECT 1 FROM grupo_replica_pendente LIMIT 1').get() || fiadoParaEnviar(db, grupoId).length > 0;
        if (tem) enviarPendentes();
        trabalharFotos(grupoId);
      } catch { /* banco fechando */ }
    }, 5000);
    relogio.unref?.();
  });
}

/** Fotos dos produtos (grupoFotoService): sobe as trocadas aqui e baixa as novas do grupo. */
function trabalharFotos(grupoId) {
  try {
    const fotos = require('./grupoFotoService');
    if (!fotos.temTrabalho(grupoId)) return null;
    const lan = !!require('./grupoTransporteService').backend('replica');
    const semEnvio = !lan && !require('./nuvemDisjuntorService').podeEscrever();
    return fotos.trabalhar({ grupoId, backend, origem: origemDesteCaixa(), semEnvio });
  } catch (err) {
    console.error('[grupoReplicaService] fotos:', err?.message || err);
    return null;
  }
}

/** O que a escuta faz com uma leva do grupo (exposto para os testes). */
function receber(entidade, grupoId, mudou) {
  if (entidade === 'fiado') {
    fiadoAguardando = receberFiado(grupoId, new Map([...fiadoAguardando, ...mudou]));
    return;
  }
  aplicarMudancas(entidade, grupoId, mudou);
}

module.exports = {
  iniciar, parar, sincronizarTudo, enviarPendentes, mesclar, receber, receberFiado, paraGrupo, trabalharFotos,
  versaoDoDoc, _definirBackendParaTeste, ENTIDADES,
};
