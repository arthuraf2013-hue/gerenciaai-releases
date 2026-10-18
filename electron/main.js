const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { getDb } = require('./db/database');
// ipc/handlers (que carrega TODOS os serviços do app) é carregado só
// depois de pedir a janela -- ver o comentário em app.whenReady.
const sessionService = require('./services/sessionService');
const timeService = require('./services/timeService');
const backupService = require('./services/backupService');
const updateService = require('./services/updateService');
const licenseService = require('./services/licenseService');
const errorReportService = require('./services/errorReportService');
const reservationService = require('./services/reservationService');
const appointmentService = require('./services/appointmentService');

const isDev = !app.isPackaged;

// Reporta qualquer erro não tratado no processo principal antes de deixar
// o comportamento padrão do Node acontecer (fechar o processo) — sem
// isso, um crash no processo principal simplesmente fecharia o app sem
// nenhum rastro, nem pro Arthur nem pro cliente.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  errorReportService.reportarErro({ mensagem: err.message, stack: err.stack, contexto: 'processo-principal' })
    .finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[unhandledRejection]', err);
  errorReportService.reportarErro({ mensagem: err.message, stack: err.stack, contexto: 'processo-principal-promise' });
  // Não derruba o processo aqui — promise rejeitada sem handler é mais
  // comum e geralmente recuperável, diferente de uma exceção síncrona.
});

// Protocolo customizado app:// — evita as restrições do Chromium para
// carregar módulos ES via file:// em produção.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// Impede duas instâncias do app rodando ao mesmo tempo na mesma
// máquina. Sem isso, uma instância antiga esquecida aberta (minimizada,
// ou de um teste anterior) continua rodando seu próprio checkLicense()
// periódico com a versão ANTIGA embutida — e pode sobrescrever, no
// Firestore, o que a instância nova acabou de escrever, fazendo a
// versão parecer "travada" no painel mesmo depois de atualizar de
// verdade e abrir o app novo. Quem tenta abrir uma segunda vez só foca
// a janela que já está aberta, em vez de abrir outra por cima.
const temOLock = app.requestSingleInstanceLock();
if (!temOLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const janelas = BrowserWindow.getAllWindows();
    if (janelas.length > 0) {
      const win = janelas[0];
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    icon: path.join(__dirname, '../build/icon.png'),
    show: false, // só mostra a janela quando o conteúdo já estiver pronto (ver ready-to-show) — evita o flash de tela branca em PCs mais lentos, onde o carregamento demora mais
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true, // necessário para o visualizador de PDF nativo funcionar embutido (iframe)
      // Guarda o código JS já compilado da interface em disco desde a
      // primeira abertura (sem esperar o "aquecimento" padrão do V8) --
      // as aberturas seguintes pulam boa parte da compilação, o que pesa
      // muito num processador de entrada.
      v8CacheOptions: 'bypassHeatCheck',
    },
  });

  win.once('ready-to-show', () => win.show());

  // A sessão real desta janela (ver sessionService.js) vive só enquanto a
  // janela existe -- sem isso, um webContents.id reciclado pelo Chromium
  // depois que a janela fecha podia, em teoria, herdar a sessão de quem
  // usou aquele id antes. O id é capturado aqui (não dentro do listener
  // 'closed') porque win.webContents já pode estar destruído quando
  // 'closed' dispara.
  const webContentsId = win.webContents.id;
  win.on('closed', () => sessionService.encerrarSessao(webContentsId));

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    // Host fixo "app" — nunca muda durante o carregamento de recursos
    // relativos (JS/CSS gerados pelo Vite), então o "pathname" da URL
    // sempre reflete o caminho real do arquivo dentro de dist/.
    // (Carregar "app://index.html" direto, sem host fixo, faz o Chromium
    // tratar "index.html" como se fosse o domínio — todo recurso relativo
    // carregado depois vira "app://index.html/assets/...", uma pasta que
    // não existe. Essa era a causa da tela branca no build empacotado.)
    win.loadURL('app://app/index.html');

    // Bloqueia o DevTools fora de desenvolvimento -- o app roda com PINs,
    // dados de cliente e (antes desta mesma leva de mudanças) confiava em
    // campos que o próprio renderer mandava; deixar o DevTools acessível
    // numa build de produção facilita demais inspecionar/chamar canais
    // IPC na mão. Duas camadas: intercepta o atalho de teclado ANTES dele
    // abrir o DevTools, e fecha de novo se abrir por outro caminho (menu
    // do Chromium, extensão, etc).
    win.webContents.on('before-input-event', (event, input) => {
      const tecla = (input.key || '').toLowerCase();
      const combinacaoDevTools =
        tecla === 'f12' ||
        (input.control && input.shift && ['i', 'j', 'c'].includes(tecla));
      if (combinacaoDevTools) event.preventDefault();
    });
    win.webContents.on('devtools-opened', () => win.webContents.closeDevTools());
  }

  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.error('[did-fail-load]', errorCode, errorDescription, validatedURL);
  });

  return win;
}

