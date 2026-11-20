/**
 * Por onde os dados do grupo andam neste computador agora:
 *
 *   'hub'   servidor do grupo com caixas ligados pela rede local: usa a cópia
 *           do grupo deste computador (lanArmazemService), atende os caixas
 *           (lanHubService) e espelha na nuvem (lanEspelhoService);
 *   'lan'   caixa ligado ao servidor e servidor respondendo: tudo pela rede;
 *   'nuvem' o de sempre, direto no Firestore (sem rede local, ou servidor fora).
 *
 * Os serviços do grupo (grupoReplicaService, userSyncService, stockSyncService,
 * salesSyncService) perguntam `backend(tipo)` a cada operação; null = Firestore.
 * Ao trocar de modo, as escutas são religadas e cada lado acerta o que faltou
 * (as filas locais continuam valendo, as versões decidem conflitos).
 */

const syncState = require('./syncStateService');
const armazem = require('./lanArmazemService');

const CHECAR_MS = 30 * 1000;

let modo = 'nuvem';
let avaliando = null;
let relogio = null;
let falhasSeguidas = 0;
let tentativasSemServidor = 0;
let ultimoErro = null;
let iniciado = false;

function hubService() { return require('./lanHubService'); }
function espelho() { return require('./lanEspelhoService'); }
function cliente() { return require('./lanClienteService'); }

function contextoDoHub(grupoId) {
  let nome = null;
  try { nome = require('./licenseService').nomeDoComputador(); } catch { /* sem nome */ }
  return { grupoId, hubId: require('./pdvRegistryService').getOrCreateDeviceUid(), nome };
}

let suprimirReligar = false; // primeira avaliação: as réplicas ainda nem ligaram

function religarReplicas() {
  if (suprimirReligar) return;
  setImmediate(() => {
    try { require('./grupoReplicaService').iniciar(); } catch (err) { console.error('[transporte]', err?.message || err); }
    try { require('./userSyncService').iniciar(); } catch (err) { console.error('[transporte]', err?.message || err); }
  });
}

function trocarModo(novo, motivo) {
  if (novo === modo) return;
  console.warn(`[transporte] dados do grupo: ${modo} -> ${novo}${motivo ? ` (${motivo})` : ''}`);
  modo = novo;
  religarReplicas();
}

async function avaliarAgora() {
  const grupoId = syncState.getGrupoSincronizacaoId();
  const servidor = !!grupoId && syncState.ehServidorDoGrupo();
  const presenca = require('./presencaService');

  if (!grupoId) {
    hubService().desligar(); espelho().parar(); presenca.anunciarHub(null, null);
    trocarModo('nuvem', 'sem grupo');
    return;
  }
  armazem.esquecerOutrosGrupos(grupoId);

  if (servidor) {
    if (cliente().config()) cliente().desligar(); // virou servidor: não é mais caixa de outro
    // Caixas ligados a este servidor num grupo antigo não valem para o novo.
    if (armazem.lerMeta('hub_grupo') !== grupoId) {
      hubService().esquecerTodosOsCaixas();
      armazem.gravarMeta('hub_grupo', grupoId);
    }
    const precisaHub = hubService().temCaixas() || hubService().codigoValido();
    if (!precisaHub) {
      hubService().desligar(); espelho().parar(); presenca.anunciarHub(null, null);
      trocarModo('nuvem', 'nenhum caixa ligado pela rede local');
      return;
    }
    espelho().iniciar(grupoId);
    try {
      await hubService().ligar(contextoDoHub(grupoId));
      const st = hubService().status();
      const ctx = contextoDoHub(grupoId);
      presenca.anunciarHub(grupoId, { hubId: ctx.hubId, nome: ctx.nome || null, enderecos: st.enderecos.slice(0, 8) });
      ultimoErro = null;
    } catch (err) {
      ultimoErro = `Não deu para abrir a porta da rede local: ${err?.message || err}`;
      console.error('[transporte]', ultimoErro);
    }
    trocarModo(hubService().temCaixas() && espelho().pronto(grupoId) ? 'hub' : 'nuvem', 'servidor');
    return;
  }

  // Caixa
  hubService().desligar(); espelho().parar(); presenca.anunciarHub(null, null);
  const cfg = cliente().config();
  if (!cfg) { trocarModo('nuvem', 'não ligado a um servidor'); return; }
  if (cfg.grupoId !== grupoId) { cliente().desligar(); trocarModo('nuvem', 'grupo mudou'); return; }
  try {
    const r = await cliente().ping();
    if (r.grupoId !== grupoId) throw new Error('servidor de outro grupo');
    falhasSeguidas = 0; tentativasSemServidor = 0; ultimoErro = null;
    trocarModo(r.pronto ? 'lan' : 'nuvem', r.pronto ? 'servidor respondeu' : 'servidor ainda preparando a cópia');
  } catch (err) {
    falhasSeguidas += 1;
    ultimoErro = err?.message || String(err);
    // Uma falha só (rede piscou) não derruba; duas seguidas, sim.
    if (modo !== 'lan' || falhasSeguidas >= 2) trocarModo('nuvem', 'servidor não respondeu');
    tentativasSemServidor += 1;
    if (tentativasSemServidor % 4 === 1) cliente().reencontrar().catch(() => {});
  }
}

