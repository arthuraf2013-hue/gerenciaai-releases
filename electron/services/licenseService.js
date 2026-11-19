const { getDb } = require('../db/database');
const pdvRegistryService = require('./pdvRegistryService');

// Config do projeto Firebase DE LICENCIAMENTO — este é um projeto SEU
// (Arthur), separado do Firebase que cada cliente configura pra
// sincronizar PDVs entre si. Todo instalador leva a MESMA config
// (diferente do sync, que cada cliente digita a sua). Preencha antes
// de publicar — veja LICENCIAMENTO.md pra criar o projeto e pegar
// esses valores.
const LICENSE_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDcfANHaWg7pDGuTZpJJYpHCFXk88DCCrk',
  authDomain: 'gerenciaai-licencas.firebaseapp.com',
  projectId: 'gerenciaai-licencas',
  storageBucket: 'gerenciaai-licencas.firebasestorage.app',
  messagingSenderId: '178576716496',
  appId: '1:178576716496:web:c3bbe7d59299fd135524d5',
};

const GRACE_CONGELADA_DIAS = 2;
const GRACE_SEM_INTERNET_DIAS = 3;
const INTERVALO_CHECAGEM_MS = 6 * 60 * 60 * 1000; // confere a cada 6h (reconciliação de reserva — a escuta em tempo real é o caminho principal enquanto online)
const INTERVALO_PING_MS = 2 * 60 * 1000; // ping de presença a cada 2min — só pra "está online agora?" no painel, escrita bem mais leve que checkLicense()

let licenseApp = null;
/** App Firebase compartilhado (nome 'licensing') -- usado tanto pro
 * Firestore quanto, mais recentemente, pro Storage (backup na nuvem em
 * backupService.js). Um app só, reaproveitado por tudo que fala com
 * esse projeto. */
function getLicenseApp() {
  const { initializeApp, getApps } = require('firebase/app');
  if (!licenseApp) {
    const existente = getApps().find((a) => a.name === 'licensing');
    licenseApp = existente || initializeApp(LICENSE_FIREBASE_CONFIG, 'licensing');
  }
  return licenseApp;
}
/**
 * Testes nunca falam com o Firebase de produção. Antes, alguns testes
 * gravavam de verdade em gerenciaai-licencas: gastavam a cota do dia e,
 * com a cota esgotada, a escrita ficava presa e o `npm test` (e o build
 * de release no GitHub, que roda os testes) não terminava nunca.
 * `node --test` marca NODE_TEST_CONTEXT em cada arquivo de teste;
 * GERENCIAAI_FIREBASE_REAL=1 libera de propósito.
 */
function firebaseRealDesligado() {
  return !!process.env.NODE_TEST_CONTEXT && process.env.GERENCIAAI_FIREBASE_REAL !== '1';
}

let firestoreDesligado = null;
function getLicenseFirestore() {
  const firestoreMod = require('firebase/firestore');
  // Firestore de verdade num teste: devolve uma instância já encerrada
  // (terminate), que recusa na hora qualquer leitura/escrita, como se
  // estivesse sem internet. Testes com Firestore falso (require.cache)
  // não têm terminate e seguem como antes.
  if (firebaseRealDesligado() && typeof firestoreMod.terminate === 'function') {
    if (!firestoreDesligado) {
      firestoreDesligado = firestoreMod.getFirestore(getLicenseApp());
      firestoreMod.terminate(firestoreDesligado).catch(() => {});
    }
    return firestoreDesligado;
  }
  require('./nuvemDisjuntorService').instalarDeteccaoNoSdk();
  return firestoreMod.getFirestore(getLicenseApp());
}

function getLocalState() {
  const db = getDb();
  let row = db.prepare('SELECT * FROM license_state WHERE id = 1').get();
  if (!row) {
    // Só instalação NOVA cria esta linha agora -- as antigas já têm a linha
    // (sem primeira_execucao) e nunca caem na regra de "nunca falou com o
    // servidor" de computeAccessStatus.
    db.prepare(`INSERT INTO license_state (id, status_atual, primeira_execucao) VALUES (1, 'ativa', ?)`).run(new Date().toISOString());
    row = db.prepare('SELECT * FROM license_state WHERE id = 1').get();
  }
  return row;
}

