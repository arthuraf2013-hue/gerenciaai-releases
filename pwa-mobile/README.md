# App do celular (garçom + consulta remota)

PWA (Vite + React no painel de mesas, JS puro no resto) que dá acesso pelo
celular a estas coisas, pareadas por um código de 6 dígitos gerado no
desktop (Configurações → Celular):

- **Painel de mesas** (garçom e operador): mesas da loja ao vivo, comanda
  de cada mesa separada por pessoa, "Lançar para" (cada item já nasce da
  pessoa), observação por item, status da cozinha (aguardando / preparando
  / pronto), pessoas com nome, mover item, cancelar item (com PIN de
  gerente quando a loja exige) e marcar mesa limpa. No celular do operador
  (PDV móvel) também: juntar, separar e transferir mesas e **fechar a
  conta** (mesa inteira ou por pessoa, várias formas, troco, QR do Pix).
  Lançar itens funciona sem internet (vai quando a conexão volta). Ver
  "Painel de mesas" abaixo.

- **Garçom**: monta um pedido a partir do catálogo da loja e manda pra
  `installations/{installId}/pedidos_garcom` — o desktop converte em
  comanda de verdade (ver `electron/services/pedidoGarcomSyncService.js`).
- **PDV móvel**: vender pelo celular (catálogo, leitor de código,
  carrinho, cliente, desconto, dinheiro/cartão/Pix/fiado, recibo) +
  pedidos de mesa + histórico, com abas que a loja configura em
  Configurações → Celular. Precisa de internet: a venda só vale depois
  que o GerenciaAI do computador confere e registra (ver
  `electron/services/pdvMobileSyncService.js`).
- **Painel da loja dentro do PDV móvel**: a aba "Painel" mostra no
  celular PDV o mesmo painel da Consulta remota (faturamento do dia,
  histórico hoje/7/30 dias com gráfico, formas de pagamento, mais
  vendidos, por operador, mesas e pedidos), se a loja liberar em
  Configurações → Celular → "Painel da loja no celular" (padrão: só no
  celular vinculado a gerente/administrador).
- **Consulta remota** (Adm/Gerente): vê o resumo financeiro do dia e a
  operação ao vivo (mesas, pedidos em andamento) da(s) loja(s) a que
  está vinculado — suporta mais de uma loja no mesmo celular (dono de
  rede com várias unidades).

## Build (desde a versão 2)

Antes era 100% estático, sem build, com o Firebase vindo do CDN. Mudou
porque o service worker não guardava o CDN: **sem internet o app nem
abria**. Agora o SDK do Firebase vem do npm e entra no build, e o service
worker guarda o app inteiro no aparelho.

O resultado continua sendo arquivo estático (`dist/`), que qualquer
hospedagem aceita -- só que agora quem publica precisa de Node 22+:

```bash
cd pwa-mobile
npm install        # só na primeira vez (ou quando mudar o package.json)
npm run build      # gera dist/
npm test           # lógica + telas do painel de mesas (jsdom)
npm run dev        # desenvolvimento (sem service worker)
```

Teste de ponta a ponta (dois celulares no Chrome + emuladores do Firebase +
serviços do computador): ver `e2e/README.md` na raiz. Usa `npm run build:e2e`
(app ligado nos emuladores) e `npm run preview:e2e`.

`vite.config.js` gera `dist/sw.js` a partir de `sw.js` (modelo) com a lista
exata dos arquivos e uma versão tirada do conteúdo: nunca mais trocar
número de cache à mão. Versão nova não assume sozinha: o app mostra
"Versão nova do app pronta · Atualizar" e só troca quando a pessoa toca
(nunca no meio de uma venda ou de um pedido).

## Arquivos

- `index.html` / `styles.css` — casca do app.
- `app.js` — bootstrap: autenticação anônima + decide qual tela mostrar
  (pareamento, garçom ou consulta) com base no que está salvo em
  `localStorage` (ver `store.js`); registra o service worker e mostra o
  aviso de versão nova.
- `pairing.js` — troca o código de 6 dígitos por um vínculo permanente.
- `garcom.js` / `consulta.js` — telas do garçom e da consulta remota. O
  garçom ganha a aba "Mesas" (painel novo) quando o computador publica as
  mesas; com ela, "Novo pedido" vira "Balcão" (pedido sem mesa).
- `painel-loja.js` — o painel da loja (resumo do dia, histórico com
  gráficos, formas de pagamento, mais vendidos, por operador, mesas,
  pedidos, agregação do grupo), usado pela consulta remota e pela aba
  "Painel" do PDV móvel — uma fonte só, os dois mostram os mesmos números.