/** Reavalia o modo (uma por vez; quem pede no meio espera a mesma). */
function reavaliar() {
  if (avaliando) return avaliando;
  avaliando = avaliarAgora().catch((err) => {
    ultimoErro = err?.message || String(err);
    console.error('[transporte] falha ao avaliar a rede local:', ultimoErro);
  }).finally(() => { avaliando = null; });
  return avaliando;
}

/**
 * Liga a avaliação periódica. A primeira avaliação não religa as réplicas
 * (quem chama liga depois, já no modo certo -- ver main.js).
 */
function iniciar() {
  if (iniciado) return reavaliar();
  iniciado = true;
  espelho().aoFicarPronto(() => reavaliar());
  relogio = setInterval(() => { reavaliar(); }, CHECAR_MS);
  relogio.unref?.();
  suprimirReligar = true;
  return reavaliar().finally(() => { suprimirReligar = false; });
}

function parar() {
  if (relogio) clearInterval(relogio);
  relogio = null; iniciado = false;
  hubService().desligar(); espelho().parar();
  modo = 'nuvem';
}

/** Falha de rede numa operação em modo 'lan': confere já (não espera 30 s). */
function avisarFalha(err) {
  if (modo === 'lan' && err?.rede) { falhasSeguidas = Math.max(falhasSeguidas, 1); reavaliar(); }
}

function comAviso(fn) {
  return async (...args) => {
    try { return await fn(...args); } catch (err) { avisarFalha(err); throw err; }
  };
}

/** Implementação para cada serviço do grupo, ou null = Firestore. */
function backend(tipo) {
  if (modo === 'nuvem') return null;
  const hub = modo === 'hub';
  const c = cliente();
  switch (tipo) {
    case 'replica':
      return hub ? {
        lerTodos: async (g, colecao) => armazem.lerTodos(g, colecao),
        lerAlguns: async (g, colecao, ids) => armazem.lerAlguns(g, colecao, ids), // fotos: só a cópia da loja, sem nuvem
        gravarLote: async (g, colecao, itens) => { armazem.gravar(g, colecao, itens); },
        escutar: (g, colecao, aoMudar) => armazem.escutar(g, colecao, aoMudar),
      } : {
        lerTodos: comAviso((_g, colecao) => c.lerTodos(colecao)),
        lerAlguns: comAviso((_g, colecao, ids) => c.lerAlguns(colecao, ids)),
        gravarLote: comAviso((_g, colecao, itens) => c.gravarLote(colecao, itens)),
        escutar: (_g, colecao, aoMudar, aoErrar) => c.escutar(colecao, aoMudar, (err) => { avisarFalha(err); aoErrar?.(err); }),
      };
    case 'usuarios':
      return hub ? {
        lerTodos: async (g) => armazem.lerTodos(g, 'usuarios'),
        gravar: async (g, docId, dados) => { armazem.gravar(g, 'usuarios', [{ docId, dados }]); },
        escutar: (g, aoMudar) => armazem.escutar(g, 'usuarios', aoMudar),
      } : {
        lerTodos: comAviso(() => c.lerTodos('usuarios')),
        gravar: comAviso((_g, docId, dados) => c.gravarLote('usuarios', [{ docId, dados }])),
        escutar: (_g, aoMudar, aoErrar) => c.escutar('usuarios', aoMudar, (err) => { avisarFalha(err); aoErrar?.(err); }),
      };
    case 'estoque':
      return hub ? {
        aplicarMovimento: async (m) => armazem.aplicarMovimento(m.grupoId, m),
        lerContadoresExistentes: async (g) => new Set(armazem.lerContadores(g).keys()),
        gravarContadores: async (g, linhas, opcoes) => armazem.gravarContadores(g, linhas, opcoes),
        verificarEDebitar: async ({ grupoId, itens, operacaoId }) => armazem.verificarEDebitar(grupoId, itens, operacaoId ? `local:${operacaoId}` : null),
      } : {
        aplicarMovimento: comAviso((m) => c.aplicarMovimento({ productId: m.productId, movimentoId: m.movimentoId, delta: m.delta, motivo: m.motivo || null })),
        lerContadoresExistentes: null,
        gravarContadores: null,
        verificarEDebitar: comAviso(({ itens, operacaoId }) => c.verificarEDebitar(itens, operacaoId)),
      };
    case 'vendas':
      return hub ? {
        gravar: async (g, itens) => { armazem.gravar(g, 'vendas', itens); },
        periodo: async (g, de, ate) => armazem.vendasDoPeriodo(g, de, ate),
      } : {
        gravar: comAviso((_g, itens) => c.gravarLote('vendas', itens)),
        periodo: comAviso((_g, de, ate) => c.vendasDoPeriodo(de, ate)),
      };
    default:
      return null;
  }
}

function status() {
  const grupoId = syncState.getGrupoSincronizacaoId();
  const servidor = !!grupoId && syncState.ehServidorDoGrupo();
  const cfg = (() => { try { return cliente().config(); } catch { return null; } })();
  return {
    modo,
    grupo: !!grupoId,
    servidor,
    hub: servidor ? hubService().status() : null,
    espelho: servidor ? espelho().status() : null,
    cliente: !servidor && cfg ? { servidor: cfg.hubNome || cfg.hubId, hubId: cfg.hubId, enderecos: cfg.enderecos } : null,
    ultimoErro,
  };
}

function modoAtual() { return modo; }
function _definirModoParaTeste(m) { modo = m; }

module.exports = { iniciar, parar, reavaliar, backend, status, modoAtual, avisarFalha, _definirModoParaTeste };