function saveLocalState({ ultimoContatoOk, congeladaDesde, bloqueioImediato, statusAtual, testeFim, contatoComercial }) {
  const db = getDb();
  const atual = getLocalState();
  db.prepare(
    `UPDATE license_state SET ultimo_contato_ok = ?, congelada_desde = ?, bloqueio_imediato = ?, status_atual = ?,
       teste_fim = ?, contato_comercial = ? WHERE id = 1`
  ).run(
    ultimoContatoOk !== undefined ? ultimoContatoOk : atual.ultimo_contato_ok,
    congeladaDesde !== undefined ? congeladaDesde : atual.congelada_desde,
    bloqueioImediato !== undefined ? (bloqueioImediato ? 1 : 0) : atual.bloqueio_imediato,
    statusAtual !== undefined ? statusAtual : atual.status_atual,
    testeFim !== undefined ? testeFim : atual.teste_fim,
    contatoComercial !== undefined ? contatoComercial : atual.contato_comercial,
  );
}

/** Aplica o que veio do servidor (via getDoc ou via onSnapshot) no
 * estado local — usado tanto pela checagem periódica quanto pela
 * escuta em tempo real, pra não duplicar essa lógica nos dois lugares. */
function aplicarDadosDoServidor(dados) {
  const ativo = dados.ativo !== false;
  const bloqueioImediato = dados.bloqueioImediato === true;
  const agora = new Date().toISOString();
  const estadoAnterior = getLocalState();

  // Teste grátis (instalação nova sem cliente): guarda o fim localmente
  // pra valer offline. Documento parcial (sem criadoEm ainda) não apaga um
  // fim já conhecido -- só cliente vinculado ou teste removido apagam.
  const testeService = require('./testeGratisService');
  const fim = testeService.fimDoTeste(dados);
  if (fim != null) saveLocalState({ testeFim: new Date(fim).toISOString() });
  else if (dados.clienteId || (dados.criadoEm && !dados.teste && !dados.testeAte)) saveLocalState({ testeFim: null });

  if (bloqueioImediato) {
    // Bloqueio direto — sem carência nenhuma, diferente do congelamento.
    saveLocalState({ ultimoContatoOk: agora, bloqueioImediato: true, statusAtual: 'inativa' });
  } else if (!ativo) {
    saveLocalState({
      ultimoContatoOk: agora, bloqueioImediato: false,
      congeladaDesde: estadoAnterior.congelada_desde || agora, statusAtual: 'inativa',
    });
  } else {
    saveLocalState({ ultimoContatoOk: agora, congeladaDesde: null, bloqueioImediato: false, statusAtual: 'ativa' });
  }

  // Mesmo documento, mesma leitura — só aproveita os campos de
  // mensagem que vieram junto, sem precisar de outra consulta.
  try {
    require('./messageService').aplicarMensagemDaInstalacao(dados);
  } catch (err) {
    console.error('[licenseService] aplicarMensagemDaInstalacao falhou:', err);
  }

  // Mesma ideia pro grupo de sincronização entre PDVs, atribuído
  // centralmente pelo painel — vem junto no mesmo documento.
  try {
    require('./syncStateService').aplicarGrupoDaInstalacao(dados);
  } catch (err) {
    console.error('[licenseService] aplicarGrupoDaInstalacao falhou:', err);
  }

  // Espelho local dos módulos pagos (Consulta remota, App do garçom) --
  // só o clienteId vem junto neste documento; modulosAtivos em si mora
  // num documento separado (clientes/{clienteId}), então este chamado
  // só decide se precisa (re)iniciar a escuta própria dele.
  try {
    require('./modulosPagosService').aplicarClienteIdDaInstalacao(dados);
  } catch (err) {
    console.error('[licenseService] aplicarClienteIdDaInstalacao (módulos pagos) falhou:', err);
  }

  // Endereço da vitrine online criado na Central -- mesmo documento.
  try {
    require('./vitrineService').aplicarDaInstalacao(dados);
  } catch (err) {
    console.error('[licenseService] aplicarDaInstalacao (vitrine) falhou:', err);
  }

  // Máquina de demonstração (vitrine de demonstração, marcada na Central).
  try {
    require('./vitrineDemoService').aplicarDaInstalacao(dados);
  } catch (err) {
    console.error('[licenseService] aplicarDaInstalacao (vitrine de demonstração) falhou:', err);
  }

  // Override de versão mínima por instalação (rollout gradual/exceção
  // pontual) -- mesmo documento, mesma leitura.
  try {
    require('./updateService').aplicarOverrideDaInstalacao(dados);
  } catch (err) {
    console.error('[licenseService] aplicarOverrideDaInstalacao falhou:', err);
  }

  // Instalação de atualização segurada/liberada pela Central -- mesmo documento.
  try {
    require('./updateService').aplicarControleDaInstalacao(dados);
  } catch (err) {
    console.error('[licenseService] aplicarControleDaInstalacao falhou:', err);
  }

  // Pedido de restauração remota de backup (ver backupService) --
  // fire-and-forget de propósito: se existir um pedido pendente, isso
  // reinicia o app sozinho no final, então não tem "resultado síncrono"
  // útil pra devolver aqui.
  try {
    require('./backupService').restaurarSolicitadoSeHouver(dados).catch((err) => {
      console.error('[licenseService] restaurarSolicitadoSeHouver falhou:', err);
    });
  } catch (err) {
    console.error('[licenseService] não foi possível checar pedido de restauração:', err);
  }

  // Pedido de "backup agora" (botão na tela de Backups da Central) --
  // mesmo padrão fire-and-forget acima.
  try {
    require('./backupService').executarBackupRemotoSeSolicitado(dados).catch((err) => {
      console.error('[licenseService] executarBackupRemotoSeSolicitado falhou:', err);
    });
  } catch (err) {
    console.error('[licenseService] não foi possível checar pedido de backup:', err);
  }
}

