# GerenciaAI — contexto pro Claude Code

PDV (ponto de venda) desktop multiplataforma pra pequeno comércio —
Electron + Vite + React (frontend) + SQLite via better-sqlite3
(backend local, sem servidor). Cobre farmácia, petshop, restaurante,
salão de beleza, ótica, material de construção, e mais — cada tipo de
negócio tem um "perfil" com campos extras e funcionalidades próprias.

O `README.md` é um changelog cronológico de cada sessão de
desenvolvimento — útil pra entender POR QUE uma decisão foi tomada,
mas não é o lugar pra começar. Este arquivo é o resumo do estado
atual.

## Arquitetura

- **`electron/main.js`** — processo principal. API modesta e
  estável: `app`, `BrowserWindow`, `protocol.handle` (a versão
  moderna, não a depreciada), `dialog.showErrorBox`.
- **`electron/preload.js`** — único ponto de exposição de IPC pro
  renderer, via `contextBridge`. Cada namespace (`window.pdv.produtos`,
  `window.pdv.clientes`, etc.) mapeia 1:1 pra um canal IPC.
- **`electron/ipc/handlers.js`** — registra todo handler com
  `safeHandle(canal, fn)`, que já embrulha em try/catch e devolve
  `{ ok: false, error }` em vez de deixar a IPC explodir. `fn` pode
  ser sync ou async — `safeHandle` faz `await` por fora, então
  `return promiseSemAwait` dentro do handler já funciona certo (não
  precisa de `await` redundante em cada handler individual).
- **`electron/services/*.js`** — toda a lógica de negócio, um
  arquivo por domínio (`saleService`, `productService`,
  `stockService`, `deliveryService`, etc.). Cada serviço fala direto
  com o SQLite via `getDb()` de `db/database.js` — sem camada de ORM.
- **`electron/db/schema.sql`** — schema completo, usado tanto pra
  banco novo quanto (via `setDbForTesting`) pra cada teste.
- **`electron/db/database.js`** — `migrateColumnsIfNeeded()` faz a
  migração de coluna nova em banco já existente
  (`adicionarColunaSeFaltando`) — TODA coluna nova em tabela já
  existente precisa de uma linha aqui, além do `schema.sql` (que só
  vale pra banco novo).
- **`src/components/`** — React, organizado por área (`pos/`,
  `inventory/`, `layout/`, `users/`, `settings/`). Cada tela grande
  é um arquivo, sem Redux/Context genérico — estado local +
  `SessionContext`/`ProfileContext` pro que precisa ser global.

## Convenções que se repetem no código

- **IPC**: `window.pdv.<namespace>.<metodo>(payload)` → sempre uma
  Promise, sempre `{ ok: true, ... }` ou `{ ok: false, error }` pra
  operação que pode falhar por validação de negócio.
- **Listas vazias**: toda tela de lista trata explicitamente
  `array.length === 0` com uma mensagem (`<p className="empty-state">`)
  em vez de deixar a tabela renderizar sem linha nenhuma — uma
  `<table>` vazia com `background`+`border-radius` vaza cor pra uma
  área maior que o esperado e estica a barra de rolagem da tela (bug
  real, já corrigido em várias telas — ao criar tela de lista nova,
  sempre tratar o caso vazio desde o início).
- **Modais**: todo modal usa `useEscToClose(onClose, ativo)` (hook em
  `src/hooks/`) — sem isso, Esc não fecha.
- **Menu suspenso de ações secundárias**: `DropdownMenu`/`DropdownMenuItem`
  em `src/components/common/` — usar em vez de empilhar botão atrás
  de botão num cabeçalho de tela.
- **Paginação de lista grande**: cursor-based (`WHERE (nome, id) >
  (?, ?)`), nunca `OFFSET` — com dado mudando entre chamadas (sync
  entre máquinas, cadastro concorrente), `OFFSET` desloca e duplica
  linha. Ver `productService.list()`.
- **Autorização de gerente**: todo fluxo sensível (cancelamento pós-
  pagamento, desconto, devolução) passa por `authService.authorizeManagerOverride()`
  — nunca aceita o próprio operador como autorizador, mesmo sendo
  gerente/admin.
- **Papéis de usuário**: `operador`, `gerente`, `admin`, `garcom` e
  `suporte` (`users.role`, CHECK em `schema.sql` + migração
  `atualizarCheckRoleParaIncluirSuporte` em `database.js`). `suporte`
  tem exatamente as mesmas permissões de `admin` em TODA checagem de
  acesso do app (backend e frontend) — é um valor distinto só pra
  deixar rastreável na Auditoria que a ação foi de suporte técnico, não
  do dono/admin do negócio. Ao adicionar uma checagem nova baseada em
  `role === 'admin'` (ou array com `'admin'`), incluir `'suporte'`
  junto — não tem nenhuma tela/fluxo onde os dois deveriam se
  comportar diferente. Único lugar onde `suporte` NÃO é tratado como
  admin: um `gerente` não pode criar/ativar/desativar/resetar PIN de
  um usuário `suporte`, mesma regra que já existia pra `admin`
  (`userService.js`).

