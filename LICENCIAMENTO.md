# Licenciamento — guia de configuração

Este documento explica como colocar o sistema de licenciamento pra
funcionar. É um passo a passo — leia até o fim antes de começar,
porque a ordem importa.

## O que foi construído

- **No app** (`electron/services/licenseService.js`): a cada 6 horas
  (e ao abrir), confere com um servidor central se a instalação está
  ativa. Se estiver congelada, mostra um aviso e continua funcionando
  por **2 dias**; depois disso, bloqueia. Se não conseguir falar com o
  servidor de jeito nenhum (sem internet), continua funcionando por
  **3 dias** antes de bloquear — pra não travar alguém só por falha de
  rede.
- **O painel** (`admin-panel/index.html`): um site simples, sem
  precisar de build, onde você vê todas as instalações, o status de
  cada uma, e pode congelar ou reativar com um clique.

Os dois falam com o **mesmo projeto Firebase** — um projeto **seu**,
separado do Firebase que cada cliente configura pra sincronizar PDVs
entre si (aquilo é opcional e por conta de cada cliente; isto aqui é
seu, embutido em todo instalador, igual pra todo mundo).

## Passo 1 — Criar o projeto Firebase

1. Acesse [console.firebase.google.com](https://console.firebase.google.com)
   e crie um projeto novo (ex: "gerenciaai-licencas").
2. No menu lateral, entre em **Firestore Database** → "Criar banco de
   dados" → modo produção → escolha a região mais próxima (ex:
   `southamerica-east1`).
3. Ainda no menu lateral, entre em **Authentication** → "Vamos
   começar" → ative o provedor **E-mail/senha**.
4. Em Authentication → aba "Users" → "Add user" → cadastre **seu
   próprio e-mail e uma senha forte**. Esse é o login que você vai usar
   no painel — não dá acesso a mais ninguém além de quem você
   cadastrar aqui manualmente. Desde a versão atual das regras (Passo
   3 mais abaixo), esse login não é só pra entrar na TELA — as regras
   do Firestore conferem ele de verdade antes de deixar ler/editar
   cliente, cobrança, log de auditoria e afins, então sem cadastrar
   esse usuário aqui você não consegue nem entrar no painel nem editar
   nada disso por fora.
5. Ainda em Authentication → Sign-in method, ative também o provedor
   **Anônimo** (Anonymous). É o que o PWA do celular (garçom/consulta)
   usa pra se autenticar sem pedir login nenhum ao funcionário — sem
   isso ativado, o celular nem consegue carregar a tela de digitar o
   código de pareamento, falha na hora com erro de conexão/login. Não
   tem nada a ver com o e-mail/senha do passo 3 acima (aquele é só seu,
   pro painel) — o app do desktop, por sua vez, nunca usa Firebase Auth
   em nada, só o PWA do celular.

## Passo 2 — Pegar a configuração do projeto

1. No Firebase, clique na engrenagem (⚙) → "Configurações do
   projeto".
2. Role até "Seus apps" → clique no ícone `</>` (Web) → dê um nome
   qualquer (ex: "gerenciaai") → "Registrar app".
3. Vai aparecer um bloco `firebaseConfig` com `apiKey`, `authDomain`,
   `projectId`, etc. **Copie esse bloco inteiro.**

## Passo 3 — Aplicar as regras de segurança

**Importante**: o bloco abaixo é uma cópia do arquivo `firestore.rules`
deste repositório — a fonte de verdade de verdade é sempre aquele
arquivo (é o que já foi testado e publicado em produção nesta sessão).
Se um dia este documento e o arquivo divergirem, confie no arquivo, não
neste texto, e me avise pra eu corrigir aqui.

**⚠️ Se você chegou aqui vindo de um diagnóstico de "Missing or
insufficient permissions"**: se em algum momento você trocou, direto no
Console (Firestore Database → Regras), a linha `allow get, list: if
request.auth != null;` (dentro de `match
/installations/{installId}/pareamentos/{codigo}`) por `allow get,
list: if true;` só pra testar — **apague tudo que está publicado
agora e cole o bloco completo abaixo de novo, do zero**, depois clique
em "Publicar". Não edite só aquela linha manualmente: é mais seguro
substituir o arquivo inteiro de uma vez, pra garantir que nenhuma outra
edição feita durante os testes fique esquecida lá.

Sem essas regras, o banco fica **totalmente aberto** pra qualquer um na
internet ler ou escrever — a config do Firebase embutida em todo
instalador não é secreta, então isso é um risco real. No Firebase, vá
em **Firestore Database → Regras**, apague o que estiver lá e cole:

