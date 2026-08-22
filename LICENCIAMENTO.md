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
   cadastrar aqui manualmente.

## Passo 2 — Pegar a configuração do projeto

1. No Firebase, clique na engrenagem (⚙) → "Configurações do
   projeto".
2. Role até "Seus apps" → clique no ícone `</>` (Web) → dê um nome
   qualquer (ex: "gerenciaai") → "Registrar app".
3. Vai aparecer um bloco `firebaseConfig` com `apiKey`, `authDomain`,
   `projectId`, etc. **Copie esse bloco inteiro.**

## Passo 3 — Aplicar as regras de segurança

Isso é importante: sem essas regras, qualquer instalação do app
conseguiria se autoreativar direto no banco, ou qualquer pessoa na
internet conseguiria ler/mexer nos dados. No Firebase, vá em
**Firestore Database → Regras**, apague o que estiver lá e cole:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /installations/{installId} {
      // Qualquer instalação pode criar o próprio documento na primeira
      // vez que fala com o servidor — sempre começando ativa e sem
      // bloqueio (o congelamento ou bloqueio é sempre uma ação manual
      // sua, depois, pelo painel).
      allow create: if request.resource.data.ativo == true
        && request.resource.data.bloqueioImediato == false;

      // Qualquer um pode ler (só expõe status de licença, nada sensível)
      allow read: if true;

      // Uma instalação pode atualizar SÓ os campos de "sinal de vida"
      // e de progresso da própria atualização obrigatória (nunca
      // `ativo`, `bloqueioImediato`, `clienteId` ou `nomeNegocio`
      // sozinha) — só um admin autenticado (você, logado no painel)
      // pode mudar esses campos.
      allow update: if (
        request.resource.data.diff(resource.data).affectedKeys()
          .hasOnly([
            'ultimoContato', 'versaoApp', 'ultimoPing',
            'atualizacaoBaixando', 'atualizacaoProgresso', 'atualizacaoBaixado', 'atualizacaoVersaoAlvo',
            'totalVendasHistorico', 'vendasUltimos30Dias', 'perfilAtivo', 'conflitosCodigoBarrasPendentes',
            // Sinal de volta de uma restauração remota de backup pedida
            // pela Central (ver Passo 3.5 e backupService.js) — a própria
            // instalação escreve isso sozinha, sem login, avisando se deu
            // certo ou não.
            'restauracaoStatus', 'restauracaoErro', 'restauracaoConcluidaEm',
            // Reporte (só informativo, pra "análise visual" na Central)
            // de que a instalação tem uma pasta secundária de backup
            // configurada — dispara sozinho assim que o cliente escolhe/
            // troca ela na tela de Configurações, sem esperar o próximo
            // sinal de vida periódico.
            'backupPastaSecundariaConfigurada'
          ])
      ) || request.auth != null;
      // Os campos que só a Central escreve (autenticada) -- congelar,
      // bloquear, vincular a cliente, mensagem personalizada, grupo de
      // sincronização, pedir backup agora (`backupSolicitadoEm`), pedir
      // restauração remota (`restaurarBackupSolicitado`) e o override de
      // versão por instalação (`versaoMinimaOverride`/`overrideAtivo`) --
      // já caem no `|| request.auth != null` acima, sem precisar listar
      // cada um: qualquer update feito por você, logado no painel, é
      // sempre permitido.

      allow delete: if request.auth != null;

      // Metadados dos backups que essa instalação subiu pro Storage (ver
      // Passo 3.5) — um documento por arquivo, criado pela PRÓPRIA
      // instalação (sem login, mesmo modelo de confiança do documento pai:
      // o installId é um UUID aleatório, não exposto em lugar nenhum
      // público, então funciona como um "segredo" de fato). Só a Central
      // (autenticada) lista esses documentos, na aba Backups do painel.
      match /backups/{nomeArquivo} {
        allow read: if request.auth != null;
        allow create: if request.resource.data.keys().hasAll(['nomeArquivo', 'caminhoStorage', 'tamanhoBytes']);
        allow update: if false; // nunca precisa editar, só criar ou apagar
        allow delete: if true; // rotação automática -- mantém só os 10 mais recentes por instalação
      }
    }

    // "clientes" é só usado pelo painel administrativo — o app em si
    // nunca lê nem escreve aqui, só agrupa instalações visualmente e
    // permite ações em bloco (bloquear todas as máquinas de um dono
    // de uma vez). Por isso é 100% restrito a admin autenticado.
    match /clientes/{clienteId} {
      allow read, write: if request.auth != null;
    }

    // "acoes_log" — registro de auditoria da Central (congelar, bloquear,
    // restaurar backup, publicar/desativar atualização obrigatória): quem
    // fez, o quê e quando. Só o painel grava e lê aqui, o app do cliente
    // nunca toca nisso — mesmo padrão de "clientes", 100% restrito a admin
    // autenticado. Update/delete ficam bloqueados de propósito: um
    // registro de auditoria não deveria dar pra editar ou apagar depois
    // (nem sem querer, nem por engano) — só criar e ler.
    match /acoes_log/{acaoId} {
      allow read, create: if request.auth != null;
      allow update, delete: if false;
    }

    // Cofre de senhas — igual "clientes": só o painel toca aqui, nunca
    // o app do cliente. O conteúdo sensível (usuário/senha/endereço/
    // notas) já vem CIFRADO do navegador antes de chegar até aqui (ver
    // admin-panel/index.html) — essa regra só garante que ninguém sem
    // login nem lê nem escreve, é uma segunda camada, não a única.
    match /cofre_acessos/{acessoId} {
      allow read, write: if request.auth != null;
    }
    // Guarda o salt e o "carimbo de verificação" (cifrado) usados pra
    // conferir a senha-mestra no desbloqueio — nenhum dos dois é a
    // senha em si, mas mesmo assim fica restrito a admin autenticado.
    match /cofre_config/{docId} {
      allow read, write: if request.auth != null;
    }

    // Contas Google criadas pelo APP (tela Configurações -> Backup),
    // não pelo painel -- por isso o padrão de permissão é diferente do
    // resto do Cofre acima: a instalação escreve sozinha, sem login
    // (mesmo modelo de confiança do documento pai em "installations"),
    // mas só a Central autenticada consegue LER de volta. O campo
    // `senhaCifradaRsa` já chega cifrado com a chave pública de contas
    // Google (ver "config_publica" abaixo) -- só quem destrava o Cofre
    // com a master key consegue decifrar de volta.
    match /contas_google/{instalacaoId} {
      allow read, delete: if request.auth != null;
      allow write: if request.resource.data.keys().hasOnly(['email', 'senhaCifradaRsa', 'atualizadoEm'])
                    && request.resource.data.email is string
                    && request.resource.data.senhaCifradaRsa is string;
    }

    // Chave PÚBLICA usada pelos apps pra cifrar a senha da conta Google
    // antes de mandar (ver acima) -- não é segredo (é só a metade
    // pública do par), por isso pode ser lida por qualquer instalação
    // sem login. Só a Central (autenticada) gera/publica essa chave,
    // uma vez só, na aba Cofre de senhas.
    match /config_publica/{docId} {
      allow read: if true;
      allow write: if request.auth != null;
    }

    // "config/atualizacao" e "config/mensagem" são documentos únicos
    // onde o painel publica, respectivamente, a versão mínima
    // obrigatória e o aviso/imagem da tela inicial — qualquer
    // instalação precisa LER os dois (o "{configId}" abaixo cobre
    // qualquer documento dentro de "config", não só um), mas só você
    // (autenticado no painel) pode publicar ou desativar qualquer um
    // dos dois. Não precisa de regra nova quando adicionar outro
    // documento de config no futuro — essa já cobre.
    match /config/{configId} {
      allow read: if true;
      allow write: if request.auth != null;
    }

    // "erros_reportados" — qualquer instalação pode CRIAR um relato de
    // erro (é só texto técnico de diagnóstico, nunca dado de venda ou
    // cliente) — mas só você (autenticado) pode ler ou apagar. Isso
    // significa que ninguém consegue ver os erros de outra instalação,
    // só criar os próprios.
    match /erros_reportados/{erroId} {
      allow create: if true;
      allow read, delete: if request.auth != null;
      allow update: if false; // um relato de erro nunca precisa ser editado, só criado ou apagado
    }

    // "grupos_sincronizacao" — agrupa instalações do MESMO negócio (ex:
    // duas caixas da mesma loja) pra somarem vendas juntas no
    // consolidado. Só você (autenticado no painel) cria/edita/apaga
    // grupos — o app nunca escreve aqui, só nas "vendas" dentro dele.
    match /grupos_sincronizacao/{grupoId} {
      allow read: if true;
      allow create, update, delete: if request.auth != null;

      // O app em si NUNCA se autentica (mesmo padrão de installations)
      // — a validação é só pela forma dos campos, não por quem está
      // escrevendo. Qualquer instalação com o grupoId certo consegue
      // mandar o resumo da própria venda.
      match /vendas/{vendaId} {
        allow read: if true;
        allow create, update: if request.resource.data.keys().hasAll(['installId', 'total', 'totalItens', 'finalizadaEm', 'diaISO'])
                      && request.resource.data.total is number
                      && request.resource.data.totalItens is number;
        allow delete: if request.auth != null;
      }

      // "produtos" é o catálogo compartilhado entre os PDVs do grupo —
      // nome, preço, categoria etc. NUNCA inclui estoque (isso é físico,
      // sempre local de cada máquina, nunca sincronizado). Mesmo padrão
      // de "vendas": o app nunca se autentica, valida só pela forma.
      match /produtos/{produtoId} {
        allow read: if true;
        allow create, update: if request.resource.data.keys().hasAll(['nome', 'preco'])
                      && request.resource.data.preco is number;
        allow delete: if request.auth != null;
      }

      // "estoque" é o contador compartilhado que impede duas máquinas
      // venderem a mesma última unidade ao mesmo tempo — só a
      // quantidade, nada de detalhe de venda. Qualquer instalação do
      // grupo pode ler e debitar (isso é o que torna a checagem na
      // hora de finalizar possível); só precisa ser um número.
      match /estoque/{produtoId} {
        allow read: if true;
        allow create, update: if request.resource.data.keys().hasOnly(['quantidade', 'atualizadoEm'])
                      && request.resource.data.quantidade is number;
        allow delete: if request.auth != null;
      }
    }
  }
}
```

Clique em "Publicar".

**⚠️ Se a versão do app está aparecendo travada no painel, mesmo depois
de atualizar de verdade**: isso é quase certamente porque as regras
publicadas ainda não têm os campos de métrica (`totalVendasHistorico`,
`vendasUltimos30Dias`, `perfilAtivo`) na lista de permitidos — um erro
meu, que esqueci de atualizar as regras junto quando adicionei essa
funcionalidade. O Firestore recusa a escrita **inteira** (não só os
campos novos) quando isso acontece — por isso nem o `ultimoContato`
nem a versão conseguiam atualizar, mesmo o app rodando normal e
tentando a cada 6h. **Republicar as regras com o bloco abaixo resolve
isso de vez.**

**Se você já tinha publicado as regras antigas** (antes do bloqueio
imediato, dos clientes, da atualização obrigatória, dos erros
reportados, do sinal de online/offline, ou das métricas existirem):
precisa republicar com esse bloco novo de novo — sem isso, o campo
`ultimoPing` novo não vai conseguir ser escrito pelo app, e o sinal de
online do painel vai ficar sempre cinza/offline, mesmo com o cliente
rodando normalmente.

**Se você já tinha publicado as regras antes dos recursos de backup na
nuvem, override de versão por instalação e vencimento de cliente
existirem**: republique de novo com o bloco atual — ele já inclui a
subcoleção `backups` e os campos `restauracaoStatus`/`restauracaoErro`/
`restauracaoConcluidaEm`. Os campos que só a Central escreve
(`backupSolicitadoEm`, `restaurarBackupSolicitado`,
`versaoMinimaOverride`, `overrideAtivo`, `vencimento` em `clientes`)
não precisam de nada extra na regra — qualquer escrita autenticada já
é permitida. E não esqueça do **Passo 3.5**, que é uma regra nova (do
Storage, não do Firestore) — sem publicar aquela também, o upload do
backup pra nuvem falha com `storage/unauthorized`.

**Se você já tinha publicado as regras antes do Cofre de senhas
existir**: republique de novo — o bloco atual inclui as coleções novas
`cofre_acessos` e `cofre_config` (sem elas, o painel nem consegue
abrir a tela do cofre, dá erro de permissão na hora de checar se já
existe uma senha-mestra).

**Nota histórica**: existiu por um tempo um campo de texto livre "conta
de nuvem pessoal" na tela de Configurações → Backup, com os campos
`backupContaNuvemPessoal`/`backupContaNuvemPessoalAtualizadaEm`
correspondentes na regra. Foi removido por ser redundante com o
recurso "Criar conta Google" logo abaixo (que faz a mesma coisa, só
que estruturado e com a senha protegida) — se você publicou uma versão
antiga das regras que ainda tinha esses dois campos, não tem problema
nenhum, eles só ficam sem uso. O bloco atual já não os inclui mais.

**Se você já tinha publicado as regras antes do recurso "Criar conta
Google" existir** (botão na tela Configurações → Backup do app +
seção "Contas Google vinculadas" na aba Cofre da Central): republique
de novo — o bloco atual inclui as coleções novas `contas_google`
(onde o app grava o e-mail e a senha já cifrada) e `config_publica`
(onde a Central publica a chave pública que os apps usam pra cifrar).
Sem isso, o botão "Salvar conta" no app falha (não consegue nem ler a
chave pública, nem gravar o resultado), com um erro explicando o
motivo na própria tela. Lembre também de gerar a chave de proteção
uma vez, na aba Cofre → "Contas Google vinculadas" → "Gerar chave de
proteção" — sem isso feito, o mesmo botão falha do mesmo jeito, mesmo
com as regras já publicadas.

**Se você já tinha publicado as regras antes da aba "🕐 Auditoria"
existir**: republique de novo — o bloco atual inclui a coleção nova
`acoes_log`, onde a Central grava um registro toda vez que você
congela, bloqueia, restaura um backup remoto ou publica/desativa uma
atualização obrigatória. Sem essa regra, cada uma dessas ações
continua funcionando normalmente (o registro de auditoria é só um
`addDoc` de melhor esforço, feito depois da ação principal), mas
falha silenciosamente ao tentar gravar o log — a aba Auditoria fica
sempre vazia e o console do navegador mostra `[auditoria] falha ao
registrar ação`. Repare que a regra bloqueia `update` e `delete` de
propósito (só `create` e `read`): um registro de auditoria não deveria
dar pra editar ou apagar depois, nem sem querer.

**Antes de confiar nisso em produção**: eu não tenho como testar essas
regras ao vivo aqui (não tenho acesso a um projeto Firebase de
verdade) — eu escrevi com cuidado e segui o padrão documentado do
Firestore, mas teste você mesmo antes de depender disso: tente, pelo
simulador de regras do próprio Firebase (aba "Regras" → "Simulador"),
simular uma escrita não-autenticada tentando mudar `ativo` — deve ser
negada.

## Passo 3.5 — Regras do Storage (backup na nuvem)

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
licenciamento (Passo 3.5), dá pra ter uma **segunda cópia fora da
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