## A armadilha de fuso horário — já mordeu várias vezes

Datas de calendário (validade, próxima vacina, "hoje" pra qualquer
comparação) **nunca** podem usar `new Date().toISOString().slice(0,10)`
puro — isso é UTC, e Brasília é UTC-3. Entre 21h e meia-noite em
Brasília (madrugada já virada em UTC), esse cálculo adianta o dia
errado. Usar sempre `timeService.hojeLocalISO()` ou
`timeService.diasAPartirDeHojeLocalISO(dias)` (`electron/services/timeService.js`).
Isso já causou bug real em produção (preço promocional cortando um
dia cedo demais) — tem teste de regressão dedicado em
`tests/fusoHorarioMeiaNoite.test.js` que **congela o relógio** nesse
horário especificamente, pra pegar isso sem depender de rodar o
teste por acaso nessa hora.

Timestamp de evento (criado_em, finalizada_em) é diferente — esses
são UTC de verdade (`NOW_SYNCED()`), e ao comparar contra "hoje" em
SQL usa `date(coluna, '-3 hours')`.

## Módulo nativo (better-sqlite3) — armadilha antiga, resolvida na v13

Até a v11, `better-sqlite3` era compilado direto contra a API interna
do V8, então cada ambiente (Node do sistema vs. Node **interno do
Electron**) precisava do seu próprio binário recompilado — o
`postinstall` (`electron-builder install-app-deps`) recompilava pro
Electron, o que quebrava `node --test` direto (erro
`NODE_MODULE_VERSION`) a menos que se recompilasse de novo pro Node
do sistema antes (por isso o script `test` fazia `npm rebuild
better-sqlite3 && node --test`). Isso piorou de vez com o Electron 43:
a API do V8 mudou o bastante (`Context::GetIsolate` removido,
`SetNativeDataProperty`/`External::Value` com assinatura diferente)
que a v11 nem compila mais contra os headers do Electron novo — erro
`Cannot find module 'exceljs'`/travas de build parecidas, ou o
`node-gyp`/MSBuild falhando com esses símbolos do V8, geralmente vêm
daqui.

Corrigido subindo `better-sqlite3` pra v13 (`^13.0.3`), que migrou pra
N-API — binário com ABI estável entre versões de Node/Electron, já
vem pré-compilado (`prebuilds/`, incluindo `win32-x64`) e **não
precisa mais de rebuild nenhum**, nem manual nem pelo
`electron-builder install-app-deps`. O script `test` voltou a ser só
`node --test`. Se esse erro aparecer de novo depois de um `npm
install`, o mais provável é o lockfile ter voltado pra uma v11 antiga
— confere `node_modules/better-sqlite3/package.json` → `version`.

## Testes

`node --test` puro (sem framework externo), um arquivo por serviço
em `tests/`, helper compartilhado em `tests/helpers/testDb.js`
(`freshTestDb()` monta um banco `:memory:` do zero por teste,
`createProduct`/`addStock` etc. pra popular rápido). Rodar `npm test`
sempre antes de considerar qualquer mudança pronta.

## Build e release

Publicar uma versão nova é automático de ponta a ponta — não precisa
rodar `npm version patch` na mão:

1. `.github/workflows/auto-version.yml` roda em todo push na `main`,
   mas só age quando a mensagem do commit começa com `release:` (ex:
   `release: corrige cálculo de troco`) — isso evita publicar sozinho
   um commit de trabalho em andamento. Quando ativa: roda `npm test`
   como gate, depois `npm version patch` (bump + commit + tag,
   `postversion` já faz `git push && git push --tags`). O commit de
   bump é marcado `[skip release]` pra não disparar a si mesmo de
   novo.
2. A tag `vX.Y.Z` criada dispara `.github/workflows/release.yml`
   (inalterado): `npm ci` → `npm test` de novo → build do frontend
   (Vite) → `electron-builder --publish always` (Windows, NSIS) →
   publica em `arthuraf2013-hue/gerenciaai-releases`. electron-builder
   está na v26 (não v27 — a v27 exige Node ≥22.12 e tem breaking
   changes própria).