```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    // --------------------------------------------------------------
    // PARTE 1 — superfície já existente, comportamento preservado
    // --------------------------------------------------------------

    // O admin-panel (admin-panel/index.html) já pede e-mail/senha pra
    // entrar (Firebase Auth, ver LICENCIAMENTO.md Passo 3) -- mas até
    // agora isso era só uma tela bonita: as regras abaixo liberavam
    // `read, write: if true` pra QUALQUER UM, logado ou não, então o
    // login nunca protegeu o dado de verdade (bastava saber o
    // projectId, que nem é secreto -- ver aviso no topo deste arquivo).
    // Esta função distingue uma sessão REAL do admin-panel (login
    // e-mail/senha) de uma sessão anônima do celular (pareamento/
    // consulta remota/app do garçom) -- as duas batem `request.auth !=
    // null`, mas só a primeira deveria enxergar dado de cobrança/cliente.
    // `sign_in_provider` vem no token de qualquer usuário autenticado e
    // diz COMO ele logou; 'password' é exclusivo de
    // signInWithEmailAndPassword, nunca aparece num login anônimo.
    function ehAdminAutenticado() {
      return request.auth != null && request.auth.token.firebase.sign_in_provider == 'password';
    }

    match /installations/{installId} {
      allow read, write: if true;

      match /backups/{arquivo} {
        allow read, write: if true;
      }
    }

    // O DESKTOP escuta este documento em tempo real, sem autenticação,
    // pra saber se os módulos pagos do cliente vinculado estão ativos
    // (ver modulosPagosService.js) -- por isso a LEITURA continua
    // aberta. Só quem PODE ESCREVER aqui (cadastrar cliente, mudar
    // mensalidade, ativar/desativar módulo) passa a exigir uma sessão
    // de verdade do admin-panel -- antes, qualquer um com o projectId
    // conseguia editar cobrança e módulos pagos de qualquer cliente.
    match /clientes/{clienteId} {
      allow read: if true;
      allow write: if ehAdminAutenticado();

      // Histórico de pagamentos (ver admin-panel "Ver histórico") --
      // usado só pelo admin-panel (o desktop nunca lê nem escreve
      // aqui, só o doc do cliente acima) -- pode ficar restrito dos
      // dois lados.
      match /pagamentos/{pagamentoId} { allow read, write: if ehAdminAutenticado(); }
    }

    // O DESKTOP só CRIA um relatório de erro novo (nunca lê, atualiza
    // ou apaga -- ver errorReportService.js); ler a lista e limpar os
    // antigos é coisa exclusiva do admin-panel (tela "Erros").
    match /erros_reportados/{erroId} {
      allow create: if true;
      allow read, delete: if ehAdminAutenticado();
    }

    // Log de auditoria do PRÓPRIO admin-panel (ações feitas ali) --
    // nunca tocado pelo desktop, então fica restrito dos dois lados.
    match /acoes_log/{logId} { allow read, write: if ehAdminAutenticado(); }

    // config/atualizacao e config/mensagem: o DESKTOP escuta os dois em
    // tempo real sem autenticação (ver updateService.js/messageService.js),
    // então a leitura continua aberta -- só publicar/mudar isso exige
    // sessão do admin-panel agora.
    match /config/{docId} {
      allow read: if true;
      allow write: if ehAdminAutenticado();
    }

    // Chave PÚBLICA do par RSA usado no backup de contas Google (ver
    // backupService.js) -- é pública por natureza (a metade privada
    // fica em cofre_config, cifrada, nunca aqui), então a leitura do
    // DESKTOP continua aberta; só gerar o par (admin-panel) passa a
    // exigir sessão.
    match /config_publica/{docId} {
      allow read: if true;
      allow write: if ehAdminAutenticado();
    }

    // Cada instalação grava aqui sua PRÓPRIA conta Google (e-mail +
    // senha cifrada com RSA -- ver backupService.salvarContaGoogle),
    // sem autenticação, mesmo modelo de confiança de installations/
    // acima -- por isso a ESCRITA continua aberta. LER a lista inteira
    // (e-mails + segredo cifrado de todas as instalações de uma vez)
    // já não tem por que ficar aberto pra qualquer um -- só o
    // admin-panel precisa enxergar isso.
    match /contas_google/{docId} {
      allow read: if ehAdminAutenticado();
      allow write: if true;
    }

    // Cofre de senhas — recurso CONGELADO/obsoleto (ver CLAUDE.md).
    // Regra aqui só preserva o comportamento de hoje; não desenvolver
    // nem mexer nisso além do necessário pra essa preservação.
    match /cofre_acessos/{docId} { allow read, write: if true; }
    match /cofre_config/{docId} { allow read, write: if true; }

    match /grupos_sincronizacao/{grupoId} {
      allow read, write: if true;
      match /produtos/{produtoId} { allow read, write: if true; }
      match /vendas/{vendaId} { allow read, write: if true; }
      match /estoque/{produtoId} { allow read, write: if true; }
    }

    // --------------------------------------------------------------
    // PARTE 1.5 — módulos pagos (Consulta remota, App do garçom)
    // --------------------------------------------------------------
    //
    // Cada CLIENTE (clientes/{clienteId}, ver painel de licenciamento)
    // tem um mapa modulosAtivos: { consultaRemota: bool, appGarcom: bool }.
    // Ausência do campo (cliente antigo, ou instalação sem clienteId
    // vinculado ainda) conta como módulo DESATIVADO -- fail-closed, o
    // padrão nunca dá acesso de graça por omissão.
    //
    // Usado abaixo (PARTE 2) pra bloquear pareamento/uso de um módulo
    // que o cliente não paga -- tanto na hora de criar o vínculo quanto
    // depois, pra cortar o acesso de quem já estava pareado assim que o
    // módulo é desligado no painel (não só impedir pareamento novo).
    //
    // LIMITAÇÃO CONHECIDA (não fechada nesta rodada): a coleção
    // clientes/ continua na PARTE 1 (read/write livre, ver aviso no
    // topo deste arquivo) -- então esta checagem bloqueia o app normal
    // (desktop e celular) de usar um módulo não pago, mas não impede
    // alguém com acesso direto ao Firestore (fora do app) de editar o
    // próprio doc de cliente e ligar o módulo sozinho. Fechar isso de
    // vez exigiria autenticação de verdade no admin-panel (hoje ele
    // também escreve em clientes/ sem login nenhum) -- fora do escopo
    // desta mudança; ver CLAUDE.md.
    function clienteIdDaInstalacao(installId) {
      let ref = /databases/$(database)/documents/installations/$(installId);
      return exists(ref) ? get(ref).data.get('clienteId', null) : null;
    }

    function moduloAtivoParaCliente(clienteId, modulo) {
      let cRef = /databases/$(database)/documents/clientes/$(clienteId);
      return exists(cRef) && get(cRef).data.get('modulosAtivos', {}).get(modulo, false) == true;
    }

    function moduloAtivo(installId, modulo) {
      let clienteId = clienteIdDaInstalacao(installId);
      return clienteId != null && moduloAtivoParaCliente(clienteId, modulo);
    }

    // 'garcom' → módulo "App do garçom"; qualquer outro tipo (só existe
    // 'consulta' hoje) → módulo "Consulta remota".
    function moduloDoTipoDePareamento(tipo) {
      return tipo == 'garcom' ? 'appGarcom' : 'consultaRemota';
    }

    // Dispositivo pareado como "Consulta remota" (nunca "garçom"),
    // ativo, com o módulo ainda pago -- usada pelas coleções de dado
    // sensível de gestão (gestao_usuarios, historico_vendas) que não
    // fazem sentido nenhum pro app do garçom ver (ele nunca teve
    // visibilidade de outros funcionários nem de histórico financeiro,
    // nem no desktop -- ver AppShell.jsx, o menu "Usuários"/"Painel" não
    // aparece pra role 'garcom'). Extraída aqui (em vez de duplicada em
    // cada match) porque as duas coleções abaixo repetem exatamente essa
    // checagem.
    function dispositivoConsultaAtiva(installId) {
      let dRef = /databases/$(database)/documents/installations/$(installId)/dispositivos/$(request.auth.uid);
      return exists(dRef)
        && get(dRef).data.tipo == 'consulta'
        && get(dRef).data.ativo == true
        && moduloAtivo(installId, 'consultaRemota');
    }

    // --------------------------------------------------------------
    // PARTE 2 — pareamento de celular (novo)
    // --------------------------------------------------------------

    // O CELULAR encontra o código via consulta collectionGroup (sem
    // saber o installId de antemão -- ver pwa-mobile/pairing.js). Regra
    // de subcoleção comum (match /installations/{installId}/pareamentos/...
    // logo abaixo) NÃO vale pra esse tipo de consulta -- o Firestore só
    // aplica esse tipo de regra a um `get` de documento específico ou a
    // uma consulta já restrita a UMA loja só. Pra uma consulta
    // collectionGroup (que varre `pareamentos` de TODAS as lojas de uma
    // vez) valer, precisa de um match separado com curinga recursivo
    // `{path=**}`, senão a consulta cai em "Missing or insufficient
    // permissions" mesmo com a regra de baixo em `if true` -- foi
    // exatamente isso que causou a rodada mais longa de diagnóstico
    // desta sessão: a regra de baixo nunca era sequer consultada pra
    // essa operação.
    match /{caminho=**}/pareamentos/{codigo} {
      // Só pode ler depois de ao menos autenticar (anônimo já basta) —
      // fecha a porta de alguém varrer códigos sem nem abrir o app; é
      // uma concessão deliberada à simplicidade pedida ("código de
      // sincronização simples") — o código já expira em 10 minutos e só
      // serve uma vez. Pra fechar essa janela de vez, ativar o Firebase
      // App Check é a recomendação (não depende de mudar esta regra).
      allow get, list: if request.auth != null;
    }

    match /installations/{installId}/pareamentos/{codigo} {
      // O DESKTOP publica o código (mesmo nível de confiança sem
      // autenticação que o resto do app já usa hoje pra escrever em
      // installations/{installId}) -- mas só se o cliente pagar o
      // módulo correspondente (ver PARTE 1.5 acima). O desktop também
      // checa isso ANTES de chamar aqui (ver pairingService.gerarCodigo),
      // então isto é a segunda trava, não a única.
      allow create: if moduloAtivo(installId, moduloDoTipoDePareamento(request.resource.data.tipo));

      // Resgate do código: só pode marcar usado=true, atribuindo a si
      // mesmo, e só se ainda não tiver sido usado nem expirado. Mais
      // nenhum campo pode mudar nesta operação.
      allow update: if request.auth != null
        && resource.data.usado == false
        && resource.data.expiraEm > request.time
        && request.resource.data.usado == true
        && request.resource.data.usadoPorUid == request.auth.uid
        && request.resource.data.diff(resource.data).affectedKeys()
             .hasOnly(['usado', 'usadoPorUid', 'usadoEm']);

      allow delete: if false;
    }

    match /installations/{installId}/dispositivos/{uid} {
      // Ler quem está pareado é aberto (só revela tipo/nome/ativo, sem
      // dado de negócio) — mesmo espírito do resto de installations/.
      allow read: if true;

      // Confere se `codigo` autoriza de fato criar/substituir um
      // dispositivo com esse tipo/vínculo -- mesmo código não pode ter
      // sido usado nem expirado, e tipo/vínculo batem com o que o
      // código promete (fecha o "resgatei um código de garçom mas criei
      // um dispositivo de consulta" e afins). Extraído numa função
      // porque É USADO DUAS VEZES: create (dispositivo novo) e update
      // (re-pareamento reaproveitando um uid que já tinha dispositivo
      // aqui antes, ex: revogado e reemitido um código novo pra mesma
      // pessoa -- Firestore trata isso como "update", não "create",
      // porque o documento já existe).
      function pareamentoAutoriza(tipo, vinculoUserId, codigo) {
        let pRef = /databases/$(database)/documents/installations/$(installId)/pareamentos/$(codigo);
        return exists(pRef)
          && get(pRef).data.usado == false
          && get(pRef).data.expiraEm > request.time
          && get(pRef).data.tipo == tipo
          && get(pRef).data.vinculoUserId == vinculoUserId
          // Módulo pago ainda ativo pro cliente dessa instalação (ver
          // PARTE 1.5) -- confere de novo aqui (não só na criação do
          // código) porque o módulo pode ter sido desligado no painel
          // DEPOIS que o código foi gerado mas ANTES do celular resgatar.
          && moduloAtivo(installId, moduloDoTipoDePareamento(tipo));
      }

      allow create: if request.auth != null && uid == request.auth.uid
        && request.resource.data.tipo in ['garcom', 'consulta']
        && pareamentoAutoriza(request.resource.data.tipo, request.resource.data.vinculoUserId, request.resource.data.pareamentoCodigo);

      // Depois de pareado, o próprio celular só pode tocar no seu
      // "sinal de vida" (nome do aparelho, último acesso) -- OU
      // re-parear de novo com um código novo válido (mesma checagem do
      // create acima, só que aqui o documento já existe). Revogar
      // (campo `ativo`) é feito pelo DESKTOP, sem autenticação -- mesmo
      // nível de confiança de hoje, não uma regressão nova (ver aviso
      // no topo do arquivo sobre a Parte 1).
      allow update: if
        (request.auth != null && uid == request.auth.uid && (
          request.resource.data.diff(resource.data).affectedKeys().hasOnly(['ultimoAcesso', 'nomeDispositivo'])
          || (request.resource.data.tipo in ['garcom', 'consulta']
              && pareamentoAutoriza(request.resource.data.tipo, request.resource.data.vinculoUserId, request.resource.data.pareamentoCodigo))
        ))
        || (request.auth == null
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['ativo']));

      // Excluir de vez o vínculo (diferente de revogar, que só zera
      // `ativo` via update acima e mantém o registro) -- só o DESKTOP,
      // sem autenticação, mesmo nível de confiança do resto da Parte 1
      // e do próprio `allow update` acima pro campo `ativo`. O celular
      // NUNCA exclui o próprio vínculo (nem "esquecer loja" no app faz
      // isso -- ver comentário em pairing.js/consulta.js/garcom.js: some
      // só da lista local do celular, não do servidor).
      allow delete: if request.auth == null;
    }

    // Pedidos lançados pelo PWA do garçom -- ver pedidoGarcomSyncService.js.
    match /installations/{installId}/pedidos_garcom/{pedidoId} {
      // Só um dispositivo pareado como garçom, ATIVO, dessa loja
      // específica, com o módulo "App do garçom" ainda pago (ver PARTE
      // 1.5 -- corta o acesso na hora se o cliente parar de pagar, não
      // só impede pareamento novo), pode criar pedido, e sempre como
      // 'novo'.
      allow create: if request.auth != null
        && request.resource.data.garcomUid == request.auth.uid
        && get(/databases/$(database)/documents/installations/$(installId)/dispositivos/$(request.auth.uid)).data.tipo == 'garcom'
        && get(/databases/$(database)/documents/installations/$(installId)/dispositivos/$(request.auth.uid)).data.ativo == true
        && moduloAtivo(installId, 'appGarcom')
        && request.resource.data.status == 'novo';

      // O garçom só vê os PRÓPRIOS pedidos (pra acompanhar status).
      allow read: if request.auth != null && resource.data.garcomUid == request.auth.uid;

      // Só o desktop (sem autenticação, mesmo nível de confiança de
      // hoje) atualiza status/erro depois de processar.
      allow update: if request.auth == null
        && request.resource.data.diff(resource.data).affectedKeys()
             .hasOnly(['status', 'erro', 'processadoEm', 'bot_order_id', 'saleId']);

      allow delete: if false;
    }

    // Retrato "ao vivo" da loja (resumo do dia + mesas/pedidos em
    // andamento + catálogo de produtos pro garçom montar pedido) -- ver
    // liveStatusSyncService.js. Ao contrário do resto, este dado É
    // sensível de verdade (números reais de venda), então a leitura é
    // restrita a quem está pareado e ativo com ESTA loja (garçom ou
    // consulta -- o garçom precisa do catalogoProdutos daqui mesmo pra
    // montar o pedido; não vale a pena separar num documento à parte só
    // pra diferenciar os dois tipos).
    match /installations/{installId}/status_ao_vivo/{docId} {
      // Extraído numa função (em vez de inline) porque precisa ler o
      // `tipo` do dispositivo pra saber QUAL módulo checar (garçom usa
      // "appGarcom", consulta usa "consultaRemota") -- sem essa
      // checagem de módulo, desligar o módulo de um cliente no painel
      // não cortava o acesso de quem já estava pareado, só impedia
      // pareamento novo.
      function dispositivoPareadoEModuloAtivo(installId) {
        let dRef = /databases/$(database)/documents/installations/$(installId)/dispositivos/$(request.auth.uid);
        return exists(dRef)
          && get(dRef).data.ativo == true
          && moduloAtivo(installId, moduloDoTipoDePareamento(get(dRef).data.tipo));
      }

      allow read: if request.auth != null && dispositivoPareadoEModuloAtivo(installId);

      allow write: if request.auth == null; // só o desktop publica
    }

    // Lista de funcionários (nome/papel/status) -- ver
    // userStatusSyncService.js. DELIBERADAMENTE um documento separado de
    // status_ao_vivo (não um campo a mais lá): a regra de status_ao_vivo
    // acima autoriza QUALQUER dispositivo pareado e ativo, garçom OU
    // consulta, porque o garçom precisa do catalogoProdutos de lá. A
    // lista de funcionários é diferente -- não deveria vazar pra um
    // celular pareado como garçom (hoje esse papel não enxerga nada
    // sobre outros usuários, nem no desktop: o menu "Usuários" nem
    // aparece pra role 'garcom', ver AppShell.jsx) -- por isso a checagem
    // aqui exige explicitamente tipo == 'consulta', não só "pareado e
    // ativo" como a de cima.
    match /installations/{installId}/gestao_usuarios/{docId} {
      allow read: if request.auth != null && dispositivoConsultaAtiva(installId);

      allow write: if request.auth == null; // só o desktop publica
    }

    // Histórico de vendas (últimos 7/30 dias: faturamento por dia,
    // produtos mais vendidos, vendas por operador) -- ver
    // historySyncService.js. Mesma restrição de gestao_usuarios (só
    // "Consulta remota", nunca garçom) e pelo MESMO motivo de
    // status_ao_vivo já ser tratado como sensível: aqui é histórico
    // financeiro de verdade, ainda mais dado pra vazar sem necessidade
    // pro app do garçom do que o resumo "hoje" que ele nem usa.
    match /installations/{installId}/historico_vendas/{docId} {
      allow read: if request.auth != null && dispositivoConsultaAtiva(installId);

      allow write: if request.auth == null; // só o desktop publica
    }

    // Lista pessoal de lojas às quais um celular de CONSULTA está
    // vinculado (dono de rede com mais de uma loja) -- só o próprio
    // celular mexe nisso, nunca o desktop de nenhuma loja.
    match /dispositivos_pareados/{uid} {
      allow read, write: if request.auth != null && uid == request.auth.uid;
    }
  }
}
```

Clique em "Publicar".

**Como este arquivo é estruturado** (pra entender o que você está
colando):

- **PARTE 1** preserva de propósito o comportamento ABERTO que o
  sistema sempre teve pra tudo que já existia antes do pareamento de
  celular (`installations` e seus `backups`, o Cofre de senhas —
  congelado/obsoleto, não mexer além do necessário pra preservar o
  comportamento — e `grupos_sincronizacao`, incluindo suas
  subcoleções). Essas continuam `read, write: if true` porque é o
  próprio DESKTOP (sem nenhuma autenticação) quem escreve nelas —
  restringir exigiria dar ao desktop uma identidade autenticada
  própria, fora do escopo desta rodada. Migrar essas pra uma regra de
  verdade fica pra depois, com calma.
  Dentro da própria Parte 1, as coleções que só o **admin-panel**
  usa (`clientes` e o histórico de `pagamentos` dentro dele,
  `erros_reportados`, `acoes_log`, `config`, `config_publica`,
  `contas_google`) já foram migradas: passam a exigir a função
  `ehAdminAutenticado()` pra ESCREVER (e pra `erros_reportados`,
  `acoes_log` e `contas_google`, também pra LER) — o login e-mail/senha
  do admin-panel (Passo 3 abaixo) já existia, mas até esta mudança as
  regras não conferiam ele pra nada; qualquer um que soubesse o
  projectId conseguia ler/editar cobrança de cliente direto pelo
  Firestore, sem passar pela tela de login nenhuma vez. Onde o próprio
  DESKTOP também precisa ler o dado (o doc de `clientes/{clienteId}`
  pra saber se um módulo pago está ativo, ou `config/atualizacao` e
  `config/mensagem` pra checar atualização obrigatória/mensagem
  global), a LEITURA continua aberta — só a ESCRITA (exclusiva do
  admin-panel nesses casos) ficou restrita.
- **PARTE 1.5** são as funções auxiliares dos módulos pagos (Consulta
  remota / App do garçom) — confere se o cliente da instalação tem o
  módulo ligado em `clientes/{clienteId}.modulosAtivos`, usado pela
  PARTE 2 abaixo. Cliente sem `clienteId` vinculado ainda, ou sem o
  campo `modulosAtivos`, conta como módulo desativado (fail-closed).
- **PARTE 2** é regra de verdade (não read/write livre) pro que é
  novo: pareamento de celular (`pareamentos`, `dispositivos`), pedidos
  do app do garçom (`pedidos_garcom`), o retrato "ao vivo" da loja pro
  celular consultar (`status_ao_vivo`), e a lista pessoal de lojas de
  um celular de consulta (`dispositivos_pareados`) — aqui quem escreve
  pode ser o CELULAR de um funcionário, autenticado anonimamente (ver
  Passo 1 — o provedor "Anônimo" precisa estar ativado em
  Authentication → Sign-in method, senão o celular nem consegue
  autenticar pra chegar até essas regras), não só as máquinas da
  própria loja. Repare que existem **dois** blocos `match` separados
  pra `pareamentos`: um com curinga recursivo (`match
  /{caminho=**}/pareamentos/{codigo}`, só com `get`/`list`) e outro
  específico (`match /installations/{installId}/pareamentos/{codigo}`,
  com `create`/`update`/`delete`). Não é duplicação por engano — o
  Firestore exige o formato com curinga recursivo especificamente pra
  autorizar consultas **collectionGroup** (a busca do celular, que
  varre `pareamentos` de todas as lojas de uma vez); a regra de
  subcoleção comum não vale pra esse tipo de consulta, só pra
  `get`/consulta já restrita a uma loja só. Também tem `gestao_usuarios`
  (lista de funcionários) e `historico_vendas` (últimos 7/30 dias) —
  as duas usam a função `dispositivoConsultaAtiva`, exigindo
  explicitamente tipo `'consulta'`, porque esse dado (quem trabalha na
  loja, histórico financeiro) não deveria vazar pro app do garçom, ao
  contrário de `status_ao_vivo` (que os dois tipos podem ler, já que o
  garçom precisa do catálogo de produtos de lá).

**⚠️ Se você já tinha publicado uma versão anterior destas regras**
(antes do Cofre de senhas, do histórico de pagamentos por cliente, dos
módulos pagos, ou do pareamento de celular/app do garçom/consulta
remota existirem): republique com o bloco atual. Sem isso:

- Faltam as coleções `pareamentos`, `dispositivos`, `pedidos_garcom`,
  `status_ao_vivo` e `dispositivos_pareados` → parear um celular falha
  com "Permissão insuficiente" (`Missing or insufficient permissions`)
  mesmo com o app funcionando normal.
- Falta a subcoleção `clientes/{clienteId}/pagamentos` → o botão "Ver
  histórico" de pagamentos no admin-panel falha ao carregar.
- Faltam as funções de módulo pago (`moduloAtivo` e companhia) →
  mesmo com as coleções acima presentes, gerar ou resgatar um
  pareamento é recusado incondicionalmente (a checagem de módulo nunca
  encontra a função pra chamar).
- Falta o bloco `match /installations/{installId}/gestao_usuarios/{docId}`
  → a seção "Usuários" da consulta remota (lista de funcionários) fica
  sempre vazia no celular, sem erro nenhum visível (a leitura é
  simplesmente negada e o app trata isso como "zero usuários", não como
  falha) — se a lista sempre aparecer vazia mesmo com funcionários
  cadastrados, confira essa regra primeiro.
- Falta o bloco `match /installations/{installId}/historico_vendas/{docId}`
  → a seção "Histórico" da consulta remota (vendas dos últimos 7/30
  dias) fica sempre zerada no celular ("R$ 0,00", "0 vendas"), do mesmo
  jeito silencioso do item acima — a leitura é negada e o app trata
  como "sem dados no período", não como falha. Se o histórico nunca sai
  do zero mesmo com vendas registradas no período, confira essa regra
  antes de suspeitar do `historySyncService`.
- A regra de `installations/{installId}/dispositivos/{uid}` ainda tem
  `allow delete: if false;` (versão antiga, de antes do botão "Excluir"
  existir em Configurações → Celular) → excluir um dispositivo some da
  lista no desktop na hora (o registro local já foi apagado), mas o
  vínculo continua existindo no Firestore pra sempre, e o celular
  continua com acesso normal. Se um dispositivo "excluído" reaparecer
  sozinho na lista (a escuta em tempo real volta a espelhar o
  documento que nunca foi removido de verdade) ou continuar
  funcionando no celular depois de excluído, republique com o bloco
  atual (`allow delete: if request.auth == null;`).
- `clientes`, `erros_reportados`, `acoes_log`, `config`, `config_publica`
  e `contas_google` ainda estão com `allow read, write: if true;` puro
  (versão de antes da função `ehAdminAutenticado()`) → o admin-panel
  continua funcionando NORMALMENTE mesmo assim (o login e-mail/senha
  segue pedindo e aceitando certo), então não tem nenhum sintoma óbvio
  na tela -- o problema é silencioso: qualquer um que souber o
  projectId (não é secreto) continua conseguindo ler/editar clientes,
  cobrança, log de auditoria e contas Google direto pelo Firestore,
  sem passar pelo login nenhuma vez. Se você quer ter certeza de que
  essa regra está valendo, o Simulador do Firebase (aba "Regras") deixa
  simular uma leitura de `clientes/algum-id` SEM autenticação e
  conferir que agora nega.
- Falta o bloco `match /{caminho=**}/pareamentos/{codigo}` (regra com
  curinga recursivo, separada da regra normal de `installations/
  {installId}/pareamentos/{codigo}`) → o celular encontra o código
  digitado através de uma consulta **collectionGroup**, que só é
  autorizada por esse bloco específico. Sem ele, o pareamento falha
  com "Permissão insuficiente" **mesmo que a regra de subcoleção
  esteja perfeita (até um `if true` sem condição nenhuma não resolve)**
  — foi essa lacuna, não percebida por horas de diagnóstico nesta
  sessão, que causou o erro mais difícil de rastrear desta rodada. O
  Simulador do Firebase não ajuda a pegar isso porque ele só testa
  `get`/`create`/`update`/`delete` num caminho específico, nunca uma
  consulta `list`/collectionGroup de verdade.

**Antes de confiar nisso em produção**: teste pelo simulador de regras
do próprio Firebase (aba "Regras" → "Simulador") — por exemplo, simule
uma escrita não-autenticada tentando mudar `modulosAtivos` de um
cliente pra `true` sem passar pelo painel, ou um `get` num pareamento
sem autenticação nenhuma; os dois devem ser negados. Só não dá pra
confirmar a consulta collectionGroup por lá (ver acima) — pra essa
parte, o teste de verdade é abrir o PWA num celular e tentar parear.
**Não esqueça também do Passo 3.5 logo abaixo** — sem o índice
configurado lá, o pareamento falha do mesmo jeito ("Permissão
insuficiente") mesmo com as regras 100% corretas e publicadas.

## Passo 3.5 — Publicar o índice do Firestore (obrigatório pro pareamento funcionar)

O celular encontra o código de pareamento digitado através de uma
consulta **collectionGroup** — `pareamentos` de QUALQUER loja, já que
o celular ainda não sabe o `installId` antes de digitar o código —
filtrando pelo campo `codigo` (ver `pwa-mobile/pairing.js`). A
indexação automática do Firestore só cobre consultas no escopo de uma
única COLEÇÃO; pra esse mesmo campo funcionar também no escopo
COLLECTION_GROUP (entre lojas), precisa configurar manualmente. Sem
isso, a consulta falha — às vezes com o aviso claro "the query requires
an index", às vezes (se o campo nunca foi tocado antes) com o mesmo
"Missing or insufficient permissions" que parece erro de regra de
segurança, mas não é.

**Pelo Console** (Firestore Database → aba **Índices** → sub-aba
**Único campo**):

1. Clique em algo como "Adicionar isenção de índice" / "Add exemption"
   (o texto exato varia com o idioma da conta).
2. ID da coleção: `pareamentos`. Campo: `codigo`.
3. Ative a ordem "Crescente" tanto pro escopo **Coleção** quanto pro
   escopo **Grupo de coleções** — os dois, não só um (é fácil marcar só
   um por engano).
4. Salvar. Leva de 1 a poucos minutos pra terminar de compilar (a tela
   mostra "Compilando..." até ficar pronto).

**Pela CLI**, se preferir: o arquivo `firestore.indexes.json` deste
repositório já vem com essa configuração pronta, no formato certo
(`fieldOverrides`, **não** uma entrada em `indexes[]` — uma composta
pra isso é REJEITADA pelo próprio Firebase com "this index is not
necessary, configure using single field index controls"):

```json
{
  "indexes": [],
  "fieldOverrides": [
    {
      "collectionGroup": "pareamentos",
      "fieldPath": "codigo",
      "indexes": [
        { "order": "ASCENDING", "queryScope": "COLLECTION" },
        { "order": "ASCENDING", "queryScope": "COLLECTION_GROUP" }
      ]
    }
  ]
}
```

`firebase deploy --only firestore:indexes` publica esse arquivo direto.

**Como eu confirmei isso**: descobri esse detalhe testando de verdade
nesta sessão, não por documentação — a consulta collectionGroup só
passou a funcionar depois desse índice existir; antes disso, mesmo com
a regra de segurança certinha, já publicada e confirmada ("released
rules... to cloud.firestore" no terminal), o celular continuava
recebendo "Missing or insufficient permissions" ao digitar o código.

## Passo 3.6 — Regras do Storage (backup na nuvem)

O `storageBucket` já vem preenchido no `firebaseConfig` desde o
início, mas até agora nada usava o Storage de verdade — por isso ele
provavelmente nunca teve regra nenhuma publicada (o padrão do Firebase
em modo produção é **negar tudo** até você publicar algo). Isso mudou:
cada instalação agora sobe uma cópia do próprio backup local pra lá
(pra você conseguir restaurar remotamente pela Central se a máquina de
um cliente sumir de vez — HD morto, furto, etc.), e a aba **🗄
Backups** do painel usa isso.

No Firebase, vá em **Storage** (se ainda não tiver entrado nessa seção
nenhuma vez, clique em "Vamos começar" primeiro — mesma região do
Firestore) → aba **Regras**, apague o que estiver lá e cole:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /backups/{installId}/{arquivo} {
      // Mesmo modelo de confiança do Firestore acima: a própria
      // instalação sobe e baixa o próprio backup, sem se autenticar —
      // o installId (um UUID aleatório, gerado localmente, nunca
      // exposto em lugar nenhum público) faz esse papel. A Central em
      // si NUNCA acessa o Storage diretamente pra restaurar; ela só
      // grava o PEDIDO no Firestore (`restaurarBackupSolicitado`), e é
      // a própria instalação que baixa o arquivo sozinha ao perceber
      // o pedido.
      allow read: if true;
      allow write: if request.resource.size < 200 * 1024 * 1024; // limite generoso, 200MB por backup
      allow delete: if true; // rotação automática -- mantém só os 10 backups mais recentes por instalação
    }
  }
}
```