/**
 * Consulta o servidor de licenciamento uma vez e atualiza o estado
 * local. Sempre resiliente a falha de rede — se não conseguir falar
 * com o servidor, não atualiza nada; o cálculo de acesso usa o último
 * estado local conhecido, então o app continua funcionando normalmente
 * dentro da carência. Também garante o "heartbeat" (ultimoContato,
 * versaoApp) pro painel saber que a instalação está viva.
 */
/** Nome do computador no Windows (ex.: DESKTOP-APA25LS) -- a Central e o
 * histórico do grupo mostram isso em vez do código da instalação. */
function nomeDoComputador() {
  try {
    return String(require('os').hostname() || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 63) || null;
  } catch { return null; }
}

async function checkLicense() {
  try {
    const { doc, getDoc, setDoc, serverTimestamp } = require('firebase/firestore');
    const { app: electronApp } = require('electron');
    const firestore = getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();
    const ref = doc(firestore, 'installations', installId);
    const snap = await getDoc(ref);
    // Sem chegar ao servidor, o getDoc devolve a cópia da memória do SDK --
    // que pode ser só o pedaço gravado pelo ping (sem grupo, sem cliente)
    // ou "não existe", e aí o ramo de baixo CRIARIA um documento novo por
    // cima do de verdade. Sem servidor, não aplica nem grava nada.
    if (snap.metadata?.fromCache) throw new Error('offline: só a cópia local do documento da instalação');

    const maquinaHash = await require('./testeGratisService').maquinaHash();
    const disjuntor = require('./nuvemDisjuntorService');
    if (snap.exists() && !disjuntor.podeEscrever('licenca')) {
      // Sem cota de escrita hoje: a leitura acima já trouxe bloqueio/
      // liberação da Central; o contato (ultimoContato, métricas) fica
      // para depois em vez de entrar na fila presa do SDK.
      aplicarDadosDoServidor(snap.data());
      if (getLocalState().teste_fim) await atualizarContatoComercial(firestore);
    } else if (snap.exists()) {
      const metricas = require('./metricsService').getMetricasAgregadas();
      await setDoc(ref, {
        ...(maquinaHash ? { maquinaHash } : {}),
        ...(nomeDoComputador() ? { nomeComputador: nomeDoComputador() } : {}),
        ultimoContato: serverTimestamp(), versaoApp: electronApp.getVersion(),
        ...metricas,
        // Pendências e primeiros passos (saudeService) -- a Central mostra
        // na linha da máquina, sem precisar acessar o computador.
        saude: (() => { try { return { ...require('./saudeService').resumoParaCentral(), atualizadoEm: serverTimestamp() }; } catch { return null; } })(),
      }, { merge: true });
      aplicarDadosDoServidor(snap.data());
      if (getLocalState().teste_fim) await atualizarContatoComercial(firestore);
    } else {
      // Primeira vez que essa instalação fala com o servidor — se
      // registra sozinha, sempre começando ativa (o congelamento ou
      // bloqueio é sempre uma ação manual sua depois, pelo painel).
      // Instalação nova começa em teste grátis (ver testeGratisService):
      // o prazo conta do criadoEm (hora do servidor). A Central converte
      // vinculando a um cliente, ou estende.
      await setDoc(ref, {
        ativo: true, bloqueioImediato: false, clienteId: null, nomeNegocio: null,
        totalVendasHistorico: 0, vendasUltimos30Dias: 0, perfilAtivo: null,
        teste: { dias: require('./testeGratisService').DIAS_TESTE },
        ...(maquinaHash ? { maquinaHash } : {}),
        ...(nomeDoComputador() ? { nomeComputador: nomeDoComputador() } : {}),
        criadoEm: serverTimestamp(), ultimoContato: serverTimestamp(), versaoApp: electronApp.getVersion(),
      });
      aplicarDadosDoServidor({ ativo: true, bloqueioImediato: false });
    }
  } catch (err) {
    // Sem internet ou servidor fora é normal e não deveria virar
    // ruído — mas qualquer OUTRO erro (ex: um bug de verdade em algo
    // chamado aqui dentro) ficava completamente invisível antes disso,
    // sem log nenhum, sem rastro nenhum. Se checkLicense() parar de
    // funcionar de vez (por qualquer motivo que não seja rede), agora
    // pelo menos aparece no painel → Erros, em vez de falhar pra
    // sempre em silêncio sem ninguém saber por quê.
    const pareceErroDeRede = /network|fetch|ECONNREFUSED|ENOTFOUND|timeout|offline/i.test(err?.message || '');
    if (!pareceErroDeRede) {
      console.error('[checkLicense] falhou (não parece ser erro de rede):', err);
      require('./errorReportService').reportarErro({
        mensagem: err?.message, stack: err?.stack, contexto: 'checkLicense',
      });
    }
  }

  try {
    return computeAccessStatus();
  } catch (err) {
    // Nunca deixa isso subir sem tratamento — checkLicense() é chamada
    // sem await no main.js (fire-and-forget), e uma promise rejeitada
    // sem handler pode derrubar o processo principal do Electron.
    console.error('[licenseService] computeAccessStatus falhou:', err);
    return { status: 'ok' }; // na dúvida, nunca bloqueia o app por causa de erro interno daqui
  }
}

