/**
 * DEMONSTRAÇÃO COMPLETA -- carrega uma loja inteira fictícia (produtos,
 * clientes, fornecedores e quatro meses de vendas) para apresentar o
 * sistema, e LIMPA depois, para trocar de cliente-alvo.
 *
 * Só o papel `suporte` usa isto (PAPEL_POR_CANAL em handlers.js + checagem
 * aqui dentro). É a ÚNICA exceção à regra "suporte = admin" do CLAUDE.md.
 *
 * Por que limpar = trocar o ARQUIVO do banco, e não apagar linhas:
 *   - audit_log, journal_entries e cash_movements só aceitam inclusão
 *     (gatilho em migracoes.js) -- DELETE nelas falha de propósito;
 *   - a identidade da máquina na Central (locations.device_uid), os
 *     usuários, a licença e as configurações moram no mesmo SQLite. Banco
 *     "do zero" faria a máquina aparecer na Central como instalação nova.
 * Então, antes de gravar qualquer coisa, guardamos uma cópia completa do
 * banco (ponto de restauração, via backup API do SQLite). Limpar = colocar
 * essa cópia de volta e reiniciar o app -- o mesmo caminho de
 * backupService.restaurarBackupInterno. Nenhuma linha é apagada.
 *
 * Vendas da demonstração são gravadas com datas RETROATIVAS (os últimos
 * 120 dias), contornando NOW_SYNCED() -- é o único lugar do app que faz
 * isso, e só aqui: sem histórico, cliente sumido, previsão de ruptura e
 * "quem compra isso, compra aquilo" não têm o que mostrar. Por isso a
 * carga exige banco SEM NENHUMA venda: a demonstração nunca se mistura
 * com histórico real. Única exceção: máquina marcada como de
 * demonstração pela Central (`maquinaDemo`, a mesma da vitrine de
 * demonstração) -- lá as vendas já são de teste ou de prospects, e o
 * ponto de restauração devolve todas elas ao limpar.
 *
 * Estado fica em `<userData>/demonstracao/estado.json` (fora do banco: o
 * banco é justamente o que é trocado na limpeza).
 */

const fs = require('fs');
const path = require('path');
const { randomUUID, randomBytes } = require('crypto');
const bcrypt = require('bcryptjs');
const database = require('../db/database');
const timeService = require('./timeService');
const { CATALOGOS_DEMONSTRACAO, clientesDemonstracao, perfisDisponiveis } = require('./demoDataCatalogos');

const DIAS_DE_HISTORICO = 120;
const TOTAL_VENDAS = 360;
const CLIENTES_ATIVOS = 32; // os 8 últimos da lista viram "sumidos"
const PROBABILIDADE_DE_CLIENTE = 0.55;
const METODOS = [['pix', 35], ['dinheiro', 25], ['cartao_debito', 20], ['cartao_credito', 20]];

// ---------------------------------------------------------------- caminhos

let caminhosDeTeste = null;

/** Só para tests/: aponta banco e pasta de estado para arquivos temporários
 * (sem isso a limpeza copiaria por cima do banco de desenvolvimento). */
function configurarParaTeste(caminhos) {
  caminhosDeTeste = caminhos;
}

function caminhoDoBanco() {
  return caminhosDeTeste?.dbPath || database.getDbPath();
}

function pastaDemonstracao() {
  return caminhosDeTeste?.pasta || path.join(path.dirname(database.getDbPath()), 'demonstracao');
}

function arquivoDeEstado() {
  return path.join(pastaDemonstracao(), 'estado.json');
}

function lerEstado() {
  try {
    return JSON.parse(fs.readFileSync(arquivoDeEstado(), 'utf8'));
  } catch {
    return null;
  }
}

function gravarEstado(estadoNovo) {
  fs.mkdirSync(pastaDemonstracao(), { recursive: true });
  const temporario = `${arquivoDeEstado()}.tmp`;
  fs.writeFileSync(temporario, JSON.stringify(estadoNovo, null, 2));
  fs.renameSync(temporario, arquivoDeEstado());
}

function apagarEstado() {
  try { fs.unlinkSync(arquivoDeEstado()); } catch { /* já não existia */ }
}