Clique em "Publicar".

**⚠️ Sobre privacidade**: como o backup é o banco INTEIRO (clientes,
telefones, vendas — o dado mais sensível que existe no sistema), vale
entender o trade-off aqui: `allow read: if true` significa que
QUALQUER UM que descubra o `installId` exato de uma instalação (e o
nome do arquivo) consegue baixar aquele backup, sem precisar de login
nenhum. Na prática isso é bem difícil — o `installId` é um UUID
aleatório de 128 bits, nunca publicado em lugar nenhum acessível
(nem a Central expõe isso fora do login autenticado) — mas é segurança
por obscuridade, não uma trava de verdade, e é o mesmo modelo que o
resto do sistema já usa (mensagem personalizada, grupo de
sincronização, etc.). Não tem como fazer melhor sem montar um backend
próprio com Cloud Functions pra gerar link assinado — fora do escopo
de "sem servidor" desse projeto por enquanto. Se um dia isso incomodar,
é a primeira coisa que eu mudaria com mais tempo de infraestrutura.

**Teste rápido depois de publicar**: peça um backup pela aba 🗄
Backups da Central numa instalação de teste — se dentro de alguns
segundos (com a instalação online) aparecer um arquivo novo na lista,
as regras estão certas. Se continuar vazio, confira o console (F12 →
aba Console) da própria instalação: um erro `storage/unauthorized`
significa que essa regra ainda não foi publicada certinho.