/** WhatsApp/mensagem comercial publicados pela Central
 * (config_publica/comercial) -- só buscado enquanto a instalação está em
 * teste, pra tela de fim de teste saber com quem falar mesmo offline. */
async function atualizarContatoComercial(firestore) {
  try {
    const { doc, getDoc } = require('firebase/firestore');
    const snap = await getDoc(doc(firestore, 'config_publica', 'comercial'));
    if (!snap.exists()) return;
    const d = snap.data();
    saveLocalState({
      contatoComercial: JSON.stringify({
        whatsapp: typeof d.whatsapp === 'string' ? d.whatsapp.slice(0, 20) : null,
        mensagem: typeof d.mensagemFimTeste === 'string' ? d.mensagemFimTeste.slice(0, 300) : null,
        empresa: typeof d.empresa === 'string' ? d.empresa.slice(0, 80) : null,
      }),
    });
  } catch { /* opcional: sem contato, a tela usa o texto padrão */ }
}

/** Mensagem pronta do botão de WhatsApp do teste, com o código curto da
 * instalação (o mesmo que a Central mostra na lista de testes) -- é como
 * você sabe de qual teste é a conversa. */
function mensagemDoTeste() {
  let codigo = '';
  try { codigo = pdvRegistryService.getOrCreateDeviceUid().replace(/-/g, '').slice(0, 8).toUpperCase(); } catch { codigo = ''; }
  return `Olá! Estou testando o GerenciaAI e quero continuar usando.${codigo ? ` Meu código: ${codigo}` : ''}`;
}

function contatoComercialLocal() {
  try { return JSON.parse(getLocalState().contato_comercial || 'null'); } catch { return null; }
}