function carimbo(agoraMs) {
  return new Date(agoraMs).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

// ---------------------------------------------------------------- checagens

function usuarioEhSuporte(db, usuarioId) {
  if (!usuarioId) return false;
  const u = db.prepare('SELECT role FROM users WHERE id = ? AND ativo = 1').get(usuarioId);
  return u?.role === 'suporte';
}

const MSG_SO_SUPORTE = 'Somente o usuário de suporte pode mexer na demonstração.';

function grupoDeSincronizacao() {
  try {
    return require('./syncStateService').getGrupoSincronizacaoId() || null;
  } catch {
    return null;
  }
}

/** A Central marcou esta instalação como máquina de demonstração. Só a
 * Central grava esse campo; sem conexão ainda lida, vale false (bloqueia). */
function ehMaquinaDeDemonstracao() {
  try {
    return require('./vitrineDemoService').ehMaquinaDemo() === true;
  } catch {
    return false;
  }
}

function contarVendas(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM sales').get().c;
}

/** O que impede a CARGA (não a limpeza). */
function impedimentosParaCarregar(db) {
  const impedimentos = [];
  const vendas = contarVendas(db);
  if (vendas > 0 && !ehMaquinaDeDemonstracao()) {
    impedimentos.push(`Esta máquina já tem ${vendas} venda(s) registrada(s). A demonstração só pode ser carregada numa máquina sem vendas ou marcada como máquina de demonstração na Central.`);
  }
  const caixas = db.prepare(`SELECT COUNT(*) AS c FROM cash_sessions WHERE status = 'aberta'`).get().c;
  if (caixas > 0) impedimentos.push('Feche o caixa aberto antes de carregar a demonstração.');
  if (grupoDeSincronizacao()) {
    impedimentos.push('Esta máquina está num grupo de sincronização multi-PDV. Tire-a do grupo pela Central antes de carregar a demonstração.');
  }
  return impedimentos;
}

// ---------------------------------------------------------------- estado

function estado() {
  const db = database.getDb();
  const salvo = lerEstado();
  const pontoExiste = !!(salvo?.pontoRestauracao && fs.existsSync(salvo.pontoRestauracao));
  const ativa = !!(salvo?.ativa && pontoExiste);
  return {
    ok: true,
    ativa,
    // estado.json diz ativa, mas a cópia sumiu: não dá para limpar com
    // segurança. A tela avisa; a carga continua bloqueada pelas vendas.
    pontoPerdido: !!(salvo?.ativa && !pontoExiste),
    perfil: ativa ? salvo.perfil : null,
    rotulo: ativa ? CATALOGOS_DEMONSTRACAO[salvo.perfil]?.rotulo || salvo.perfil : null,
    carregadaEm: ativa ? salvo.carregadaEm : null,
    pontoRestauracao: ativa ? path.basename(salvo.pontoRestauracao) : null,
    resumo: ativa ? salvo.resumo || null : null,
    maquinaDemo: ehMaquinaDeDemonstracao(),
    vendasExistentes: ativa ? 0 : contarVendas(db),
    perfis: perfisDisponiveis(),
    impedimentos: ativa ? [] : impedimentosParaCarregar(db),
  };
}

// ---------------------------------------------------------------- troca de arquivo

function removerResiduos(dbPath) {
  for (const sufixo of ['-wal', '-shm']) {
    const residual = dbPath + sufixo;
    if (fs.existsSync(residual)) fs.unlinkSync(residual);
  }
}

/** Coloca o ponto de restauração no lugar do banco. Igual à restauração de
 * backup: fecha, limpa -wal/-shm, copia, e fecha de novo caso algum serviço
 * de fundo tenha reaberto a conexão nesse meio-tempo. */
function colocarPontoNoLugarDoBanco(ponto) {
  const dbPath = caminhoDoBanco();
  database.closeConnection();
  removerResiduos(dbPath);
  fs.copyFileSync(ponto, dbPath);
  database.closeConnection();
}

/** Conexão avulsa no arquivo recém-trocado -- nunca reusamos getDb() no
 * mesmo processo depois de trocar o arquivo (o app reinicia em seguida). */
function abrirConexaoAvulsa(dbPath) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.function('NOW_SYNCED', () => timeService.nowSyncedUTCString());
  return db;
}

function registrarAuditoria(db, { tipo, solicitanteId, motivo }) {
  const existe = solicitanteId && db.prepare('SELECT id FROM users WHERE id = ?').get(solicitanteId);
  db.prepare(
    `INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso) VALUES (?, ?, ?, ?, 1)`
  ).run(randomUUID(), tipo, existe ? solicitanteId : null, motivo);
}

// ---------------------------------------------------------------- ações