## Passo 4 — Preencher a configuração no app

Abra `electron/services/licenseService.js` e substitua o bloco
`LICENSE_FIREBASE_CONFIG` pelos valores que você copiou no Passo 2:

```js
const LICENSE_FIREBASE_CONFIG = {
  apiKey: 'AIzaSy...',
  authDomain: 'gerenciaai-licencas.firebaseapp.com',
  projectId: 'gerenciaai-licencas',
  storageBucket: 'gerenciaai-licencas.appspot.com',
  messagingSenderId: '123456789',
  appId: '1:123456789:web:abcdef',
};
```

Depois disso, publique uma versão nova (`npm version patch`) pra essa
config ir pros instaladores.

## Passo 5 — Preencher a configuração no painel

Abra `admin-panel/index.html`, ache o mesmo bloco `firebaseConfig`
(perto do topo do `<script>`) e cole os mesmos valores.

## Passo 6 — Publicar o painel

Duas opções:

**A. Rodar localmente (mais simples pra começar)** — é só abrir o
arquivo `admin-panel/index.html` direto no navegador (duplo clique).
Funciona porque o Firebase é consultado direto do navegador, não
precisa de servidor nenhum rodando.

**B. Hospedar de verdade (pra acessar de qualquer lugar, não só do seu
PC)** — usa o Firebase Hosting, que já vem junto do mesmo projeto:

```powershell
npm install -g firebase-tools
firebase login
cd admin-panel
firebase init hosting
# escolha o projeto que você criou, pasta pública = "." (a atual), sem SPA
firebase deploy
```

Isso te dá uma URL tipo `https://gerenciaai-licencas.web.app` — acesse
de qualquer navegador, faz login com o e-mail/senha do Passo 1.

## Passo 7 (opcional) — Backup extra por cliente, numa nuvem pessoal (Google Drive, OneDrive...)

Além do backup automático que já sobe pro Storage do projeto de
licenciamento (Passo 3.6), dá pra ter uma **segunda cópia fora da
máquina**, numa conta de nuvem pessoal — sem precisar escrever
código nenhum, reaproveitando o campo "pasta secundária" que o app já
tem em Configurações → Backups.

A ideia: durante a implantação naquele cliente, crie uma conta Google
**dedicada só a isso** (não a conta pessoal do dono do negócio — assim
os 15GB grátis do Google Drive ficam só pra backup, sem disputar
espaço com e-mail ou fotos de ninguém). Funciona igual com uma conta
Microsoft/OneDrive, se preferir.

**Passo a passo na implantação:**

1. Crie a conta Google nova (ex: `backup.nomedocliente@gmail.com`).
2. Instale o **Google Drive para Desktop**
   ([drive.google.com/drive/download](https://www.google.com/drive/download/))
   na máquina do cliente e faça login com essa conta.
3. Configure pra sincronizar (ou crie) uma pasta local, ex:
   `G:\Meu Drive\Backups PDV` (o Drive Desktop mapeia como uma unidade
   ou pasta comum, dependendo da versão).
4. Dentro do GerenciaAI, vá em **Configurações → Backups** e cole esse
   caminho no campo "Pasta secundária".
5. Ainda na mesma tela, na seção "Conta Google deste cliente", cole o
   e-mail e a senha dessa mesma conta que você acabou de criar (não
   precisa clicar em "Abrir cadastro do Google" de novo, já que a
   conta já existe) — assim ela fica registrada e protegida na Central
   também, não só na sua memória.

Pronto — a partir daí, todo backup que o app já faz sozinho (diário,
ou quando você pede pela Central) grava também nessa pasta, e o
próprio Google Drive sobe pra nuvem em segundo plano, sem precisar de
nada meu rodando. Mesmo que o computador do cliente pare de
funcionar de vez, o arquivo já sincronizado continua acessível em
[drive.google.com](https://drive.google.com) de qualquer lugar, só
com o login daquela conta.

**Diferença importante em relação ao backup do Firebase**: o botão
"Restaurar" da aba 🗄 Backups da Central só sabe puxar do Storage do
Firebase — ele não enxerga o Google Drive. Restaurar a partir do Drive
nesse modelo é manual: baixe o arquivo pelo site/app do Drive e copie
pra máquina (ou instale o Drive Desktop na máquina nova, logado na
mesma conta, e ele sincroniza de volta sozinho). Pense nisso como uma
segunda rede de proteção, não como substituto do fluxo de restauração
remota automática.

## Testando

1. Rode o app localmente uma vez (`npm run dev:electron`) — isso cria
   o documento da instalação no Firestore automaticamente (sempre
   começa ativa).
2. Abra o painel, faça login — a instalação deve aparecer na lista.
3. Clique em "Congelar" — dentro de até 6h (o intervalo de checagem do
   app) ou reabrindo o app manualmente, deve aparecer o aviso de
   pendência.
4. Clique em "Reativar" — o aviso deve sumir na próxima checagem.

## O que eu não consegui testar por aqui

Não tenho acesso a um projeto Firebase de verdade neste ambiente —
tudo que escrevi (lógica de carência, regras de segurança, o painel)
foi testado isoladamente (simulações e casos de borda), mas a
integração real com o Firebase só você vai poder confirmar,
seguindo os passos acima. Recomendo testar com uma instalação de
teste antes de confiar nisso pra congelar cliente de verdade.