let pararEscuta = null;

/**
 * Escuta em tempo real o próprio documento da instalação — assim,
 * quando você congela ou bloqueia pelo painel, o app percebe assim
 * que a mudança chega (poucos segundos, se estiver online), em vez de
 * esperar a checagem periódica de 6h. É o que faz o "bloqueio
 * imediato" ser imediato de verdade, e não só "na próxima checagem".
 * A checagem periódica (checkLicense) continua rodando como reforço —
 * cobre o caso de a escuta cair e não reconectar sozinha, e é o que
 * atualiza o heartbeat (ultimoContato) que o painel mostra.
 */
function iniciarEscutaTempoReal() {
  try {
    const { doc, onSnapshot } = require('firebase/firestore');
    const firestore = getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();
    const ref = doc(firestore, 'installations', installId);

    if (pararEscuta) pararEscuta(); // evita duplicar se chamado mais de uma vez
    pararEscuta = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) return;
        // Só o que veio do servidor. Sem chegar à nuvem (sem internet,
        // Firebase fora), o ping pelo SDK (setDoc com merge) faz o SDK
        // mostrar aqui um documento "de mentira" só com os campos do ping
        // (ultimoPing, versaoApp...): sem grupoSincronizacaoId, clienteId,
        // nada. Aplicado, tirava a máquina do grupo e, quando o documento
        // de verdade voltava, ela "entrava" de novo -- relendo o catálogo
        // inteiro e reenviando todo o histórico de vendas (cota queimada).
        if (snap.metadata?.fromCache) return;
        aplicarDadosDoServidor(snap.data());
        // Botão "Forçar atualização dos dados" da Central (sincronizacaoForcadaService).
        require('./sincronizacaoForcadaService').aoMudarInstalacao(snap.data());
      },
      (err) => {
        // Erro de conexão/permissão — não derruba nada, só loga. A
        // checagem periódica continua cobrindo enquanto a escuta não
        // se restabelece sozinha (o SDK do Firestore tenta reconectar
        // automaticamente).
        console.error('[licenseService] escuta em tempo real falhou:', err);
      }
    );
  } catch (err) {
    console.error('[licenseService] não foi possível iniciar a escuta em tempo real:', err);
  }
}

/**
 * Ping de presença — escreve `ultimoPing` no próprio documento a cada
 * 2 minutos, só isso, sem rodar o resto da lógica de checkLicense()
 * (não precisa reavaliar licença toda hora, só dar sinal de vida
 * leve). É o que o painel usa pra mostrar "online agora" de verdade —
 * o heartbeat de 6h sozinho é grosso demais pra isso (uma instalação
 * podia estar rodando faz horas e ainda aparecer "sem contato" se
 * dependesse só dele).
 *
 * Limitação honesta: como o Firestore não tem um mecanismo de
 * presença nativo tipo onDisconnect() (isso existe no Realtime
 * Database, não no Firestore), se o app fechar de forma abrupta
 * (queda de luz, processo morto à força), o painel só vai mostrar
 * "offline" depois de alguns minutos sem ping novo — não instantâneo.
 */
let ultimaSaudeEnviada = null;
let ultimoReparoEnviado = null;
let pingPeloSdkPendente = false; // no máximo UM ping esperando na fila do SDK
let restComDefeito = false;      // REST recusou o formato: usa só o SDK até reabrir
let fetchDeTeste = null;
let pingNoFirestoreEm = 0;
// Com a presença no Realtime Database ligada (presencaService), a Central
// sabe na hora se a máquina está no ar: o ping no Firestore vira um
// "último contato" a cada 15 min (e quando saúde/reparo mudam).
const PING_FIRESTORE_COM_PRESENCA_MS = 15 * 60 * 1000;

/**
 * Ping de presença por dois caminhos (redundância):
 *   1. REST direto (firestoreRestService): responde na hora, nunca fica
 *      preso nem acumula, e diz claramente "sem cota" (429) ou "sem rede";
 *   2. SDK (setDoc) como reserva, se a REST não chegar ao servidor --
 *      com prazo, e nunca mais de um ping parado na fila do SDK.
 * Sem cota de escrita (nuvemDisjuntorService), não gasta nada: só uma
 * sonda a cada 10 min para ver se a cota voltou antes da hora.
 */