async function carregar({ perfil, solicitanteId } = {}) {
  const catalogo = CATALOGOS_DEMONSTRACAO[perfil];
  if (!catalogo) return { ok: false, error: 'Escolha um perfil de demonstração válido.' };

  const db = database.getDb();
  if (!usuarioEhSuporte(db, solicitanteId)) return { ok: false, error: MSG_SO_SUPORTE };

  const salvo = lerEstado();
  if (salvo?.ativa) {
    return { ok: false, error: 'Já existe uma demonstração carregada. Use "Trocar perfil" ou limpe a demonstração antes.' };
  }
  const impedimentos = impedimentosParaCarregar(db);
  if (impedimentos.length > 0) return { ok: false, error: impedimentos[0] };

  const agoraMs = timeService.nowMs();
  fs.mkdirSync(pastaDemonstracao(), { recursive: true });
  const ponto = path.join(pastaDemonstracao(), `antes-da-demonstracao-${carimbo(agoraMs)}.sqlite3`);
  try {
    await db.backup(ponto);
    conferirPonto(ponto);
  } catch (err) {
    try { fs.unlinkSync(ponto); } catch { /* nada a limpar */ }
    return { ok: false, error: `Não consegui guardar a cópia dos dados atuais (${err.message}). Nada foi alterado.` };
  }

  // Estado gravado ANTES de semear: se o app cair no meio, a transação
  // desfaz a carga e a limpeza só devolve o mesmo banco -- inofensivo.
  // O contrário (semear e cair antes de gravar) deixaria dado fictício
  // sem caminho de volta.
  gravarEstado({ ativa: true, perfil, carregadaEm: new Date(agoraMs).toISOString(), pontoRestauracao: ponto });

  let resumo;
  try {
    resumo = semear(db, { perfil, solicitanteId, agoraMs });
  } catch (err) {
    apagarEstado();
    try { fs.unlinkSync(ponto); } catch { /* nada a limpar */ }
    return { ok: false, error: `Não foi possível carregar a demonstração (${err.message}). Nada foi alterado.` };
  }

  gravarEstado({ ativa: true, perfil, carregadaEm: new Date(agoraMs).toISOString(), pontoRestauracao: ponto, resumo });
  return { ok: true, resumo };
}

function conferirPonto(ponto) {
  const Database = require('better-sqlite3');
  const copia = new Database(ponto, { readonly: true });
  try {
    const ok = copia.pragma('quick_check', { simple: true });
    if (ok !== 'ok') throw new Error(`cópia corrompida (${ok})`);
    copia.prepare('SELECT COUNT(*) FROM users').get();
  } finally {
    copia.close();
  }
}

function limpar({ solicitanteId } = {}) {
  const db = database.getDb();
  if (!usuarioEhSuporte(db, solicitanteId)) return { ok: false, error: MSG_SO_SUPORTE };

  const salvo = lerEstado();
  if (!salvo?.ativa) return { ok: false, error: 'Não há demonstração carregada nesta máquina.' };
  if (!salvo.pontoRestauracao || !fs.existsSync(salvo.pontoRestauracao)) {
    return { ok: false, error: 'A cópia dos dados de antes da demonstração não foi encontrada. Nada foi alterado.' };
  }
  const nomeSolicitante = db.prepare('SELECT nome FROM users WHERE id = ?').get(solicitanteId)?.nome || 'suporte';

  colocarPontoNoLugarDoBanco(salvo.pontoRestauracao);
  apagarEstado();
  try { fs.unlinkSync(salvo.pontoRestauracao); } catch { /* sobra só uma cópia antiga */ }

  // Rastro no banco restaurado (melhor esforço, igual à restauração de backup).
  try {
    const restaurado = abrirConexaoAvulsa(caminhoDoBanco());
    try {
      registrarAuditoria(restaurado, {
        tipo: 'demonstracao_limpa', solicitanteId,
        motivo: `Demonstração (${salvo.perfil}) limpa por ${nomeSolicitante}; dados de antes da demonstração restaurados`,
      });
    } finally {
      restaurado.close();
    }
  } catch { /* auditoria nunca trava a limpeza */ }

  return { ok: true, reiniciar: true };
}

/** Limpa e carrega outro perfil numa ação só (um reinício). O ponto de
 * restauração continua o mesmo: é sempre o banco de antes da PRIMEIRA carga. */
function trocarPerfil({ perfil, solicitanteId } = {}) {
  const catalogo = CATALOGOS_DEMONSTRACAO[perfil];
  if (!catalogo) return { ok: false, error: 'Escolha um perfil de demonstração válido.' };

  const db = database.getDb();
  if (!usuarioEhSuporte(db, solicitanteId)) return { ok: false, error: MSG_SO_SUPORTE };

  const salvo = lerEstado();
  if (!salvo?.ativa) return { ok: false, error: 'Não há demonstração carregada. Use "Carregar demonstração".' };
  if (!salvo.pontoRestauracao || !fs.existsSync(salvo.pontoRestauracao)) {
    return { ok: false, error: 'A cópia dos dados de antes da demonstração não foi encontrada. Nada foi alterado.' };
  }

  colocarPontoNoLugarDoBanco(salvo.pontoRestauracao);
  const agoraMs = timeService.nowMs();
  // Daqui em diante o banco já é o de antes da demonstração. Se a nova
  // carga falhar, fica assim (limpo) e o estado é apagado -- nunca um meio-termo.
  let resumo;
  const conexao = abrirConexaoAvulsa(caminhoDoBanco());
  try {
    resumo = semear(conexao, { perfil, solicitanteId, agoraMs });
  } catch (err) {
    apagarEstado();
    return { ok: false, reiniciar: true, error: `A demonstração anterior foi limpa, mas a nova não carregou (${err.message}).` };
  } finally {
    conexao.close();
  }

  gravarEstado({ ativa: true, perfil, carregadaEm: new Date(agoraMs).toISOString(), pontoRestauracao: salvo.pontoRestauracao, resumo });
  return { ok: true, reiniciar: true, resumo };
}