- `pdv.js` — casca do PDV móvel (abas, indicador de conexão, config da
  loja); `pdv-venda.js` (vender), `pdv-historico.js` (vendas + "Meu
  turno"), `pdv-recibo.js`, `pdv-scanner.js` (câmera via BarcodeDetector),
  `pdv-servidor.js` (tudo que fala com o computador via Firestore),
  `pdv-util.js`.
- `src/mesas/` — painel de mesas em React: `PainelMesas.jsx` (estado e
  navegação, com o "voltar" do celular), `TelaMesas`, `TelaComanda`,
  `TelaLancar`, `TelaConta`, `comum.jsx`, `logica.js` (regras de tela,
  sem React), `servidorMesas.js` (Firestore), `montar.jsx` (ponte com as
  telas em JS puro), `mesas.css`.
- `firebase-config.js` — inicializa o Firebase (mesmo projeto único do
  Electron, `gerenciaai-licencas`) com cache local persistente — é isso
  que dá a "fila offline" do garçom sem precisar escrever fila nenhuma
  à mão: um pedido criado sem internet fica no cache local e sincroniza
  sozinho quando a conexão voltar.
- `public/manifest.webmanifest`, `public/icons/` — copiados como estão
  para `dist/`; `sw.js` — modelo do service worker (ver Build).
- `tests/` — `logica.test.js` e `telas.test.js` (o painel de verdade num
  DOM de mentira, com o servidor trocado por `tests/apoio/servidorFalso.js`).

## Painel de mesas

Lado do computador: `electron/services/mesaCelularService.js`.

- **Publicação** (computador → celular, só quando muda; sinal de vida a
  cada 30 s se a loja tem mesa): `mesas_ao_vivo/atual` (todas as mesas +
  caixa aberto, formas de pagamento liberadas, quem pode autorizar, chave
  pública do PIN) e `comandas_mesa/{mesaPrincipalId}` (itens com pessoa,
  observação e status da cozinha, pessoas e a conta por pessoa). Só
  celular pareado e ativo lê (tem nome das pessoas da mesa).
- **Comandos** (celular → computador): `comandos_mesa/{id}`, um
  documento por ação (`lancar`, `abrir`, `adicionar_pessoa`,
  `renomear_pessoa`, `remover_pessoa`, `mover_item`, `observacao_item`,
  `cancelar_item`, `limpar_mesa`, `juntar`, `separar`, `transferir`,
  `taxa_servico`, `receber`, `meu_turno`). O computador confere o celular
  e o papel ATUAL do usuário, aplica pelos mesmos serviços da tela do
  computador e responde no mesmo documento. Cada comando vale uma vez
  (reentrega devolve o resultado guardado).
- **Sem internet**: só "lançar" (o SDK guarda e envia depois, até 12 h;
  a tela mostra "na fila"). O resto precisa do computador respondendo e é
  recusado se chegar atrasado.
- **PIN do gerente** (cancelar item de conta que já tem pagamento): vai
  cifrado com a chave pública do computador (RSA-OAEP); no Firestore nunca
  fica em claro. PIN errado conta para o bloqueio, igual no computador.
- **Receber**: entra no caixa aberto do computador (igual à venda do PDV
  móvel). Por pessoa: cada pagamento guarda de quem era
  (`payments.detalhes.grupos`); a taxa de serviço e o desconto são
  divididos na proporção de cada um. Conta toda paga: a venda finaliza e a
  mesa vai para "aguardando limpeza".
- **Compatibilidade**: se o computador ainda não publica as mesas
  (GerenciaAI do computador antigo ou regras do Firestore antigas), o app
  continua exatamente como antes (aba Mesas do PDV volta para o fluxo do
  garçom embutido).

## Publicando

### Opção recomendada: Firebase Hosting (mesmo projeto)

```bash
npm install -g firebase-tools
firebase login
# uma vez: dependências do app do celular
npm --prefix pwa-mobile install
# cria um SITE de hosting novo dentro do projeto gerenciaai-licencas
# (o hosting padrão pode já estar em uso por outra coisa -- um site
# nomeado evita qualquer conflito):
firebase hosting:sites:create gerenciaai-garcom
firebase target:apply hosting garcom gerenciaai-garcom
firebase deploy --only hosting:garcom
```

O `firebase.json` da raiz publica `pwa-mobile/dist` e roda o build antes
(`predeploy`). Isso publica em `https://gerenciaai-garcom.web.app` (ou o
domínio que você configurar). **Antes do primeiro deploy** (e sempre que
`firestore.rules` mudar -- o painel de mesas precisa das regras novas),
publique também as regras e o índice do Firestore (ver raiz do
repositório):

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

Qualquer hospedagem de arquivo estático funciona -- é só rodar
`npm run build` e copiar a pasta `pwa-mobile/dist/` inteira (os caminhos
são relativos). Netlify: arraste a pasta `dist` pro painel. GitHub Pages:
publique `dist` como a raiz do site. Em qualquer uma delas, as regras e o
índice do Firestore acima continuam precisando ser publicados
separadamente (via `firebase deploy --only firestore:rules,firestore:indexes`
ou pelo Console).

## Testando localmente

```bash
cd pwa-mobile
npm run dev            # http://localhost:5173 (sem service worker)
npm run build && npm run preview   # o app como vai ser publicado
```

Para abrir no celular na mesma rede Wi-Fi: `npm run dev -- --host` e use o
endereço que aparecer. Obs.: o PIN de gerente é cifrado com WebCrypto, que
só existe em https ou em `localhost`.

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
