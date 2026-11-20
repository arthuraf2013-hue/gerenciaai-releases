// Ferramentas do papel suporte (aba Configurações -> Suporte; só `suporte`):
//
//   zerar        apaga os dados desta instalação e reabre como no primeiro uso,
//                mantendo a licença, a identidade da máquina (o PDV na Central),
//                a configuração de backup/atualização e a numeração da NFC-e;
//   clonar       no caixa ligado ao servidor pela rede local: zera e fica com o
//                que vem do servidor -- configuração da loja agora, cadastros
//                (produtos e fotos, clientes, fiado, usuários) pela réplica do
//                grupo ao reabrir. Mantém o grupo, a ligação com o servidor, as
//                impressoras/balança/maquininha deste PC e a NFC-e deste PC;
//   diagnostico  retrato do grupo (rede local, versões, filas, contagens);
//   forcarEnvio / forcarRecebimento  empurra as filas / relê tudo do grupo;
//   conferir     compara os cadastros daqui com os do grupo (no servidor).
//
// Antes de zerar/clonar: cópia do banco em backups/antes-de-zerar-*.sqlite3
// (nunca apagada pela rotação) e as pastas de fotos/anexos movidas para
// backups/antes-de-zerar-*-arquivos. Pendência que ainda não foi para o grupo
// (venda, baixa de estoque, cadastro) trava a operação, a não ser que o suporte
// mande descartar (fica só nesse backup). Tudo vai para a Auditoria e para a
// Central (errorReportService, contexto "suporte:...").

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

// Sempre ficam: identidade e licença da máquina, controle de atualização,
// configuração de backup e a numeração fiscal (NFC-e repetida é rejeitada pela SEFAZ).
const MANTER_SEMPRE = [
  'schema_migrations', 'locations', 'license_state', 'modulos_pagos_state', 'firebase_config',
  'forced_update_state', 'atualizacao_controle', 'backup_config', 'fiscal_config',
];
// Clonar mantém também o que liga este PC ao grupo e o que é DESTE equipamento.
const MANTER_AO_CLONAR = [
  'sync_state', 'lan_cliente', 'lan_meta',
  'receipt_config', 'pos_display_config', 'scale_hardware_config', 'cozinha_impressao_config', 'maquininha_config',
];
// Configuração da loja que o caixa recebe do servidor ao clonar. `manterAqui`:
// colunas que são do equipamento (impressora deste PC), não da loja.
const CONFIG_DA_LOJA = [
  { tabela: 'business_profile' },
  { tabela: 'custom_profiles' },
  { tabela: 'categories' },
  { tabela: 'receipt_config', manterAqui: ['impressora_padrao', 'imprimir_automatico'] },
  { tabela: 'impressao_estudio' },
  { tabela: 'digital_menu_config' },
  { tabela: 'payment_config' },
  { tabela: 'card_fee_config' },
  { tabela: 'loyalty_config' },
  { tabela: 'security_config' },
  { tabela: 'service_price_table_config' },
  { tabela: 'scale_barcode_config' },
  { tabela: 'tax_rules' },
];
// Pastas de dados que saem junto (fotos voltam do servidor ao clonar).
const PASTAS_DE_DADOS = ['fotos-produtos', 'anexos', 'whatsapp-bot-auth', 'demonstracao'];
const PREFIXO_BACKUP = 'antes-de-zerar-';