/** Chama `fn` uma vez, quando a janela já está desenhada na tela
 * (ready-to-show) -- ou depois de 8 s, o que vier primeiro (se a
 * janela demorar demais, ou um erro de carregamento impedir o evento,
 * as tarefas de segundo plano não podem ficar paradas pra sempre). */
function quandoJanelaPronta(win, fn) {
  let chamado = false;
  const uma = () => { if (!chamado) { chamado = true; fn(); } };
  win.once('ready-to-show', uma);
  setTimeout(uma, 8000);
}

app.whenReady().then(() => {
  // Segunda camada de proteção do lock de instância única — o
  // app.quit() chamado mais acima é assíncrono, então sem essa
  // checagem aqui, uma instância "perdedora" ainda podia chegar a
  // inicializar serviço (checkLicense, ping de presença) antes do
  // quit() terminar de verdade.
  if (!temOLock) return;
  if (!isDev) {
    protocol.handle('app', (request) => {
      const { pathname } = new URL(request.url);
      const relativePath = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      const fullPath = path.join(__dirname, '../dist', relativePath);
      return net.fetch(pathToFileURL(fullPath).toString());
    });
  }

  // Janela PRIMEIRO, no mesmo "tick" síncrono de getDb() e dos
  // handlers de IPC logo abaixo: o processo do Chromium (o que mais
  // demora pra subir numa máquina de entrada) começa a carregar EM
  // PARALELO com o resto da inicialização, em vez de só depois dela. É
  // seguro porque nenhuma mensagem do renderer (IPC) é atendida antes de
  // este bloco síncrono inteiro terminar -- handlers, banco e o
  // autoUpdater (ver comentário de setupAutoUpdater) já estão prontos
  // quando a primeira chamada da janela chega.
  const janelaPrincipal = createWindow();

  getDb(); // garante schema criado e seed aplicado antes de atender a janela
  timeService.startAutoSync(); // sincroniza com a internet assim que possível, e a cada 15 min
  require('./ipc/handlers').registerIpcHandlers();

  // Tem que existir antes da PRIMEIRA mensagem da janela -- a tela de
  // atualização obrigatória (UpdateGate) pode disparar uma checagem de
  // atualização assim que abre (baseada só em dado local, sem esperar
  // nada de rede), e se isso acontecer antes dos listeners do
  // autoUpdater existirem, o resultado da checagem (achou, não achou,
  // deu erro) se perde no vazio. Foi exatamente isso que deixava a tela
  // de bloqueio presa, enquanto o fluxo manual em Configurações (que só
  // roda bem depois, com tudo já pronto) funcionava normal. Como a
  // janela só fala com o processo principal depois deste bloco síncrono,
  // aqui ainda é "antes".
  updateService.setupAutoUpdater();

  // ---------------------------------------------------------------
  // Tarefas de segundo plano EM ETAPAS (v1.0). Antes tudo isto subia de
  // uma vez junto com a janela: Firebase (~0,1 s só pra carregar a
  // biblioteca num PC bom, várias vezes isso num Celeron), conexão do
  // WhatsApp (Baileys, ~0,4 s), backup diário copiando o banco inteiro,
  // repassada do histórico pro grupo... tudo disputando CPU e disco com
  // a primeira tela, que numa máquina fraca demorava pra responder.
  // Agora a tela abre primeiro e cada grupo entra depois; nada deixou
  // de rodar, só começa um pouco mais tarde. Em modo leve (máquina de
  // entrada, ver hardwareService) os atrasos são maiores.
  // ---------------------------------------------------------------
  const modoLeve = require('./services/hardwareService').modoLeve();
  const ATRASO_ETAPA_1_MS = 1500; // conexão com a central: licença, atualização obrigatória, celulares
  const ATRASO_ETAPA_2_MS = modoLeve ? 40000 : 15000; // publicações pro celular, catálogo do grupo, WhatsApp
  const ATRASO_ETAPA_3_MS = modoLeve ? 150000 : 60000; // backup diário, repassada do histórico pro grupo
  quandoJanelaPronta(janelaPrincipal, () => {
    setTimeout(iniciarEtapa1, ATRASO_ETAPA_1_MS);
    setTimeout(iniciarEtapa2, ATRASO_ETAPA_2_MS);
    setTimeout(iniciarEtapa3, ATRASO_ETAPA_3_MS);
  });

  function iniciarEtapa1() {
    // Limpa o status de download/instalação no Firestore assim que o app
    // sobe — sem isso, depois que o cliente reinicia na versão nova, o
    // painel continuava mostrando "baixado, aguardando reiniciar" pra
    // sempre (o status só era escrito DURANTE o download, nunca
    // "zerado" depois que o reinício de verdade acontecia).
    updateService.reportarProgressoNoFirestore().catch((err) => console.error('[update]', err));
    // Confere se uma atualização que tinha ficado marcada como "baixada,
    // esperando reiniciar" realmente foi aplicada -- se o app reabriu
    // ainda na versão antiga, reporta pra Central (aba Erros, contexto
    // 'atualizacao_falhou') e tenta buscar a atualização de novo sozinho.
    updateService.verificarAtualizacaoFoiAplicada();
    updateService.iniciarEscutaAtualizacaoObrigatoria();

    // Licenciamento — confere com o servidor central se a instalação
    // está ativa. Nunca trava a abertura do app esperando rede (roda em
    // segundo plano); o bloqueio de verdade, se acontecer, é decidido
    // pelo próprio React a partir do estado local já salvo.
    licenseService.checkLicense().catch((err) => console.error('[license]', err));
    licenseService.iniciarEscutaTempoReal();
    licenseService.iniciarPingDePresenca();
    require('./services/messageService').iniciarEscutaMensagemGlobal();
    // Pareamento de celular e o que chega DO celular (pedido do garçom,
    // venda do PDV móvel) -- logo no começo: alguém pode estar esperando
    // do outro lado.
    require('./services/pairingService').iniciarEscutaPareamentos();
    require('./services/pedidoGarcomSyncService').iniciarEscutaPedidosGarcom();
    // PDV móvel -- vendas feitas no celular (pareado com tipo 'pdv')
    // viram venda de verdade aqui, consultas sob demanda (produto fora do
    // catálogo publicado, cliente, Pix) e config/sinal de vida pro celular.
    // Ver pdvMobileSyncService.js.
    require('./services/pdvMobileSyncService').iniciarPdvMobile();
    // Celular PDV mobile autônomo que foi migrado pra cá e virou TERMINAL
    // deste computador (decidido na Central): recebe as vendas feitas
    // nele (mesmo offline, chegam quando a rede volta) e publica o
    // catálogo pra ele. Só escuta; se não houver terminal, não escreve nada.
    require('./services/pdvMobileTerminalService').iniciarTerminais();
  }

  function iniciarEtapa2() {
    require('./services/productSyncService').iniciarEscutaProdutos();
    // Status ao vivo pro celular de quem já estiver pareado — ver
    // liveStatusSyncService.js (só publica se houver celular pareado).
    require('./services/liveStatusSyncService').iniciarPublicacaoContinua();
    // Lista de funcionários (nome/papel/status) pra quem parear como
    // "Consulta remota" -- ver userStatusSyncService.js e a seção
    // "Usuários" em pwa-mobile/consulta.js.
    require('./services/userStatusSyncService').iniciarPublicacaoContinua();
    // Histórico de vendas (últimos 7/30 dias) pra quem parear como
    // "Consulta remota" -- ver historySyncService.js e a seção
    // "Histórico" em pwa-mobile/consulta.js.
    require('./services/historySyncService').iniciarPublicacaoContinua();
    // Reconecta sozinho no chatbot de WhatsApp se esta máquina já tinha
    // sido pareada antes e a aba "Separação" está ativada — sem isso, o
    // bot só voltaria a responder depois de alguém abrir Configurações
    // manualmente a cada vez que o app é reiniciado.
    require('./services/whatsappBotService').iniciarAutomaticamenteSeConfigurado();
  }

  function iniciarEtapa3() {
    // Backup automático (uma vez por dia). Verifica de novo
    // periodicamente porque muita farmácia deixa o app aberto o dia
    // inteiro sem reiniciar.
    backupService.runBackupIfNeeded().catch((err) => console.error('[backup]', err));
    setInterval(() => backupService.runBackupIfNeeded().catch((err) => console.error('[backup]', err)), 2 * 60 * 60 * 1000);

    // Espelho das vendas no grupo de sincronização -- o push de cada
    // venda ao finalizar é best-effort (não trava a venda se a rede cair
    // naquele instante exato); este ciclo recupera o que falhou. Desde a
    // v1.0 manda só o que ainda não foi (ver salesSyncService.pushPeriodico
    // e a tabela group_sync_sales), com uma repassada completa dos
    // últimos 60 dias uma vez por dia.
    const pushGrupo = () => executarSeNaoEstiverRodando('grupoVendas', () => require('./services/salesSyncService').pushPeriodico());
    pushGrupo();
    setInterval(pushGrupo, 15 * 60 * 1000);
  }
  setTimeout(() => { try { updateService.checkForUpdates(); } catch (err) { console.error('[update]', err); } }, 60 * 1000);
  setInterval(() => { try { updateService.checkForUpdates(); } catch (err) { console.error('[update]', err); } }, 4 * 60 * 60 * 1000);
  setInterval(() => licenseService.checkLicense().catch((err) => console.error('[license]', err)), licenseService.INTERVALO_CHECAGEM_MS);
  // Estatísticas do planejador do SQLite em dia (PRAGMA optimize) -- o
  // app costuma ficar aberto o dia inteiro, e as tabelas de venda/estoque
  // crescem; recomendado pelo próprio SQLite pra conexão de vida longa.
  setInterval(() => require('./db/database').otimizarBanco(), 6 * 60 * 60 * 1000);

  // Lembrete de reserva "1h antes" — não existe agendador exato no
  // projeto (ver comentário em reservationService.findPendingLembrete),
  // então isso segue o mesmo padrão dos outros jobs periódicos daqui:
  // uma checagem a cada poucos minutos. 5 min garante pelo menos uma
  // passada dentro da janela de 10 min (55-65 min antes) que
  // findPendingLembrete usa, mesmo se o app ficar momentaneamente sem
  // conexão com o WhatsApp num ciclo (tenta de novo no próximo, a
  // reserva só é marcada como "lembrete enviado" se o envio realmente
  // funcionar). Também aproveita o mesmo ciclo pra limpar reservas que
  // ficaram "aguardando confirmação" por tempo demais sem resposta.
  setInterval(() => executarSeNaoEstiverRodando('lembretesDeReserva', checarLembretesDeReserva), 5 * 60 * 1000);

  // Lembrete de agendamento "1h antes" -- mesmo padrão e mesma janela
  // do lembrete de reserva acima, ver appointmentService.
  // findPendingLembrete. Não precisa de um job separado de "limpeza" de
  // agendamento vencido sem resposta (diferente da reserva): a janela
  // de 3h em appointmentService.findAguardandoConfirmacaoByTelefone já
  // resolve isso sozinha (ver comentário lá).
  setInterval(() => executarSeNaoEstiverRodando('lembretesDeAgendamento', checarLembretesDeAgendamento), 5 * 60 * 1000);

  // Automações proativas do WhatsApp (reconquista, alerta de estoque,
  // resumo diário) + cupom automático de aniversário — ver
  // whatsappAutomationService.js. Roda a cada 10 min; cada função
  // internamente decide se já é "hoje" o suficiente pra agir de novo
  // (cooldown por cliente ou guarda de uma vez por dia), então rodar
  // com essa frequência só deixa o efeito mais perto de imediato assim
  // que a condição vira verdadeira (ex: acabou de bater o horário do
  // resumo diário) sem mandar nada duplicado.
  setInterval(() => executarSeNaoEstiverRodando('automacoesWhatsapp', checarAutomacoesWhatsapp), 10 * 60 * 1000);

  // NFC-e que ficaram 'pendente' (falha de rede na hora de emitir) ou
  // 'contingencia' (emitida offline, tpEmis=9, esperando a SEFAZ
  // voltar) — tenta reenviar a cada 5 min. reenviarNFCe é idempotente
  // o bastante pro caso comum (SEFAZ ainda fora do ar: só volta a
  // falhar e tenta de novo no próximo ciclo, sem duplicar nada).
  setInterval(() => executarSeNaoEstiverRodando('fiscalReenvio', reenviarPendentesEContingencia), 5 * 60 * 1000);

  // Vendas que ficaram esperando confirmação de estoque do grupo (rede
  // caiu bem no momento de finalizar — ver
  // saleService.finalizeSaleComVerificacaoDeGrupo/stockSyncService).
  // Intervalo bem mais curto que os outros jobs desta lista de propósito:
  // o backoff de cada venda pendente começa em 10s (ver
  // BACKOFF_ESTOQUE_GRUPO_MS em saleService.js) — um ciclo de 5 min como
  // os outros faria o operador esperar minutos por uma queda de conexão
  // que já tinha voltado há tempo. Quando não há nenhuma venda pendente
  // (o caso comum, a imensa maioria das vezes), a função já filtra isso
  // numa única consulta local antes de qualquer chamada de rede — rodar
  // a cada 10s não pesa nada nesse caso.
  setInterval(
    () => executarSeNaoEstiverRodando('estoqueGrupoRetry', () => require('./services/saleService').tentarFinalizarVendasPendentesDeEstoque()),
    10 * 1000
  );

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((err) => {
  // Se algo travar aqui (ex: uma migração de banco falhando, ou
  // qualquer outro erro síncrono na inicialização), sem esse catch o
  // app fecharia silenciosamente sem abrir janela nenhuma, sem deixar
  // nenhum rastro visível pra quem está usando — só um log que
  // ninguém vê. Mostra um alerta nativo em vez disso.
  console.error('[inicialização]', err);
  const { dialog } = require('electron');
  dialog.showErrorBox(
    'GerenciaAI não conseguiu iniciar',
    `Ocorreu um erro ao abrir o sistema:\n\n${err?.message || err}\n\nTente abrir o app de novo. Se continuar acontecendo, entre em contato com o suporte e informe esta mensagem.`
  );
  app.quit();
});

// Cada um desses 3 jobs periódicos faz uma ou mais chamadas assíncronas
// (rede/WhatsApp, SEFAZ) que podem demorar mais que o próprio intervalo
// do setInterval em uma máquina lenta ou com internet ruim -- sem essa
// guarda, uma passada que ainda não terminou se sobrepõe com a próxima,
// podendo mandar a mesma mensagem duas vezes ou reenviar a mesma NFC-e
// em paralelo. `jobsEmExecucao` garante que só uma execução de cada job
// roda por vez; se a anterior ainda não terminou, a nova chamada é
// simplesmente pulada (a próxima passada do setInterval tenta de novo).
const jobsEmExecucao = new Set();
function executarSeNaoEstiverRodando(nomeJob, fn) {
  if (jobsEmExecucao.has(nomeJob)) return;
  jobsEmExecucao.add(nomeJob);
  Promise.resolve()
    .then(fn)
    .catch((err) => console.error(`[${nomeJob}]`, err))
    .finally(() => jobsEmExecucao.delete(nomeJob));
}

/** Manda o "confirma sua reserva?" pra quem está a ~1h do horário
 * marcado, e limpa reservas que ficaram esperando resposta por tempo
 * demais. Ver reservationService.findPendingLembrete/
 * marcarNaoConfirmadasVencidas pro porquê da janela de tempo. */
async function checarLembretesDeReserva() {
  const agora = timeService.agoraLocalString();
  const pendentes = reservationService.findPendingLembrete(agora);
  if (pendentes.length) {
    const whatsappBotHandler = require('./services/whatsappBotHandler');
    const whatsappBotService = require('./services/whatsappBotService');
    for (const reserva of pendentes) {
      const quando = whatsappBotHandler.formatarDataHoraReserva(reserva.data_hora);
      const texto = `Oi, ${reserva.cliente_nome}! Passando pra confirmar: sua reserva de ${reserva.pessoas} pessoa(s) é ${quando} 🙂 Pode confirmar? Responda *sim* ou *não*.`;
      const resultado = await whatsappBotService.enviarMensagem({ telefone: reserva.cliente_telefone, texto });
      if (resultado.ok) {
        reservationService.marcarLembreteEnviado(reserva.id);
      } else {
        // Não marca como enviado -- assim a próxima passada do
        // setInterval tenta de novo enquanto a reserva ainda estiver
        // dentro da janela de 55-65 min (ex: WhatsApp caiu bem na hora).
        console.error('[reserva] falha ao mandar lembrete', reserva.id, resultado.error);
      }
    }
  }
  reservationService.marcarNaoConfirmadasVencidas(agora);
}

/** Mesma ideia de checarLembretesDeReserva, agora pro agendamento de
 * horário (salão/beleza) -- ver appointmentService.findPendingLembrete.
 * Sem "marcar vencidas" no final (diferente da reserva): não muda
 * status nenhum, então não tem nada pra limpar -- ver comentário na
 * coluna lembrete_enviado_em em schema.sql. */
async function checarLembretesDeAgendamento() {
  const agora = timeService.agoraLocalString();
  const pendentes = appointmentService.findPendingLembrete(agora);
  if (!pendentes.length) return;

  const whatsappBotHandler = require('./services/whatsappBotHandler');
  const whatsappBotService = require('./services/whatsappBotService');
  for (const agendamento of pendentes) {
    if (!agendamento.clienteTelefone) continue; // agendamento manual sem telefone -- não tem pra onde mandar
    const quando = whatsappBotHandler.formatarDataHoraReserva(agendamento.data_hora_inicio);
    const nome = agendamento.clienteNome || 'tudo bem';
    const texto = `Oi, ${nome}! Passando pra confirmar: seu horário de ${agendamento.servico} com ${agendamento.profissionalNome} é ${quando} 🙂 Pode confirmar? Responda *sim* ou *não*.`;
    const resultado = await whatsappBotService.enviarMensagem({ telefone: agendamento.clienteTelefone, texto });
    if (resultado.ok) {
      appointmentService.marcarLembreteEnviado(agendamento.id);
    } else {
      // Não marca como enviado -- mesma lógica de checarLembretesDeReserva.
      console.error('[agendamento] falha ao mandar lembrete', agendamento.id, resultado.error);
    }
  }
}

/** Dispara as automações do WhatsApp de dono/loja (não são conversa com
 * cliente, então não passam pelo whatsappBotHandler) — mesmo local
 * único usado pelos outros pontos do app que precisam de um locationId
 * "padrão" fora do contexto de uma tela (ver whatsappBotHandler.js). */
async function checarAutomacoesWhatsapp() {
  const whatsappAutomationService = require('./services/whatsappAutomationService');
  const locationId = getDb().prepare('SELECT id FROM locations LIMIT 1').get()?.id || null;
  await whatsappAutomationService.executarCupomAniversario();
  await whatsappAutomationService.executarReconquistaAutomatica();
  if (locationId) {
    await whatsappAutomationService.executarAlertaEstoqueBaixo({ locationId });
    await whatsappAutomationService.executarResumoDiario({ locationId });
  }
}

/** Roda por cima de toda NFC-e ainda 'pendente' ou 'contingencia' e
 * tenta transmitir de novo — a maior parte do tempo isso não vai
 * fazer nada (a lista vem vazia, ou a SEFAZ ainda está fora), mas é
 * assim que uma venda feita em contingência acaba virando 'autorizada'
 * de verdade sem exigir que alguém entre na tela e clique em
 * "reenviar" manualmente pra cada uma. */
async function reenviarPendentesEContingencia() {
  const fiscalService = require('./services/fiscalService');
  const pendentes = fiscalService.listNfcePendentesOuContingencia();
  for (const nfce of pendentes) {
    const resultado = await fiscalService.reenviarNFCe(nfce.id);
    if (!resultado.ok) {
      console.error('[fiscalReenvio] falha ao reenviar', nfce.id, resultado.error);
    }
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