async function enviarPing() {
  const disjuntor = require('./nuvemDisjuntorService');
  const conectividade = require('./connectivityService');
  try {
    if (!disjuntor.podeEscrever() && !disjuntor.deveSondar()) return;
    const rest = require('./firestoreRestService');
    const AGORA = rest.AGORA_NO_SERVIDOR;
    const installId = pdvRegistryService.getOrCreateDeviceUid();
    // Pendências (saudeService) vão junto só quando MUDAM -- a Central vê
    // em até 2 min sem custar uma escrita maior a cada ping.
    const extra = {};
    let assinatura = null;
    try {
      const saude = require('./saudeService').resumoParaCentral();
      assinatura = JSON.stringify(saude);
      if (assinatura !== ultimaSaudeEnviada) extra.saude = { ...saude, atualizadoEm: AGORA };
    } catch { /* banco ainda abrindo */ }
    // Prontidão do reparo automático (Windows): mesmo esquema, só quando muda.
    let assinaturaReparo = null;
    try {
      const reparo = require('./reparoInstalacaoService').resumoParaCentral();
      if (reparo) {
        assinaturaReparo = JSON.stringify(reparo);
        if (assinaturaReparo !== ultimoReparoEnviado) extra.reparo = { ...reparo, atualizadoEm: AGORA };
      }
    } catch { /* reparo é extra, nunca atrapalha o ping */ }
    let comPresenca = false;
    try { comPresenca = require('./presencaService').estaConectado(); } catch { /* sem presença */ }
    if (comPresenca && !extra.saude && !extra.reparo && Date.now() - pingNoFirestoreEm < PING_FIRESTORE_COM_PRESENCA_MS) {
      conectividade.marcarOnline();
      return;
    }
    const st = disjuntor.status();
    const dados = {
      ultimoPing: AGORA,
      ...extra,
      // Quem gastou a cota hoje (lista: substitui a do dia anterior inteira).
      nuvem: {
        escritasHoje: Object.entries(st.escritasHoje).map(([origem, n]) => ({ origem, n })),
        ultimaFaltaDeCotaEm: st.ultimaFaltaDeCotaEm,
      },
    };
    const gravou = () => {
      if (extra.saude) ultimaSaudeEnviada = assinatura; // só depois de gravar de verdade
      if (extra.reparo) ultimoReparoEnviado = assinaturaReparo;
      disjuntor.registrarEscritaOk();
      disjuntor.contar('ping', 1);
      pingNoFirestoreEm = Date.now();
      // Esse ping já é a chamada de rede mais frequente e mais leve que a
      // instalação faz o tempo todo — aproveita pra alimentar o sinal
      // genérico de "estamos online?" usado pelo indicador do PDV (ver
      // connectivityService.js), em vez de criar outra checagem só pra isso.
      conectividade.marcarOnline();
    };

    // 1) REST
    const fetchRest = fetchDeTeste || (firebaseRealDesligado() ? null : undefined);
    if (!restComDefeito && fetchRest !== null) {
      const r = await rest.mesclar({
        projeto: LICENSE_FIREBASE_CONFIG.projectId, apiKey: LICENSE_FIREBASE_CONFIG.apiKey,
        caminho: `installations/${installId}`, dados, exigirExistente: true, fetch: fetchRest || null,
      });
      if (r.ok) { gravou(); return; }
      if (r.motivo === 'sem-cota') {
        disjuntor.registrarFaltaDeCota({ tipo: 'escrita' });
        conectividade.marcarOnline(); // a internet está boa; quem parou foi a nuvem
        return;
      }
      if (r.motivo === 'sem-documento' || r.motivo === 'sem-permissao') {
        // O servidor respondeu: o documento ainda não existe (checkLicense
        // cria) -- o ping não cria documento pela metade.
        conectividade.marcarOnline();
        return;
      }
      if (r.motivo === 'pedido-invalido') {
        restComDefeito = true;
        require('./errorReportService').reportarErro({ mensagem: `ping REST recusado: ${r.mensagem}`, contexto: 'ping_rest' });
      }
      // sem-rede / servidor / pedido-invalido: tenta pelo SDK.
    }

    // 2) SDK (reserva)
    if (pingPeloSdkPendente) { conectividade.marcarOffline(); return; }
    const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
    const paraSdk = (v) => {
      if (v === AGORA) return serverTimestamp();
      if (Array.isArray(v)) return v.map(paraSdk);
      if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, paraSdk(x)]));
      return v;
    };
    const ref = doc(getLicenseFirestore(), 'installations', installId);
    const escrita = Promise.resolve().then(() => setDoc(ref, paraSdk(dados), { merge: true }));
    pingPeloSdkPendente = true;
    escrita.then(() => { pingPeloSdkPendente = false; }, () => { pingPeloSdkPendente = false; });
    await disjuntor.comPrazo(escrita, 20000, 'ping');
    gravou();
  } catch (err) {
    // Sem internet, ou o app acabou de abrir e ainda nem criou o
    // documento — não tem problema, o próximo ping tenta de novo.
    if (!disjuntor.status().escritaPausada) conectividade.marcarOffline();
  }
}