// ---------------------------------------------------------------- geração

/** Gerador pseudoaleatório com semente: a mesma carga gera os mesmos dados
 * (útil para ensaiar a apresentação e para os testes). */
function geradorComSemente(semente) {
  let a = semente >>> 0;
  return function proximo() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const doisDigitos = (n) => String(n).padStart(2, '0');
const arredondar = (v) => Math.round(v * 100) / 100;

/**
 * Grava a loja fictícia do perfil numa transação só. Recebe o banco
 * explicitamente (getDb() na carga, conexão avulsa na troca de perfil).
 *
 * Datas de calendário (validade, vacina, agenda) saem do relógio LOCAL
 * (getFullYear/getDate), nunca de toISOString().slice(0,10) -- ver a
 * armadilha de fuso no CLAUDE.md. Timestamps de evento (criado_em,
 * finalizada_em) são UTC, no formato de NOW_SYNCED().
 */
function semear(db, { perfil, solicitanteId, agoraMs = timeService.nowMs(), semente = 20261102 }) {
  const catalogo = CATALOGOS_DEMONSTRACAO[perfil];
  if (!catalogo) throw new Error(`perfil desconhecido: ${perfil}`);

  const rnd = geradorComSemente(semente);
  const inteiro = (min, max) => min + Math.floor(rnd() * (max - min + 1));
  const escolher = (lista) => lista[Math.floor(rnd() * lista.length)];

  const location = db.prepare('SELECT id, device_uid FROM locations ORDER BY criado_em LIMIT 1').get();
  if (!location) throw new Error('nenhum local cadastrado');
  const locationId = location.id;
  const deviceId = location.device_uid || 'demonstracao';
  const solicitante = solicitanteId && db.prepare('SELECT id FROM users WHERE id = ?').get(solicitanteId) ? solicitanteId : null;

  const momentoLocal = (diasAtras, hora, minuto) => {
    const d = new Date(agoraMs);
    d.setDate(d.getDate() - diasAtras);
    d.setHours(hora, minuto, inteiro(0, 59), 0);
    return d;
  };
  const utc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const diaLocal = (d) => `${d.getFullYear()}-${doisDigitos(d.getMonth() + 1)}-${doisDigitos(d.getDate())}`;
  const diaLocalDaqui = (dias) => {
    const d = new Date(agoraMs);
    d.setDate(d.getDate() + dias);
    return diaLocal(d);
  };
  const inicioDoHistorico = momentoLocal(DIAS_DE_HISTORICO + 5, 8, 0);

  const resumo = { perfil, rotulo: catalogo.rotulo };

  const tx = db.transaction(() => {
    db.prepare(`UPDATE business_profile SET perfil_ativo = ? WHERE id = 'default'`).run(perfil);

    // Operadores fictícios: aparecem no histórico e no filtro por operador.
    // PIN aleatório e descartado -- ninguém entra com eles (o suporte pode
    // definir um PIN em Usuários se quiser mostrar a visão do operador).
    const operadores = ['Ana (demonstração)', 'Bruno (demonstração)'].map((nome) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO users (id, nome, role, pin_hash, criado_em) VALUES (?, ?, 'operador', ?, ?)`)
        .run(id, nome, bcrypt.hashSync(randomBytes(16).toString('hex'), 8), utc(inicioDoHistorico));
      return id;
    });

    const fornecedores = catalogo.fornecedores.map((nome) => {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO suppliers (id, nome, telefone, prazo_entrega_dias, criado_em) VALUES (?, ?, '(00) 0000-0000', ?, ?)`
      ).run(id, nome, inteiro(2, 7), utc(inicioDoHistorico));
      return id;
    });
    resumo.fornecedores = fornecedores.length;

    // ---- produtos
    const indicePerfil = Object.keys(CATALOGOS_DEMONSTRACAO).indexOf(perfil);
    const produtos = catalogo.itens.map(([codigo, nome, categoria, preco, custo, unidade, minimo, extras = {}], i) => {
      const id = randomUUID();
      const servico = !!extras.servico;
      const custom = { ...(extras.custom || {}) };
      if (!servico && (extras.validadeDias != null || catalogo.exigeValidade)) {
        custom.validade = diaLocalDaqui(extras.validadeDias ?? 365);
      }
      if (!servico && catalogo.exigeLote) custom.lote = `L${codigo}${inteiro(100, 999)}`;
      // Faixa 2xx do EAN-13 é de uso interno da loja: nunca colide com
      // código de fabricante. Se o código já existir, fica sem.
      let codigoBarras = servico ? null : `29${String(indicePerfil).padStart(3, '0')}${String(i + 1).padStart(8, '0')}`;
      if (codigoBarras && db.prepare('SELECT 1 FROM products WHERE codigo_barras = ?').get(codigoBarras)) codigoBarras = null;
      let sku = `APRES-${codigo}`;
      if (db.prepare('SELECT 1 FROM products WHERE sku = ?').get(sku)) sku = `${sku}-${inteiro(1000, 9999)}`;
      db.prepare(
        `INSERT INTO products (id, sku, codigo_barras, nome, categoria, preco, custo, unidade, estoque_minimo, tipo, fornecedor_id, custom_fields, criado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, sku, codigoBarras, nome, categoria, preco, custo, unidade, minimo,
        servico ? 'servico' : 'produto', servico ? null : fornecedores[i % fornecedores.length],
        JSON.stringify(custom), utc(inicioDoHistorico)
      );
      return { id, codigo, nome, preco, unidade, minimo, servico, peso: extras.peso || 1 };
    });
    resumo.produtos = produtos.length;
    const porCodigo = Object.fromEntries(produtos.map((p) => [p.codigo, p]));
    const pares = (catalogo.pares || []).map(([a, b]) => [porCodigo[a], porCodigo[b]]).filter(([a, b]) => a && b);
    const pesoTotal = produtos.reduce((s, p) => s + p.peso, 0);
    const sortearProduto = () => {
      let alvo = rnd() * pesoTotal;
      for (const p of produtos) {
        alvo -= p.peso;
        if (alvo <= 0) return p;
      }
      return produtos[produtos.length - 1];
    };
    const quantidadePara = (p) => {
      if (p.unidade === 'kg') return escolher([0.3, 0.5, 0.5, 1, 1.5]);
      if (p.unidade === 'm³') return inteiro(1, 2);
      if (p.minimo >= 100) return inteiro(2, 20) * 50;
      if (p.unidade === 'saco') return inteiro(1, 10);
      return inteiro(1, 3);
    };

    // ---- clientes
    const clientes = clientesDemonstracao().map((c) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO customers (id, nome, telefone, criado_em) VALUES (?, ?, ?, ?)`)
        .run(id, c.nome, c.telefone, utc(inicioDoHistorico));
      return { id, ...c };
    });
    resumo.clientes = clientes.length;

    // ---- planejamento das vendas (em memória, para calcular o estoque antes)
    const agora = new Date(agoraMs);
    const momentoDaVenda = (diasAtras) => {
      if (diasAtras === 0) return new Date(agoraMs - inteiro(10, 240) * 60000);
      return momentoLocal(diasAtras, inteiro(8, 19), inteiro(0, 59));
    };
    const metodoSorteado = () => {
      let alvo = rnd() * 100;
      for (const [metodo, peso] of METODOS) {
        alvo -= peso;
        if (alvo <= 0) return metodo;
      }
      return 'pix';
    };
    const planejarVenda = (diasAtras, clienteIdx) => {
      const n = escolher([1, 1, 2, 2, 3, 4]);
      const itens = [];
      if (pares.length > 0 && rnd() < 0.35) itens.push(...escolher(pares));
      let tentativas = 0;
      while (itens.length < n && tentativas < 20) {
        const p = sortearProduto();
        if (!itens.includes(p)) itens.push(p);
        tentativas += 1;
      }
      return {
        momento: momentoDaVenda(diasAtras),
        cliente: clienteIdx == null ? null : clientes[clienteIdx],
        operadorId: escolher(operadores),
        itens: itens.map((p) => ({ produto: p, quantidade: quantidadePara(p) })),
      };
    };

    const vendas = [];
    for (let i = 0; i < TOTAL_VENDAS; i += 1) {
      let diasAtras = inteiro(0, DIAS_DE_HISTORICO - 1);
      let clienteIdx = null;
      if (rnd() < PROBABILIDADE_DE_CLIENTE) {
        clienteIdx = inteiro(0, clientes.length - 1);
        // Clientes "sumidos": só compraram há mais de 85 dias.
        if (clienteIdx >= CLIENTES_ATIVOS) diasAtras = inteiro(85, DIAS_DE_HISTORICO - 1);
      }
      vendas.push(planejarVenda(diasAtras, clienteIdx));
    }
    // Garante: todo cliente ativo comprou nos últimos 20 dias; todo sumido
    // tem ao menos uma compra antiga (senão não aparece na lista).
    for (let i = 0; i < clientes.length; i += 1) {
      vendas.push(planejarVenda(i < CLIENTES_ATIVOS ? inteiro(1, 20) : inteiro(85, 100), i));
    }
    vendas.sort((a, b) => a.momento - b.momento);
    resumo.vendas = vendas.length;
    resumo.desde = diaLocal(vendas[0].momento);
    resumo.clientesSumidos = clientes.length - CLIENTES_ATIVOS;

    // ---- estoque: uma entrada antes do histórico, cobrindo o que vai ser
    // vendido + o saldo final desejado. ~20% dos produtos terminam abaixo do
    // mínimo (alerta de estoque e previsão de ruptura).
    const vendido = new Map();
    for (const v of vendas) for (const it of v.itens) {
      if (!it.produto.servico) vendido.set(it.produto.id, (vendido.get(it.produto.id) || 0) + it.quantidade);
    }
    const inserirMovimento = db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, tipo, quantidade, motivo, sale_id, sale_item_id, operador_id, device_id, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let abaixoDoMinimo = 0;
    for (const p of produtos) {
      if (p.servico) continue;
      const baixo = rnd() < 0.2 && p.minimo > 0;
      const saldoFinal = baixo ? inteiro(0, Math.max(0, Math.ceil(p.minimo) - 1)) : Math.max(p.minimo * 2, 10) + inteiro(3, 20);
      if (baixo) abaixoDoMinimo += 1;
      const perda = !baixo && rnd() < 0.15 ? inteiro(1, 2) : 0;
      const entrada = arredondar((vendido.get(p.id) || 0) + saldoFinal + perda);
      inserirMovimento.run(randomUUID(), p.id, locationId, 'entrada', entrada, 'Compra (demonstração)', null, null, solicitante, deviceId, utc(momentoLocal(DIAS_DE_HISTORICO + 3, 9, 0)));
      if (perda > 0) {
        inserirMovimento.run(randomUUID(), p.id, locationId, 'perda', -perda, 'Avaria (demonstração)', null, null, solicitante, deviceId, utc(momentoLocal(inteiro(5, 60), 18, 0)));
      }
    }
    resumo.produtosAbaixoDoMinimo = abaixoDoMinimo;

    // ---- vendas
    const inserirVenda = db.prepare(
      `INSERT INTO sales (id, location_id, operador_id, customer_id, status, total, criado_em, finalizada_em)
       VALUES (?, ?, ?, ?, 'finalizada', ?, ?, ?)`
    );
    const inserirItem = db.prepare(
      `INSERT INTO sale_items (id, sale_id, product_id, quantidade, preco_unitario, criado_em) VALUES (?, ?, ?, ?, ?, ?)`
    );
    const inserirPagamento = db.prepare(
      `INSERT INTO payments (id, sale_id, metodo, valor, detalhes, criado_em) VALUES (?, ?, ?, ?, '{}', ?)`
    );
    const vendasGravadas = [];
    for (const v of vendas) {
      const saleId = randomUUID();
      const criado = utc(v.momento);
      const finalizada = utc(new Date(v.momento.getTime() + inteiro(1, 4) * 60000));
      // Igual a saleService.recalcularTotal: total = soma sem arredondar.
      // O pagamento é em centavos e precisa cobrir o total (finalizeSale).
      const total = v.itens.reduce((s, it) => s + it.quantidade * it.produto.preco, 0);
      const aPagar = Math.ceil(total * 100 - 1e-6) / 100;
      inserirVenda.run(saleId, locationId, v.operadorId, v.cliente?.id || null, total, criado, finalizada);
      for (const it of v.itens) {
        const itemId = randomUUID();
        inserirItem.run(itemId, saleId, it.produto.id, it.quantidade, it.produto.preco, criado);
        if (!it.produto.servico) {
          inserirMovimento.run(randomUUID(), it.produto.id, locationId, 'venda', -it.quantidade, null, saleId, itemId, v.operadorId, deviceId, criado);
        }
      }
      if (aPagar >= 20 && rnd() < 0.15) {
        const parte = Math.floor(aPagar / 2);
        inserirPagamento.run(randomUUID(), saleId, 'pix', parte, finalizada);
        inserirPagamento.run(randomUUID(), saleId, 'dinheiro', arredondar(aPagar - parte), finalizada);
      } else {
        inserirPagamento.run(randomUUID(), saleId, metodoSorteado(), aPagar, finalizada);
      }
      vendasGravadas.push({ saleId, momento: v.momento, cliente: v.cliente });
    }

    // ---- delivery (todos os perfis)
    const entregadores = ['Entregador 1 (demonstração)', 'Entregador 2 (demonstração)'].map((nome) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO delivery_persons (id, nome, telefone, criado_em) VALUES (?, ?, '(00) 90000-9999', ?)`).run(id, nome, utc(inicioDoHistorico));
      return id;
    });
    const veiculos = [['DEM0A01', 'Moto 160', 'moto'], ['DEM0B02', 'Utilitário', 'carro']].map(([placa, modelo, tipo]) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO delivery_vehicles (id, placa, modelo, tipo, criado_em) VALUES (?, ?, ?, ?, ?)`).run(id, placa, modelo, tipo, utc(inicioDoHistorico));
      return id;
    });
    const bairros = ['Boa Viagem', 'Casa Forte', 'Espinheiro', 'Graças', 'Madalena', 'Torre', 'Derby', 'Parnamirim'];
    const recentesComCliente = vendasGravadas.filter((v) => v.cliente).slice(-8);
    const statusEntrega = ['entregue', 'entregue', 'entregue', 'em_rota', 'em_rota', 'pendente', 'pendente', 'pendente'];
    recentesComCliente.forEach((v, i) => {
      const status = statusEntrega[i % statusEntrega.length];
      const saiu = status === 'pendente' ? null : utc(new Date(v.momento.getTime() + 15 * 60000));
      const entregue = status === 'entregue' ? utc(new Date(v.momento.getTime() + 45 * 60000)) : null;
      db.prepare(
        `INSERT INTO deliveries (id, location_id, sale_id, customer_id, endereco, cliente_nome, cliente_telefone, delivery_person_id, vehicle_id, status, taxa_entrega, operador_id, criado_em, saiu_em, entregue_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(), locationId, v.saleId, v.cliente.id, `Rua Fictícia, ${100 + i * 10} - ${escolher(bairros)}`,
        v.cliente.nome, v.cliente.telefone, status === 'pendente' ? null : escolher(entregadores),
        status === 'pendente' ? null : escolher(veiculos), status, escolher([0, 5, 7, 10]), solicitante,
        utc(v.momento), saiu, entregue
      );
    });
    resumo.entregas = recentesComCliente.length;

    // ---- extras por perfil
    resumo.extras = semearExtrasDoPerfil(db, {
      perfil, catalogo, clientes, produtos, locationId, solicitante, inteiro, escolher, rnd,
      utc, diaLocalDaqui, momentoLocal, agora,
    });

    registrarAuditoria(db, {
      tipo: 'demonstracao_carregada', solicitanteId: solicitante,
      motivo: `Demonstração do perfil ${catalogo.rotulo}: ${resumo.produtos} produtos, ${resumo.clientes} clientes, ${resumo.vendas} vendas desde ${resumo.desde}`,
    });
  });
  tx();
  return resumo;
}

function semearExtrasDoPerfil(db, ctx) {
  const { perfil, clientes, produtos, locationId, solicitante, inteiro, escolher, rnd, utc, diaLocalDaqui, momentoLocal, agora } = ctx;
  const extras = {};
  const quartoDeGrau = (min, max) => Math.round((min + rnd() * (max - min)) * 4) / 4;

  if (perfil === 'petshop') {
    const pets = [['Thor', 'Cão', 'Labrador'], ['Mel', 'Cão', 'Poodle'], ['Luna', 'Gato', 'Sem raça definida'], ['Bidu', 'Cão', 'Vira-lata'],
      ['Nina', 'Gato', 'Siamês'], ['Pipoca', 'Cão', 'Shih-tzu'], ['Amora', 'Gato', 'Persa'], ['Bolt', 'Cão', 'Beagle'],
      ['Fred', 'Cão', 'Golden'], ['Mia', 'Gato', 'Sem raça definida'], ['Toby', 'Cão', 'Yorkshire'], ['Lola', 'Cão', 'Pinscher']];
    // Próxima vacina espalhada: algumas vencidas, várias nos próximos 30 dias.
    const offsets = [-3, 2, 5, 9, 15, 25, 40, 80, 120, 200, 7, 28];
    pets.forEach(([nome, especie, raca], i) => {
      const proxima = offsets[i % offsets.length];
      const proximoVermifugo = escolher([-1, 10, 20, 45, 90]);
      db.prepare(
        `INSERT INTO pets (id, customer_id, nome, especie, raca, ultima_vacina_em, proxima_vacina_em, ultimo_vermifugo_em, proximo_vermifugo_em, criado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(), clientes[i].id, nome, especie, raca,
        diaLocalDaqui(proxima - 365), diaLocalDaqui(proxima),
        diaLocalDaqui(proximoVermifugo - 90), diaLocalDaqui(proximoVermifugo),
        utc(momentoLocal(100, 10, 0))
      );
    });
    extras.pets = pets.length;
  }

  if (perfil === 'salao_beleza') {
    const profissionais = [['Profissional 1 (demonstração)', 'Cabelo'], ['Profissional 2 (demonstração)', 'Cabelo e coloração'], ['Profissional 3 (demonstração)', 'Unhas']]
      .map(([nome, especialidade]) => {
        const id = randomUUID();
        db.prepare(`INSERT INTO appointment_professionals (id, nome, especialidade, criado_em) VALUES (?, ?, ?, ?)`)
          .run(id, nome, especialidade, utc(momentoLocal(130, 9, 0)));
        return { id, especialidade };
      });
    const servicosCabelo = produtos.filter((p) => p.servico && !/cure/i.test(p.nome)).map((p) => p.nome);
    const servicosUnha = produtos.filter((p) => p.servico && /cure/i.test(p.nome)).map((p) => p.nome);
    const ocupado = new Set();
    let total = 0;
    for (let i = 0; i < 40 && total < 24; i += 1) {
      const diasRel = inteiro(-6, 7);
      const hora = inteiro(9, 17);
      const prof = escolher(profissionais);
      const chave = `${prof.id}|${diasRel}|${hora}`;
      if (ocupado.has(chave)) continue;
      ocupado.add(chave);
      const d = new Date(agora);
      d.setDate(d.getDate() + diasRel);
      const dia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const passado = diasRel < 0 || (diasRel === 0 && hora < agora.getHours());
      const status = passado ? (rnd() < 0.85 ? 'concluido' : 'faltou') : escolher(['agendado', 'agendado', 'confirmado']);
      const servico = escolher(prof.especialidade === 'Unhas' ? servicosUnha : servicosCabelo);
      db.prepare(
        `INSERT INTO appointments (id, location_id, professional_id, customer_id, servico, data_hora_inicio, duracao_minutos, status, operador_id, criado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), locationId, prof.id, escolher(clientes).id, servico, `${dia} ${String(hora).padStart(2, '0')}:00:00`,
        escolher([30, 45, 60, 60, 90]), status, solicitante, utc(momentoLocal(Math.max(1, 10 - diasRel), 10, 0)));
      total += 1;
    }
    extras.profissionais = profissionais.length;
    extras.agendamentos = total;
  }

  if (perfil === 'material_construcao') {
    const vendaveis = produtos.filter((p) => !p.servico);
    for (let i = 0; i < 5; i += 1) {
      const quoteId = randomUUID();
      db.prepare(
        `INSERT INTO quotes (id, location_id, customer_id, origem, status, operador_id, validade_ate, criado_em)
         VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)`
      ).run(quoteId, locationId, clientes[i].id, i === 4 ? 'cancelado' : 'aberto', solicitante,
        diaLocalDaqui(inteiro(2, 10)), utc(momentoLocal(inteiro(1, 6), 10, 0)));
      const usados = new Set();
      while (usados.size < 3) usados.add(escolher(vendaveis));
      for (const p of usados) {
        db.prepare(`INSERT INTO quote_items (id, quote_id, product_id, quantidade, preco_unitario) VALUES (?, ?, ?, ?, ?)`)
          .run(randomUUID(), quoteId, p.id, p.minimo >= 100 ? inteiro(4, 20) * 50 : inteiro(1, 10), p.preco);
      }
    }
    extras.orcamentos = 5;
  }

  if (perfil === 'otica') {
    let total = 0;
    for (let i = 0; i < 10; i += 1) {
      const receitas = i < 2 ? 2 : 1; // dois clientes com histórico de duas receitas
      for (let r = 0; r < receitas; r += 1) {
        const diasAtras = r === 0 && receitas === 2 ? inteiro(380, 700) : inteiro(5, 110);
        const multifocal = i % 4 === 0;
        db.prepare(
          `INSERT INTO eyewear_prescriptions (id, customer_id, data_receita, od_esferico, od_cilindrico, od_eixo, od_adicao,
             oe_esferico, oe_cilindrico, oe_eixo, oe_adicao, distancia_pupilar, tipo_lente, observacoes, criado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          randomUUID(), clientes[i].id, diaLocalDaqui(-diasAtras),
          quartoDeGrau(-4, 1.5), quartoDeGrau(-1.75, 0), escolher([10, 90, 170, 180]), multifocal ? escolher([1.5, 2, 2.25]) : null,
          quartoDeGrau(-4, 1.5), quartoDeGrau(-1.75, 0), escolher([10, 90, 170, 180]), multifocal ? escolher([1.5, 2, 2.25]) : null,
          escolher([60, 62, 63, 64, 66]), multifocal ? 'Multifocal' : 'Monofocal', 'Receita fictícia (demonstração)',
          utc(momentoLocal(diasAtras, 11, 0))
        );
        total += 1;
      }
    }
    extras.receitas = total;
  }

  if (perfil === 'restaurante') {
    let mesas = 0;
    for (let n = 1; n <= 8; n += 1) {
      if (db.prepare('SELECT 1 FROM restaurant_tables WHERE location_id = ? AND numero = ?').get(locationId, String(n))) continue;
      db.prepare(`INSERT INTO restaurant_tables (id, location_id, numero, status, criado_em) VALUES (?, ?, ?, 'livre', ?)`)
        .run(randomUUID(), locationId, String(n), utc(momentoLocal(125, 9, 0)));
      mesas += 1;
    }
    extras.mesas = mesas;
  }

  return extras;
}

module.exports = { estado, carregar, limpar, trocarPerfil, semear, configurarParaTeste };