let pastaBaseDeTeste = null;
function pastaBase() {
  if (pastaBaseDeTeste) return pastaBaseDeTeste;
  try {
    const { app } = require('electron');
    if (app?.getPath) return app.getPath('userData');
  } catch { /* fora do Electron */ }
  return path.join(__dirname, '../../.data');
}
function pastaBackups() {
  const dir = path.join(pastaBase(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const grupoAtual = () => { try { return require('./syncStateService').getGrupoSincronizacaoId() || null; } catch { return null; } };
const ehServidor = () => { try { return !!grupoAtual() && require('./syncStateService').ehServidorDoGrupo(); } catch { return false; } };
const versaoDoApp = () => { try { const { app } = require('electron'); return app?.getVersion ? app.getVersion() : null; } catch { return null; } };
const conta = (db, sql, ...p) => { try { return Number(db.prepare(sql).get(...p)?.c || 0); } catch { return 0; } };

// ------------------------------------------------------------------ pendências

/** O que ainda não saiu deste computador (e se perderia ao zerar). */
function pendencias() {
  const db = getDb();
  const grupoId = grupoAtual();
  const lista = [
    { chave: 'vendasAbertas', texto: 'vendas/comandas abertas', n: conta(db, "SELECT COUNT(*) c FROM sales WHERE status = 'aberta'") },
    { chave: 'caixaAberto', texto: 'caixa aberto', n: conta(db, 'SELECT COUNT(*) c FROM cash_sessions WHERE fechada_em IS NULL') },
    // Filas do grupo só contam dentro de um grupo (fora dele os gatilhos
    // enfileiram, mas nada vai a lugar nenhum).
    { chave: 'estoqueParaEnviar', texto: 'baixas/entradas de estoque esperando ir para o grupo', n: grupoId ? conta(db, 'SELECT COUNT(*) c FROM estoque_grupo_pendente WHERE grupo_id = ?', grupoId) : 0 },
    { chave: 'vendasEsperandoEstoque', texto: 'vendas esperando confirmar o estoque do grupo', n: conta(db, 'SELECT COUNT(*) c FROM sales WHERE pendente_estoque_grupo = 1') },
    { chave: 'cadastrosParaEnviar', texto: 'cadastros (produtos/clientes) esperando ir para o grupo', n: grupoId ? conta(db, 'SELECT COUNT(*) c FROM grupo_replica_pendente') : 0 },
    { chave: 'fotosParaEnviar', texto: 'fotos esperando ir para o grupo', n: grupoId ? conta(db, 'SELECT COUNT(*) c FROM grupo_replica_foto_enviar') : 0 },
    { chave: 'mesasParaAvisar', texto: 'contas de mesa pagas aqui esperando o servidor confirmar', n: conta(db, 'SELECT COUNT(*) c FROM mesa_remota_fechamentos') },
    {
      chave: 'vendasParaEnviar',
      texto: 'vendas finalizadas que ainda não foram para o grupo',
      n: grupoId ? conta(db, `SELECT COUNT(*) c FROM sales s WHERE s.status = 'finalizada'
        AND NOT EXISTS (SELECT 1 FROM group_sync_sales g WHERE g.sale_id = s.id AND g.grupo_id = ?)`, grupoId) : 0,
    },
  ];
  return lista.filter((p) => p.n > 0);
}

// ------------------------------------------------------------------ zerar / clonar

function tabelasDoBanco(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
}

/** Apaga tudo menos `manter` (no lugar: o arquivo, o esquema e as migrações continuam). */
function apagarDados(db, manter) {
  const ficar = new Set(manter);
  const tabelas = tabelasDoBanco(db).filter((t) => !ficar.has(t));
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      // Duas passadas: gatilhos de uma tabela podem escrever em fila de outra.
      for (let i = 0; i < 2; i++) for (const t of tabelas) db.prepare(`DELETE FROM "${t}"`).run();
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return tabelas.length;
}

function moverPastas(destino) {
  const movidas = [];
  for (const nome of PASTAS_DE_DADOS) {
    const origem = path.join(pastaBase(), nome);
    if (!fs.existsSync(origem)) continue;
    fs.mkdirSync(destino, { recursive: true });
    const alvo = path.join(destino, nome);
    try {
      fs.renameSync(origem, alvo);
    } catch {
      fs.cpSync(origem, alvo, { recursive: true });
      fs.rmSync(origem, { recursive: true, force: true });
    }
    movidas.push(nome);
  }
  return movidas;
}

function semear(db) {
  // Mesmo padrão de uma instalação nova (admin de fábrica com PIN 0000, perfis).
  // O resto das linhas padrão volta na inicialização, ao reabrir.
  require('../db/database').seedIfEmpty(db);
}

function auditar(db, tipo, solicitanteNome, motivo) {
  try {
    db.prepare(`INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso) VALUES (?, ?, NULL, ?, 1)`)
      .run(randomUUID(), tipo, `${motivo} (por ${solicitanteNome || 'suporte'})`);
  } catch (err) { console.error('[suporte] auditoria:', err?.message || err); }
}

function avisarCentral(acao, mensagem) {
  try {
    require('./errorReportService').reportarErro({ mensagem: String(mensagem).slice(0, 300), contexto: `suporte:${acao}` })
      ?.catch?.(() => {});
  } catch { /* sem nuvem: fica só na Auditoria */ }
}

function pararServicosDoGrupo() {
  for (const [mod, fn] of [['./grupoReplicaService', 'parar'], ['./userSyncService', 'parar'], ['./mesaCompartilhadaService', 'pararEscuta']]) {
    try { require(mod)[fn]?.(); } catch { /* melhor esforço */ }
  }
}

/** Configuração da loja deste computador (o servidor manda para o caixa que vai clonar). */
function configDaLoja() {
  const db = getDb();
  const existentes = new Set(tabelasDoBanco(db));
  const tabelas = {};
  for (const { tabela } of CONFIG_DA_LOJA) {
    if (existentes.has(tabela)) tabelas[tabela] = db.prepare(`SELECT * FROM "${tabela}"`).all();
  }
  return { versao: versaoDoApp(), tabelas };
}

/** Grava a configuração da loja recebida do servidor (só colunas que existem aqui). */
function aplicarConfigDaLoja(db, dados) {
  const tabelas = dados?.tabelas || {};
  const existentes = new Set(tabelasDoBanco(db));
  const aplicadas = [];
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const { tabela, manterAqui = [] } of CONFIG_DA_LOJA) {
        const linhas = tabelas[tabela];
        if (!Array.isArray(linhas) || !existentes.has(tabela)) continue;
        const colunas = new Set(db.prepare(`PRAGMA table_info("${tabela}")`).all().map((c) => c.name));
        const daqui = manterAqui.length ? db.prepare(`SELECT * FROM "${tabela}"`).all() : [];
        db.prepare(`DELETE FROM "${tabela}"`).run();
        for (const linha of linhas) {
          const cols = Object.keys(linha || {}).filter((c) => colunas.has(c));
          if (!cols.length) continue;
          const valores = cols.map((c) => {
            if (manterAqui.includes(c)) {
              const mesma = daqui.find((d) => d.id !== undefined && d.id === linha.id) || daqui[0];
              return mesma ? mesma[c] : null;
            }
            return linha[c];
          });
          db.prepare(`INSERT INTO "${tabela}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...valores);
        }
        aplicadas.push(tabela);
      }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return aplicadas;
}

/**
 * Zerar (modo 'zerar') ou clonar do servidor (modo 'clonar').
 * `descartarPendencias`: segue mesmo com coisa que não foi para o grupo.
 * `configServidor`: no clonar, a configuração da loja já buscada no servidor
 * (quem chama busca ANTES -- sem ela, nada é apagado).
 */
async function zerar({ solicitanteId, modo = 'zerar', descartarPendencias = false, configServidor = null } = {}) {
  const guard = require('./authService').requireRole(solicitanteId, ['suporte']);
  if (!guard.ok) return guard;
  if (modo !== 'zerar' && modo !== 'clonar') return { ok: false, error: 'Operação inválida.' };
  const db = getDb();
  const solicitante = db.prepare('SELECT nome FROM users WHERE id = ?').get(solicitanteId)?.nome || null;

  if (modo === 'clonar') {
    if (!grupoAtual()) return { ok: false, error: 'Este computador não está em um grupo: não há servidor para clonar.' };
    if (ehServidor()) return { ok: false, error: 'Este computador é o servidor do grupo: clonar é só nos caixas.' };
    if (!configServidor?.tabelas) return { ok: false, error: 'Não recebi a configuração da loja do servidor. Nada foi apagado.' };
  }

  const pend = pendencias();
  if (pend.length && !descartarPendencias) {
    return { ok: false, pendencias: pend, error: `Há coisas que ainda não saíram deste computador: ${pend.map((p) => `${p.n} ${p.texto}`).join('; ')}. Use "Forçar envio" antes, ou marque para descartar.` };
  }

  const carimbo = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const nomeBackup = `${PREFIXO_BACKUP}${carimbo}.sqlite3`;
  try {
    await db.backup(path.join(pastaBackups(), nomeBackup));
  } catch (err) {
    return { ok: false, error: `Não consegui guardar a cópia de segurança (${err.message}). Nada foi apagado.` };
  }

  pararServicosDoGrupo();
  let pastas = [];
  try {
    pastas = moverPastas(path.join(pastaBackups(), `${PREFIXO_BACKUP}${carimbo}-arquivos`));
  } catch (err) {
    console.error('[suporte] pastas de dados:', err?.message || err);
  }

  const manter = modo === 'clonar' ? [...MANTER_SEMPRE, ...MANTER_AO_CLONAR] : MANTER_SEMPRE;
  const tabelasApagadas = apagarDados(db, manter);
  semear(db);
  let configAplicada = [];
  if (modo === 'clonar') configAplicada = aplicarConfigDaLoja(db, configServidor);
  try { require('./estoqueServidorService').invalidar(); } catch { /* sem cache */ }

  const descartadas = pend.length ? ` Pendências descartadas: ${pend.map((p) => `${p.n} ${p.texto}`).join('; ')}.` : '';
  const motivo = modo === 'clonar'
    ? `Instalação clonada do servidor do grupo (configuração da loja: ${configAplicada.length} tabelas; cadastros chegam ao reabrir). Cópia: ${nomeBackup}.${descartadas}`
    : `Instalação zerada (licença e NFC-e mantidas). Cópia: ${nomeBackup}.${descartadas}`;
  auditar(db, modo === 'clonar' ? 'suporte_clonar_servidor' : 'suporte_zerar_instalacao', solicitante, motivo);
  avisarCentral(modo, motivo);
  return { ok: true, reiniciar: true, backup: nomeBackup, pastas, tabelasApagadas, configAplicada };
}

// ------------------------------------------------------------------ diagnóstico

async function medirServidor() {
  const inicio = Date.now();
  try {
    const r = await require('./lanClienteService').pedido('/v1/ping', {}, { timeoutMs: 4000 });
    return { ok: true, ms: Date.now() - inicio, nome: r?.hubNome || null, versao: r?.versao || null, pronto: r?.pronto !== false };
  } catch (err) {
    return { ok: false, ms: Date.now() - inicio, erro: err?.message || String(err) };
  }
}

async function diagnostico() {
  const db = getDb();
  const grupoId = grupoAtual();
  const servidor = ehServidor();
  const local = db.prepare('SELECT nome, device_uid, numero_pdv FROM locations LIMIT 1').get() || {};
  let transporte = null;
  try { transporte = require('./grupoTransporteService').status(); } catch { /* sem grupo */ }
  let mesas = null;
  try { mesas = require('./mesaCompartilhadaService').situacao(); } catch { /* idem */ }
  let fotos = null;
  try { fotos = require('./grupoFotoService').progresso(); } catch { /* idem */ }
  const rede = grupoId && !servidor && transporte?.cliente ? await medirServidor() : null;
  let hostname = null;
  try { hostname = require('os').hostname(); } catch { /* sem os */ }
  return {
    geradoEm: new Date().toISOString(),
    computador: { nome: hostname, pdv: local.numero_pdv || null, instalacao: local.device_uid || null, versao: versaoDoApp() },
    grupo: {
      id: grupoId,
      papel: !grupoId ? 'fora de grupo' : servidor ? 'servidor' : 'caixa',
      modo: transporte?.modo || null,
      redeLocal: servidor
        ? { ligada: !!transporte?.hub?.ligado, enderecos: transporte?.hub?.enderecos || [], caixas: (transporte?.hub?.caixas || []).map((c) => ({ nome: c.nome, ultimoContato: c.ultimo_contato || null })) }
        : transporte?.cliente ? { servidor: transporte.cliente.servidor, enderecos: transporte.cliente.enderecos || [], teste: rede } : null,
      mesas: mesas?.motivo === undefined ? null : (mesas.motivo || 'usando as mesas do servidor'),
      ultimoErro: transporte?.ultimoErro || null,
    },
    filas: pendencias(),
    fotos,
    contagens: {
      produtos: conta(db, 'SELECT COUNT(*) c FROM products WHERE ativo = 1'),
      clientes: conta(db, 'SELECT COUNT(*) c FROM customers'),
      usuarios: conta(db, 'SELECT COUNT(*) c FROM users WHERE ativo = 1'),
      mesas: conta(db, 'SELECT COUNT(*) c FROM restaurant_tables'),
      vendasFinalizadas: conta(db, "SELECT COUNT(*) c FROM sales WHERE status = 'finalizada'"),
    },
  };
}

/** Texto do diagnóstico para copiar/salvar e mandar ao suporte. */
function relatorioEmTexto(d) {
  const l = [];
  l.push(`Diagnóstico GerenciaAI - ${d.geradoEm}`);
  l.push(`Computador: ${d.computador.nome || '?'} | ${d.computador.pdv || 'sem número de PDV'} | versão ${d.computador.versao || '?'}`);
  l.push(`Instalação: ${d.computador.instalacao || '?'}`);
  l.push(`Grupo: ${d.grupo.id || '-'} (${d.grupo.papel}) | modo: ${d.grupo.modo || '-'}`);
  const r = d.grupo.redeLocal;
  if (r && 'ligada' in r) {
    l.push(`Rede local (servidor): ${r.ligada ? 'ligada' : 'DESLIGADA'} em ${r.enderecos.join(', ') || '-'}`);
    l.push(`Caixas ligados: ${r.caixas.length ? r.caixas.map((c) => `${c.nome} (último contato ${c.ultimoContato || '?'})`).join('; ') : 'nenhum'}`);
  } else if (r) {
    l.push(`Rede local (caixa): servidor ${r.servidor || '?'} em ${r.enderecos.join(', ') || '-'}`);
    if (r.teste) l.push(r.teste.ok ? `Servidor respondeu em ${r.teste.ms} ms (versão ${r.teste.versao || 'antiga'})` : `Servidor NÃO respondeu (${r.teste.erro})`);
  }
  if (d.grupo.mesas) l.push(`Mesas: ${d.grupo.mesas}`);
  if (d.grupo.ultimoErro) l.push(`Último erro da rede: ${d.grupo.ultimoErro}`);
  l.push(`Filas: ${d.filas.length ? d.filas.map((p) => `${p.n} ${p.texto}`).join('; ') : 'nada pendente'}`);
  if (d.fotos) l.push(`Fotos: enviar ${d.fotos.enviar?.faltam ?? '?'} | baixar ${d.fotos.baixar?.faltam ?? '?'}`);
  const c = d.contagens;
  l.push(`Cadastros aqui: ${c.produtos} produtos ativos, ${c.clientes} clientes, ${c.usuarios} usuários ativos, ${c.mesas} mesas, ${c.vendasFinalizadas} vendas finalizadas`);
  return l.join('\n');
}

// ------------------------------------------------------------------ forçar filas

async function passo(nome, fn) {
  try {
    const r = await fn();
    return { passo: nome, ok: r?.ok !== false, detalhe: r?.error || null };
  } catch (err) {
    return { passo: nome, ok: false, detalhe: err?.message || String(err) };
  }
}

async function forcarEnvio() {
  const passos = [
    await passo('Cadastros (produtos e clientes)', () => require('./grupoReplicaService').enviarPendentes()),
    await passo('Usuários', () => require('./userSyncService').sincronizarTudo()),
    await passo('Estoque (baixas e entradas)', () => require('./stockSyncService').enviarVariacoesPendentes()),
    await passo('Vendas esperando o estoque do grupo', () => require('./saleService').tentarFinalizarVendasPendentesDeEstoque({ forcar: true })),
    await passo('Vendas para o relatório do grupo', async () => ({ ok: await require('./salesSyncService').pushTodoOHistorico({ apenasPendentes: true }) !== false })),
    await passo('Contas de mesa pagas aqui', () => require('./mesaCompartilhadaService').processarFila()),
  ];
  const grupoId = grupoAtual();
  if (grupoId) passos.push(await passo('Fotos', () => require('./grupoReplicaService').trabalharFotos(grupoId)));
  return { ok: passos.every((p) => p.ok), passos, pendencias: pendencias() };
}

async function forcarRecebimento() {
  const passos = [
    await passo('Cadastros do grupo (produtos, clientes, fiado)', () => require('./grupoReplicaService').sincronizarTudo()),
    await passo('Usuários do grupo', () => require('./userSyncService').sincronizarTudo()),
  ];
  try { require('./estoqueServidorService').invalidar(); } catch { /* sem cache */ }
  const grupoId = grupoAtual();
  if (grupoId) passos.push(await passo('Fotos', () => require('./grupoReplicaService').trabalharFotos(grupoId)));
  return { ok: passos.every((p) => p.ok), passos };
}

// ------------------------------------------------------------------ conferir com o grupo

/** O que o grupo tem (no servidor: a cópia dele; usado pela rota da rede local). */
function resumoDoGrupo(grupoId) {
  const armazem = require('./lanArmazemService');
  const lista = (colecao) => [...armazem.lerTodos(grupoId, colecao)].map(([doc, d]) => ({
    doc, nome: d?.nome || null, ativo: d?.ativo === undefined ? true : !!d.ativo && d.ativo !== 0,
  }));
  return { produtos: lista('produtos'), clientes: lista('clientes'), usuarios: lista('usuarios') };
}

const MAX_NOMES = 50;

/** Compara os cadastros daqui com o resumo do grupo. */
function comparar(db, grupoId, resumo) {
  const comparacao = (remotos, locais) => {
    const docsAqui = new Set(locais.filter((l) => l.doc).map((l) => l.doc));
    const docsGrupo = new Set(remotos.map((r) => r.doc));
    const faltandoAqui = remotos.filter((r) => r.ativo && !docsAqui.has(r.doc));
    const soAqui = locais.filter((l) => l.ativo && (!l.doc || !docsGrupo.has(l.doc)));
    return {
      noGrupo: remotos.filter((r) => r.ativo).length,
      aqui: locais.filter((l) => l.ativo).length,
      faltandoAqui: faltandoAqui.length,
      soAqui: soAqui.length,
      nomesFaltandoAqui: faltandoAqui.slice(0, MAX_NOMES).map((r) => r.nome || r.doc),
      nomesSoAqui: soAqui.slice(0, MAX_NOMES).map((l) => l.nome),
    };
  };
  const vinculados = (entidade, tabela, filtroAtivo) => db.prepare(
    `SELECT t.nome, ${filtroAtivo} AS ativo, r.doc_id AS doc FROM ${tabela} t
     LEFT JOIN grupo_replica r ON r.entidade = ? AND r.grupo_id = ? AND r.local_id = t.id`
  ).all(entidade, grupoId).map((l) => ({ ...l, ativo: !!l.ativo }));
  const usuarios = db.prepare(
    `SELECT u.nome, u.ativo, s.doc_id AS doc, u.role FROM users u
     LEFT JOIN user_group_sync s ON s.user_id = u.id AND s.grupo_id = ?`
  ).all(grupoId).map((u) => ({ ...u, ativo: !!u.ativo }));
  return {
    produtos: comparacao(resumo.produtos || [], vinculados('produtos', 'products', 't.ativo')),
    clientes: comparacao(resumo.clientes || [], vinculados('clientes', 'customers', 't.ativo')),
    usuarios: comparacao(resumo.usuarios || [], usuarios),
  };
}

async function conferir() {
  const grupoId = grupoAtual();
  if (!grupoId) return { ok: false, error: 'Este computador não está em um grupo.' };
  let resumo;
  try {
    resumo = ehServidor()
      ? resumoDoGrupo(grupoId)
      : await require('./lanClienteService').pedido('/v1/suporte/resumo', {}, { timeoutMs: 20000 });
  } catch (err) {
    return { ok: false, error: `O servidor não respondeu pela rede local (${err?.message || err}).` };
  }
  return { ok: true, servidor: ehServidor(), ...comparar(getDb(), grupoId, resumo) };
}

/** Busca no servidor a configuração da loja (antes de clonar). */
async function buscarConfigDoServidor() {
  try {
    const r = await require('./lanClienteService').pedido('/v1/suporte/config-loja', {}, { timeoutMs: 15000 });
    if (!r?.tabelas) return { ok: false, error: 'O servidor respondeu sem a configuração da loja. Atualize o servidor para a mesma versão deste caixa.' };
    return { ok: true, config: r };
  } catch (err) {
    if (err?.status === 404) return { ok: false, error: 'O servidor está numa versão antiga, sem clonagem. Atualize o servidor primeiro.' };
    return { ok: false, error: `O servidor não respondeu pela rede local (${err?.message || err}). Nada foi apagado.` };
  }
}

async function clonar({ solicitanteId, descartarPendencias = false } = {}) {
  const guard = require('./authService').requireRole(solicitanteId, ['suporte']);
  if (!guard.ok) return guard;
  if (!grupoAtual()) return { ok: false, error: 'Este computador não está em um grupo: não há servidor para clonar.' };
  if (ehServidor()) return { ok: false, error: 'Este computador é o servidor do grupo: clonar é só nos caixas.' };
  try {
    if (!require('./mesaCompartilhadaService').podeUsar()) {
      return { ok: false, error: 'Este caixa não está ligado ao servidor pela rede local. Ligue em Configurações → Sincronização → Rede local da loja.' };
    }
  } catch { return { ok: false, error: 'Não consegui conferir a rede local.' }; }
  const pend = pendencias();
  if (pend.length && !descartarPendencias) {
    return { ok: false, pendencias: pend, error: `Há coisas que ainda não saíram deste computador: ${pend.map((p) => `${p.n} ${p.texto}`).join('; ')}. Use "Forçar envio" antes, ou marque para descartar.` };
  }
  const busca = await buscarConfigDoServidor();
  if (!busca.ok) return busca;
  return zerar({ solicitanteId, modo: 'clonar', descartarPendencias, configServidor: busca.config });
}

function _definirPastaBaseParaTeste(p) { pastaBaseDeTeste = p || null; }

module.exports = {
  pendencias, zerar, clonar, configDaLoja, aplicarConfigDaLoja, diagnostico, relatorioEmTexto,
  forcarEnvio, forcarRecebimento, resumoDoGrupo, comparar, conferir,
  MANTER_SEMPRE, MANTER_AO_CLONAR, CONFIG_DA_LOJA, PREFIXO_BACKUP, _definirPastaBaseParaTeste,
};