function _definirFetchDoPingParaTeste(fn) { fetchDeTeste = fn; restComDefeito = false; pingPeloSdkPendente = false; }

function iniciarPingDePresenca() {
  enviarPing();
  setInterval(enviarPing, INTERVALO_PING_MS);
}

/**
 * Decide se o app deve funcionar normal, mostrar aviso, ou bloquear —
 * baseado só no estado LOCAL, sem chamada de rede. Pode ser chamado a
 * qualquer momento, inclusive totalmente offline.
 */
function computeAccessStatus() {
  const state = getLocalState();
  const agora = Date.now();

  if (state.bloqueio_imediato) {
    return { status: 'bloqueado', motivo: 'bloqueio_imediato' };
  }

  if (state.congelada_desde) {
    const diasCongelada = (agora - new Date(state.congelada_desde).getTime()) / 86400000;
    if (diasCongelada >= GRACE_CONGELADA_DIAS) {
      return { status: 'bloqueado', motivo: 'congelada' };
    }
    return { status: 'aviso', motivo: 'congelada', diasRestantes: Math.max(0, GRACE_CONGELADA_DIAS - diasCongelada) };
  }

  if (state.ultimo_contato_ok) {
    const diasSemContato = (agora - new Date(state.ultimo_contato_ok).getTime()) / 86400000;
    if (diasSemContato >= GRACE_SEM_INTERNET_DIAS) {
      return { status: 'bloqueado', motivo: 'sem_internet' };
    }
  }
  // Se ultimo_contato_ok ainda é nulo (instalação nova, ou nunca
  // conseguiu falar com o servidor desde sempre), deixa passar — não
  // trava alguém só porque a rede caiu bem na primeira execução, ou
  // porque o projeto de licenciamento ainda não foi configurado.
  // Exceção: instalação nova que passou do prazo do teste sem NUNCA
  // conseguir falar com o servidor (internet bloqueada de propósito).
  if (!state.ultimo_contato_ok && state.primeira_execucao) {
    const dias = (agora - new Date(state.primeira_execucao).getTime()) / 86400000;
    if (dias >= require('./testeGratisService').DIAS_TESTE) return { status: 'bloqueado', motivo: 'sem_internet' };
  }

  // Teste grátis -- relógio sincronizado (timeService), não o do Windows.
  if (state.teste_fim) {
    const testeService = require('./testeGratisService');
    const t = testeService.situacao(new Date(state.teste_fim).getTime(), require('./timeService').nowMs());
    if (t) {
      const contato = contatoComercialLocal();
      const extra = {
        contato: contato ? { ...contato, link: testeService.linkWhatsapp(contato.whatsapp, mensagemDoTeste()) } : null,
      };
      if (t.expirado) return { status: 'bloqueado', motivo: 'teste_expirado', teste: t, ...extra };
      return { status: 'ok', teste: t, ...extra };
    }
  }

  return { status: 'ok' };
}

module.exports = {
  nomeDoComputador,
  checkLicense, computeAccessStatus, iniciarEscutaTempoReal, iniciarPingDePresenca, enviarPing, getLicenseFirestore, getLicenseApp,
  firebaseRealDesligado, _definirFetchDoPingParaTeste,
  aplicarDadosDoServidor, // exportada pra teste (não toca rede)
  GRACE_CONGELADA_DIAS, GRACE_SEM_INTERNET_DIAS, INTERVALO_CHECAGEM_MS, INTERVALO_PING_MS,
};