3. Se uma versão publicada sair com problema:
   `.github/workflows/rollback-release.yml` (disparo manual, aba
   Actions → "Run workflow", pede a tag) marca a release como
   pré-lançamento — o GitHub (e o auto-updater do app) voltam a
   apontar pra release boa anterior automaticamente. Não desfaz nada
   no código, só tira aquela versão de circulação pra quem ainda não
   baixou. Uma estação que já tinha baixado a versão ruim ANTES do
   rollback ainda instala ela no próximo fechamento — rodar o
   rollback rápido é o que faz a proteção valer.

**Atenção a um ponto não totalmente confirmado**: o `release.yml`
publica num repositório DIFERENTE (`gerenciaai-releases`) do
repositório onde o código/os workflows ficam, usando só
`secrets.GITHUB_TOKEN` (o token automático do Actions). Esse token só
tem permissão dentro do próprio repositório por padrão — publicar
cross-repo normalmente exige um token pessoal (PAT) salvo como secret.
Se isso já funciona hoje, ótimo; se `rollback-release.yml` (ou o
`release.yml`) falhar com erro de permissão/404, é por causa disso —
troque `secrets.GITHUB_TOKEN` por um secret com um PAT seu (`repo`
scope) nos workflows.

O app em si também ficou mais automático: `electron/services/updateService.js`
baixa uma versão nova sozinho assim que acha (`autoDownload = true`,
checagem periódica já existente em `main.js`) e instala sozinho na
próxima vez que o app fechar/abrir naturalmente
(`autoInstallOnAppQuit = true`) — nunca força um reinício no meio de
uma venda. A única exceção é a tela de atualização OBRIGATÓRIA
(`UpdateGate.jsx`, controlada pelo painel de licenciamento): como ela
já bloqueia 100% do uso, instala assim que termina de baixar, sem
esperar reinício natural (não tem nada pra interromper).

O `build.files` do `package.json` tem uma lista de exclusão
deliberada (partes do Firebase não usadas, `exceljs/dist`,
`better-sqlite3/deps`+`src`) — todas testadas empacotando de verdade
e chamando a função real antes de excluir. Ver histórico no README
("Otimização de armazenamento") pro raciocínio completo antes de
mexer nessa lista.

## Perfis de negócio

`electron/db/database.js` (`seedProfileIfMissing`) — 11 perfis
(farmacia, petshop, armazem, salao_beleza, padaria, papelaria,
vestuario, otica, material_construcao, restaurante, generico).
Telas/funcionalidades específicas de perfil ficam condicionadas por
`profile?.id === '...'` no componente (ex: aba Agenda só aparece pro
salao_beleza). Treinamento em PDF também é por perfil — 9 arquivos em
`public/treinamento-*.pdf`, escolhidos automaticamente por
`TrainingPresentationModal.jsx` conforme o perfil ativo.

## App do celular (garçom + consulta remota) e `pwa-mobile/`

`pwa-mobile/` é um segundo app, **fora do Electron** — um PWA estático
(sem passo de build, Firebase importado de CDN) publicado à parte (ver
`pwa-mobile/README.md`). Ele fala com o desktop só através do mesmo
projeto Firebase central de licenciamento (`gerenciaai-licencas`, ver
`licenseService.js`) — nunca direto com o SQLite. Vínculo celular↔loja
é por código de 6 dígitos (gerado em Configurações → Celular), nunca
login de verdade; um celular pode estar vinculado a mais de uma loja
(dono de rede).

Peças do lado do Electron:
- `electron/services/pairingService.js` — gera/revoga código, espelha
  localmente quem está pareado (`pairing_codes`/`paired_devices`).
- `electron/services/liveStatusSyncService.js` — publica
  `installations/{installId}/status_ao_vivo/atual` a cada ~25s (resumo
  do dia, mesas, pedidos em andamento, catálogo de produtos pro
  garçom). Por INTERVALO, de propósito — não hookado em
  `tableService`/`saleService`/`botOrderService`.
- `electron/services/pedidoGarcomSyncService.js` — recebe pedido do
  PWA e cria `bot_orders`/`bot_order_items` (`origem = 'app_garcom'`,
  mesma tabela do bot do WhatsApp), lançando na comanda via
  `botOrderService.lancarPedidoNaMesa` quando tem mesa.
- `firestore.rules` (raiz do repo) — **primeira regra de segurança
  publicada no projeto** (antes era tudo aberto). Só as 5 coleções
  novas do pareamento têm regra de verdade; o resto preserva o
  comportamento de hoje de propósito (ver comentário no topo do
  arquivo). `firestore.indexes.json` é obrigatório junto (a busca do
  código de pareamento é uma collection group query).

Ver a entrada "App do garçom + consulta remota pelo celular" no
README.md pro raciocínio completo, e `tests/firestoreRules.test.js`
pro que ainda falta rodar contra o emulador de verdade (não foi
possível numa sessão sem rota de rede até o download dele).
