# App do celular (garçom + consulta remota)

PWA estático (sem passo de build, sem framework) que dá acesso pelo
celular a duas coisas, pareadas por um código de 6 dígitos gerado no
desktop (Configurações → Celular):

- **Garçom**: monta um pedido a partir do catálogo da loja e manda pra
  `installations/{installId}/pedidos_garcom` — o desktop converte em
  comanda de verdade (ver `electron/services/pedidoGarcomSyncService.js`).
- **Consulta remota** (Adm/Gerente): vê o resumo financeiro do dia e a
  operação ao vivo (mesas, pedidos em andamento) da(s) loja(s) a que
  está vinculado — suporta mais de uma loja no mesmo celular (dono de
  rede com várias unidades).

## Por que sem build

O resto do app (Electron + Vite + React) já tem um passo de build; este
não tem de propósito, pra poder ser publicado em QUALQUER hospedagem de
arquivo estático — Firebase Hosting, Netlify, GitHub Pages, ou só
copiar a pasta pra um servidor — sem precisar instalar Node nem rodar
`npm install` em lugar nenhum. Firebase é importado direto de um CDN
(`https://www.gstatic.com/firebasejs/...`, mesma técnica do
`admin-panel/index.html` já existente).

## Arquivos

- `index.html` / `styles.css` — casca do app.
- `app.js` — bootstrap: autenticação anônima + decide qual tela mostrar
  (pareamento, garçom ou consulta) com base no que está salvo em
  `localStorage` (ver `store.js`).
- `pairing.js` — troca o código de 6 dígitos por um vínculo permanente.
- `garcom.js` / `consulta.js` — as duas telas principais.
- `firebase-config.js` — inicializa o Firebase (mesmo projeto único do
  Electron, `gerenciaai-licencas`) com cache local persistente — é isso
  que dá a "fila offline" do garçom sem precisar escrever fila nenhuma
  à mão: um pedido criado sem internet fica no cache local e sincroniza
  sozinho quando a conexão voltar.
- `manifest.webmanifest` / `sw.js` / `icons/` — deixam o app instalável
  (PWA) na tela inicial do celular.

## Publicando

### Opção recomendada: Firebase Hosting (mesmo projeto)

```bash
npm install -g firebase-tools
firebase login
# cria um SITE de hosting novo dentro do projeto gerenciaai-licencas
# (o hosting padrão pode já estar em uso por outra coisa -- um site
# nomeado evita qualquer conflito):
firebase hosting:sites:create gerenciaai-garcom
firebase target:apply hosting garcom gerenciaai-garcom
firebase deploy --only hosting:garcom
```

Isso publica em `https://gerenciaai-garcom.web.app` (ou o domínio que
você configurar). **Antes do primeiro deploy**, publique também as
regras e o índice do Firestore (ver raiz do repositório):

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

A busca do código de pareamento é uma collection group query
(`where('codigo', '==', ...)` em `pareamentos`) -- por padrão o
Firestore só mantém índice automático de campo único em escopo de
COLEÇÃO, não de collection group, então essa busca precisa mesmo de
configuração explícita. A pegadinha: **não é** um índice composto
normal (declarar assim em `indexes[]` é rejeitado pela API com "this
index is not necessary, configure using single field index
controls") -- é uma *field override* de campo único habilitando o
escopo COLLECTION_GROUP, que é o que `fieldOverrides[]` em
`firestore.indexes.json` já faz. Sem publicar isso, o pareamento falha
com "Não foi possível conectar agora" na hora de digitar o código
(erro genérico na tela; o real, visível no console do navegador, é
"the query requires an index").

### Outras opções

Qualquer hospedagem de arquivo estático funciona -- é só copiar a pasta
`pwa-mobile/` inteira (mantendo os caminhos relativos). Netlify: arraste
a pasta pro painel. GitHub Pages: publique esta pasta como a raiz do
site. Em qualquer uma delas, as regras e o índice do Firestore acima
continuam precisando ser publicados separadamente (via `firebase
deploy --only firestore:rules,firestore:indexes` ou pelo Console).

## Testando localmente

Como é 100% estático, qualquer servidor HTTP simples funciona (não pode
ser `file://` direto -- módulos ES e o service worker exigem
http/https):

```bash
cd pwa-mobile
python3 -m http.server 8080
# ou: npx serve .
```

Abra `http://localhost:8080` no celular (mesma rede Wi-Fi) ou no
Chrome DevTools em modo responsivo no computador.

## Módulos pagos (Consulta remota, App do garçom)

Cada cliente (`clientes/{clienteId}.modulosAtivos`) tem os dois módulos
independentemente ativos/desativados -- ver a PARTE 1.5 de
`firestore.rules` e `electron/services/modulosPagosService.js`. Desligar
um módulo no admin-panel corta o acesso de quem já estava pareado, não
só impede pareamento novo (a checagem roda em toda leitura de dado
sensível, não só na hora de gerar/resgatar o código).

## Grupo de sincronização (múltiplos PDVs da mesma loja)

Quando a instalação pareada pertence a um grupo de sincronização (ver
`syncStateService.js`/Central → Sincronização), a tela de Consulta
remota agrega automaticamente o resumo financeiro do dia (faturamento,
vendas, ticket médio, com detalhamento por terminal) de TODOS os
terminais do grupo -- sem precisar parear em cada um. Isso usa
`grupos_sincronizacao/{grupoId}/vendas` (já sincronizado ali por
`salesSyncService.js`, leitura já aberta nas regras). Mesas e pedidos em
andamento continuam mostrando só o terminal ao qual o celular está
pareado de fato -- esse dado é local de cada terminal, não existe hoje
sincronização de mesas/pedidos entre terminais do mesmo grupo.

## Limitações conhecidas / próximos passos possíveis

- Sem push notification (ex: avisar o garçom quando o pedido é
  recebido/dá erro) -- hoje só dá pra ver isso abrindo a aba "Meus
  pedidos". Notificação push exigiria Firebase Cloud Messaging + pedir
  permissão do navegador, deixado de fora desta versão.
