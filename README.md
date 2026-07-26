# GerenciaAI

Sistema de gerenciamento de estoque com PDV integrado. Perfil inicial: **farmácia**,
mas o núcleo é genérico e outros tipos de estabelecimento entram como
**perfis de negócio** (`/profiles`), sem alterar o schema ou os serviços centrais.

> O nome já reserva o espaço para funcionalidades de IA futuras (ver seção
> "IA — próximos passos" no fim deste documento). Nada de IA está
> implementado ainda — esta versão é 100% determinística/regras de negócio.

## Como rodar

```bash
npm install
npm run dev:electron
```

Login inicial (seed automático no primeiro start):
- Usuário: **Administrador**
- PIN: **0000** — troque isso assim que possível (ainda não há tela de
  gestão de usuários; é o próximo passo natural do roadmap).

## Decisões de arquitetura

### Estoque como ledger, não como número
`stock_movements` é **append-only**: nunca se edita um movimento, só se
compensa com outro (`estorno`). O estoque atual de um produto é sempre
`SUM(quantidade)`. Isso é o que permite sincronização offline→online sem
conflitos de "quem ganha a escrita" — os eventos só se somam.

### Cancelamento seguro (o ponto que você pediu com mais atenção)
- Toda venda decrementa o estoque **no momento em que o item é adicionado**
  (`saleService.addItem`), não só no fechamento — como pedido.
- Cancelar um item ou a venda inteira exige `authService.authorizeManagerOverride`,
  que roda **inteiramente no processo principal (Node)**, nunca no renderer:
  1. a pessoa que autoriza precisa existir, estar ativa, e ter papel
     `gerente` ou `admin`;
  2. **não pode ser a mesma pessoa** logada como operador do caixa —
     essa checagem é feita no backend, não confiando em nada vindo da tela;
  3. toda tentativa (aprovada ou negada) é gravada em `audit_log`, com quem
     pediu e quem autorizou.
- O PIN nunca sai do processo principal como hash — o preload só expõe
  `window.pdv.auth.login` / `authorizeManagerOverride` via IPC, e o hash
  bcrypt nunca trafega para o renderer.

### Leitor de código de barras
`useBarcodeScanner` funciona com qualquer leitor USB/Bluetooth padrão
(eles se comportam como teclado — "HID keyboard wedge"), detectando a
digitação em rajada característica desses aparelhos. Não exige driver
nem SDK específico.

### Pagamento
`payments` é uma tabela separada de `sales` — uma venda pode ter N
pagamentos (ex: metade no pix, metade em dinheiro). `finalizeSale` só
libera se a soma dos pagamentos cobre o total.

### Perfis de negócio (farmácia → genérico → outros)
`/profiles/farmacia.json` define campos extras (lote, validade, princípio
ativo, controlado, exige receita) e regras de alerta/venda específicas,
sem tocar no schema genérico (`custom_fields` em `products` é JSON livre).
Trocar de perfil = trocar de arquivo de config, não de código.

## Ajuste importante: receita deixou de ser obrigatória

Produtos controlados que exigem receita **não bloqueiam mais a venda** —
nem todo estoque é de medicamentos, então isso viraria um obstáculo em
outros tipos de negócio. Em vez disso:
- Ao vender um produto marcado como controlado + exige receita, o PDV só
  mostra um aviso informativo ("considere anexar a receita"), sem impedir
  o lançamento.
- A venda agora tem um botão **"Anexar receita / arquivo"** que abre um
  seletor de arquivo nativo para anexar uma **imagem ou PDF** (receita,
  comprovante, nota) à venda — totalmente opcional, guardado em
  `sale_attachments` e copiado para a pasta de dados do app
  (`userData/anexos/<sale_id>/`).

## O que foi adicionado nesta rodada

### Navegação por papel (fácil de operar)
`AppShell` mostra só o que cada papel precisa: **operador** vai direto para o
PDV em tela cheia, sem menu nem distração; **gerente** vê PDV + Produtos +
Alertas; **admin** vê tudo, incluindo Configurações e Usuários.

### Cadastro de produtos com campos dinâmicos
`ProductForm` lê o perfil de negócio ativo e desenha automaticamente os
campos extras (lote, validade, princípio ativo, controlado, exige receita
no perfil farmácia). Trocar de perfil em Configurações muda o formulário
sem precisar mexer em código.

### Painel de alertas
Estoque baixo (sempre) e validade próxima (quando o perfil ativo declarar
a regra `validade_proxima`, como a farmácia) — configurável em
`profiles/farmacia.json` via `diasAlertaValidade`.

### Configurações (fácil de configurar)
Tela dedicada para trocar o tipo de negócio (farmácia/genérico/futuro) e o
nome da loja, sem precisar editar arquivos manualmente.

### Gestão de usuários
Tela admin-only para criar operadores/gerentes, resetar PIN e ativar/
desativar — toda ação é revalidada no processo principal (`userService`),
nunca confiando em uma flag de "sou admin" vinda do renderer.

### Trava de receita para medicamentos controlados
Ao escanear um produto com `controlado` e `exige_receita` marcados, o PDV
pede confirmação explícita de que a receita foi apresentada antes de
lançar a venda (regra `bloquear_venda_se_receita_ausente_e_controlado` do
perfil farmácia).

### Importação e exportação de planilhas
- **Modelo obrigatório**: `templates/modelo_importacao_estoque.xlsx` — tem
  uma aba "Instruções" explicando cada coluna e uma aba "Modelo" com
  cabeçalho + exemplos prontos para editar.
- **Importar** (tela Produtos → "Importar planilha"): abre um seletor de
  arquivo nativo, lê a planilha, faz upsert de produtos por `sku`/`codigo_barras`
  e lança uma entrada de estoque inicial se a coluna `quantidade_estoque_inicial`
  vier preenchida. Retorna um relatório linha a linha com o que foi criado,
  atualizado ou deu erro.
- **Exportar**: gera uma planilha no mesmo formato do modelo, já com o
  estoque atual calculado a partir do ledger — útil como backup ou para
  levar os dados para outro sistema.

## Melhorias aplicadas (última rodada)

1. **Troca de PIN obrigatória no primeiro acesso**: o admin seedado nasce com
   `pin_temporario = 1`; enquanto isso não for zerado, o app trava em
   `ChangePinScreen` antes de liberar qualquer tela.
2. **Retomar venda em aberto**: `saleService.getOrOpenCurrentSale` procura uma
   venda `aberta` do mesmo operador/local antes de criar uma nova — se o app
   fechar no meio de uma venda, o carrinho volta do jeito que estava.
3. **Feedback visual por tipo** no PDV (info/sucesso/erro com cor) + beep
   sonoro em erros, já que o operador costuma estar de olho no cliente.
4. **Atalhos de teclado no PDV**: F2 finaliza a venda, F4 cancela o item
   selecionado (clique numa linha do carrinho para selecionar), Esc fecha
   qualquer modal aberto.
5. **Busca manual de produto** (`ProductSearchBox`) para quando o leitor não
   lê o código — funciona em paralelo ao leitor, sem conflito.
6. **Histórico de vendas do dia** (tela "Histórico", gerente/admin): hora,
   operador, itens, total e status de cada venda.
7. **Aviso não-bloqueante para controlados**: produtos marcados como
   controlado + exige receita disparam um aviso informativo no PDV, mas
   nunca impedem a venda (ver seção acima sobre anexos).

## Apresentação de treinamento embutida no app

Botão 🎓 no cabeçalho do PDV (ao lado do "?") abre a apresentação de
treinamento ("Como operar o PDV") num modal quase em tela cheia, dentro
do próprio app — sem abrir PowerPoint nem sair da janela.

**Atualizada** para cobrir tudo que foi adicionado desde a primeira
versão: alertas coloridos no carrinho, cliente e fidelidade, devolução
pós-venda, e a IA tutora (robô flutuante) — agora com 16 slides.

Como funciona: a apresentação foi gerada em `.pptx` e convertida uma
única vez para `public/treinamento-pdv.pdf` (o Vite empacota isso junto
com o resto do app automaticamente, sem precisar mexer na configuração
do instalador). O modal (`TrainingPresentationModal.jsx`) é só um
`<iframe>` apontando pra esse PDF — o Chromium tem visualizador de PDF
nativo embutido, só que ele vem **desligado por padrão no Electron**, então
precisei ligar explicitamente com `webPreferences.plugins: true` no
`main.js`.

Para atualizar o conteúdo da apresentação: edite o `.pptx` original,
reconverta pra PDF (`soffice --headless --convert-to pdf`) e substitua
`public/treinamento-pdv.pdf`.

## Tutorial guiado no PDV

Ícone "?" no cabeçalho do PDV (visível pra qualquer papel, inclusive
operador) reabre um tour com holofote a qualquer momento
(`src/components/pos/PosTour.jsx`). Aparece sozinho na primeira vez que
alguém usa o PDV (guardado em `localStorage`, chave
`gerenciaai:posTourSeen`) — sem exigir nada do backend. Cobre busca de
produtos, categorias, carrinho, anexar receita, pagamento e atalhos de
teclado.

## Relógio sincronizado, histórico por período e relatórios (última rodada)

### Relógio sincronizado com a internet
`electron/services/timeService.js` sincroniza com o cabeçalho HTTP `Date`
de domínios grandes e estáveis (Google, Cloudflare, Microsoft) — não
depende de uma API de horário específica que possa cair. A cada 15
minutos ele recalcula a diferença entre o relógio do Windows e o horário
real da internet (`offsetMs`), e essa diferença é o que passa a valer.

**Todo registro do banco agora usa esse relógio, não o relógio cru do
sistema**: `NOW_SYNCED()` é uma função SQL registrada em `database.js`
que substituiu todo `datetime('now')` do schema e dos serviços. Se o
relógio do Windows estiver errado, os registros continuam corretos
(desde que o app consiga sincronizar pela internet pelo menos uma vez).
Sem internet, cai de volta pro relógio do sistema sem travar nada — só
não fica com a garantia extra de exatidão.

O relógio aparece na sidebar (telas de gerente/admin) e no cabeçalho do
PDV (visível pro operador também). A bolinha verde/amarela ao lado
mostra se está sincronizado ou rodando no relógio local.

### Histórico com filtros de período
Hoje / Esta semana / Este mês / Personalizado (duas datas). Cada venda
agora mostra os métodos de pagamento usados (inclusive Pix, e combinações
tipo "Dinheiro, Pix" em pagamento misto).

### Exportar relatório
Botão "Exportar relatório" na tela de Histórico gera uma planilha
(`electron/services/reportService.js`) com todas as vendas do período
selecionado + o total finalizado, usando o mesmo diálogo nativo de salvar
arquivo já usado pela importação/exportação de produtos.

## Navegação por categoria, fotos de produto e Pix (última rodada)

### Botões de categoria + grade de produtos no PDV
Os botões em cima do carrinho são gerados a partir de `product:listCategories`
— **não há lista fixa em lugar nenhum**: cadastrar um produto com uma
categoria nova já faz o botão aparecer sozinho na próxima abertura do PDV
(o componente recarrega as categorias ao montar). Clicar num botão mostra
uma grade com todos os produtos ativos daquela categoria; clicar num
produto adiciona ao carrinho do mesmo jeito que o leitor de código de
barras (`CategoryProductBrowser.jsx`).

### Vendidos recentemente
Faixa fixa no rodapé do PDV (`RecentlySoldStrip.jsx`), acima do total —
mostra os últimos produtos vendidos naquele local (não duplica: cada
produto aparece uma vez, com a venda mais recente). Atualiza sozinha
depois de cada item adicionado ao carrinho.

### Foto do produto
Cadastro de produto agora tem uma seção de foto (só depois de o produto
já existir — precisa do ID pra associar o arquivo). A foto é copiada para
`userData/fotos-produtos/` e servida ao renderer como *data URL* (não como
`file://`, que teria restrições de segurança com `sandbox: true`). Aparece
como miniatura na lista de produtos, na grade de categorias e na faixa de
recentes — tudo via o mesmo componente `ProductThumbnail.jsx`, que mostra
um placeholder com a inicial do nome quando não há foto.

### Pagamento via Pix com QR Code
Configurações → Pagamento (Pix): cadastre a chave, nome do recebedor e
cidade. No pagamento, escolher "Pix" e informar o valor (integral ou
parcial, como qualquer outro método) gera um QR Code de verdade — o
payload segue o padrão **BR Code do Banco Central** (EMV/TLV + CRC16),
montado localmente em `electron/services/pixService.js`, sem nenhuma API
externa. Funciona com qualquer app de banco.

**Importante**: não existe integração bancária automática de confirmação
de recebimento (isso exigiria contratar um PSP/adquirente). O operador
confere o Pix no próprio aplicativo do banco e clica em "Confirmar
recebimento" — só depois disso o valor entra como pago na venda. Isso é
uma limitação deliberada, não um bug: confirmar automaticamente sem uma
integração real seria fingir uma verificação que não existe.

## Distribuição — sem auto-update

Assim como no Rota Certa, o `electron-builder` tenta gerar metadados de
auto-atualização por padrão (precisa de um repositório Git detectável ou
um provedor de publicação configurado) e quebra sem isso. `publish: null`
no `package.json` + `--publish never` no script `build:electron` +
`differentialPackage: false` desativam isso — a distribuição é só o
`.exe` manual gerado em `release/`, sem checagem de atualização automática.

## Identidade visual

Logo aplicado: "Ledger tick" — um "G" em traço único terminando num check,
simbolizando o registro contínuo de estoque e as autorizações conferidas.
Cor principal `#0f6e63` (teal), acento `#d9a84e` (dourado).

- `assets/logo-mark.svg` — arquivo-fonte do símbolo, editável.
- `public/logo-mark.svg` — cópia servida pelo Vite, usada no sidebar e nas
  telas de login/troca de PIN.
- `build/icon.png` e `build/icon.ico` — ícones gerados para o instalador
  (Windows/Linux) e para a janela do Electron em modo dev.
- `public/favicon-32.png` — favicon da aba em modo dev.

Para gerar os ícones de novo a partir do SVG (ex: se o design mudar), use
Python com `cairosvg` + `Pillow`:
```python
import cairosvg
from PIL import Image

cairosvg.svg2png(url='assets/logo-mark.svg', write_to='assets/logo-mark-1024.png', output_width=1024, output_height=1024)

src = Image.open('assets/logo-mark-1024.png').convert('RGBA')
src.save('build/icon.png')  # ícone Linux/AppImage e janela em modo dev

# IMPORTANTE: passe todos os tamanhos de uma vez em `sizes` — não combine
# com `append_images`, isso gera um .ico corrompido com só um tamanho
# (foi exatamente esse bug que quebrou o primeiro build do instalador).
sizes = [(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)]
src.save('build/icon.ico', format='ICO', sizes=sizes)  # precisa ter o quadro 256x256 — o electron-builder exige
```

## Exclusão de produtos

Botão "Excluir" na tela de Produtos — é uma **exclusão lógica**
(`ativo = 0`), não apaga a linha do banco de verdade. Mesmo padrão já
usado em clientes/fornecedores/usuários.

- O produto some do PDV, das categorias, da busca e das listagens — tudo
  já filtra por `ativo = 1`.
- **Nunca apaga de fato**: vendas e movimentos de estoque antigos
  continuam referenciando esse produto normalmente no histórico — apagar
  a linha quebraria isso.
- Se ainda houver estoque registrado, a confirmação avisa quanto antes
  de excluir (só um aviso, não bloqueia).
- Testado em SQL puro: produto some da lista de ativos, mas a linha e o
  histórico continuam intactos.

## Limiares de alerta configuráveis + ícone no carrinho

O gerente configura, por perfil (Configurações → Perfis de negócio), dois
níveis de alerta — não é mais só "estoque baixo sim/não":

- **Validade**: dias de antecedência pro aviso (amarelo) e pro crítico
  (vermelho) — separados, o crítico é sempre mais perto do vencimento.
- **Estoque**: um percentual do estoque mínimo abaixo do qual vira
  crítico (ex: mínimo 10 e 50% → abaixo de 5 fica vermelho, entre 5 e 10
  fica amarelo).

Assim que um produto é adicionado ao carrinho no PDV (por busca,
categoria, recentes, ou reconhecido numa receita), se ele estiver em
qualquer um desses níveis aparece um ícone ⚠ colorido ao lado do nome —
vermelho para crítico, amarelo para aviso. **Clicar no ícone** (não só
passar o mouse) abre um balão ao lado com o motivo exato — pensado assim
de propósito, sem depender de notificação nativa do sistema operacional
(a notificação do Windows foi removida por ser intrusiva). O balão fecha
sozinho ao clicar em qualquer outro lugar da tela.
(`electron/services/stockService.js`, `computeProductAlert` — testado
isoladamente com 8 cenários antes de integrar: estoque zerado, estoque
no limiar crítico/aviso, validade vencida/crítica/próxima/distante,
produto sem nenhum problema).

Vencido é sempre crítico, independente do limiar configurado.

## IA tutora — widget flutuante (ícone provisório)

Botão flutuante no canto inferior direito, em qualquer tela (inclusive
pro operador de caixa, que não tem sidebar) — abre um chat pra tirar
dúvidas sobre como usar o sistema, ou colar uma mensagem de erro pra
entender o que ela significa.

- `src/components/layout/FloatingTutor.jsx` — o widget em si.
- `electron/services/aiService.js` (`askTutor`) — reaproveita a mesma
  configuração de IA (chave/modelo) já usada pra ler receitas, então não
  exige uma segunda chave.
- O prompt de sistema (`TUTOR_SYSTEM_PROMPT`) descreve o app inteiro:
  PDV, caixa, pagamento, clientes/fiado/fidelidade, fornecedores,
  devolução, perfis, fiscal, painel, histórico, usuários — e sabe
  reconhecer o padrão de erro mais comum deste sistema especificamente
  ("no such column"/"no such table" = banco desatualizado, apagar o
  `.sqlite3` resolve).
- **O ícone é um SVG placeholder** (um robô simples) — Arthur vai mandar
  um modelo visual pra substituir. Só a aparência muda; a lógica de
  abrir/fechar e o chat continuam os mesmos.
- Conversa não é salva no banco — vive só na memória da sessão atual
  (fecha o painel ou o app, perde o histórico). Se fizer sentido guardar
  depois, dá pra adicionar uma tabela pra isso.

## Perfis de negócio editáveis (antes eram arquivos fixos)

**Mudança de arquitetura**: os perfis de negócio (que definem os campos
extras do produto e o alerta de validade) deixaram de ser arquivos
`.json` estáticos (só eu conseguia criar/editar) e passaram a morar no
banco, com um editor de verdade em Configurações → Perfis de negócio.
Isso é o que torna o GerenciaAI usável em qualquer tipo de comércio, não
só farmácia — o próprio usuário cria o perfil "Papelaria", "Pet Shop",
"Mercearia" etc., sem precisar de mim pra isso.

- **Criar / editar / duplicar / excluir perfil**, tudo pela interface.
  "Farmácia" e "Genérico" nascem como perfis seed, mas são perfis comuns
  — sem tratamento especial, totalmente editáveis (duplicar um deles é o
  jeito mais rápido de começar um perfil novo parecido).
- **Campos extras dinâmicos**: cada perfil define uma lista de campos
  (nome + tipo: texto, número, data, sim/não, obrigatório ou não) que
  aparecem no cadastro de produto quando aquele perfil está ativo.
- **Perfil ativo não pode ser excluído** — precisa trocar para outro
  perfil antes. Também não dá pra excluir o último perfil restante.
- `electron/services/profileService.js` foi reescrito do zero;
  `profiles/*.json` foram removidos (não são mais lidos por nada).
- Validado: schema aplicado em SQLite puro (23 tabelas) + simulação
  completa do fluxo (criar perfil, ativar, tentar excluir o ativo,
  excluir um perfil não-ativo) direto em SQL, batendo com o esperado.

## Importação de planilha atualizada (fornecedor + campos fiscais)

Achei um gap real ao preparar uma planilha de teste abrangente: a
importação (`importExportService.js`) nunca foi atualizada com os campos
adicionados depois que ela foi criada — fornecedor, NCM, CFOP, CST/CSOSN,
origem da mercadoria. Ficavam de fora de qualquer planilha importada,
mesmo já existindo no cadastro manual de produto.

- Novas colunas no modelo: `fornecedor`, `ncm`, `cfop`, `cst_csosn`,
  `origem_mercadoria` — todas opcionais.
- **Fornecedor é criado automaticamente** se o nome ainda não existir —
  mesmo espírito de "upsert" do resto do app, não precisa cadastrar antes.
- `templates/modelo_importacao_estoque.xlsx` (o modelo oficial) e a
  exportação (Produtos → Exportar planilha) foram atualizados juntos.
- Testado em SQL puro antes de integrar: criação de fornecedor a partir
  do nome + gravação dos campos fiscais no produto.

## Rodada de facilidades (8 itens)

### 1. Modo escuro
Botão no rodapé da barra lateral (☀/🌙). Aplicado já na tela de login,
salvo localmente (não precisa configurar de novo a cada abertura).
Reaproveita as mesmas variáveis CSS que o app inteiro já usa — nenhuma
tela precisou ser reescrita, só a paleta de cores muda.

### 2. Som de confirmação
Beep curto ao adicionar produto ao carrinho (busca, categoria, ou
receita) — sintetizado na hora (Web Audio API), sem precisar de arquivo
de áudio. Liga/desliga em Configurações. Os beeps de ERRO que já
existiam (item não encontrado, estoque insuficiente) continuam sempre
ativos de propósito — erro merece atenção mesmo com o som desligado.

### 3. Impressão automática do recibo
Liga/desliga em Configurações → Recibo. Ligado, imprime sozinho assim
que a venda é finalizada, sem precisar clicar depois.

### 4. Rodapé do recibo personalizável
Campo de texto livre em Configurações → Recibo (telefone, horário de
funcionamento, etc.) — usado no lugar do texto fixo "Obrigado pela
preferência!".

### 5. Etiqueta de código de barras interno
Produtos sem código de barras de fábrica (fracionados, genéricos da
própria loja) — botão "Gerar código de barras interno" no cadastro do
produto, cria um código único derivado do próprio id do produto (nunca
colide com outro). Depois, "Imprimir etiqueta" desenha o código
(CODE128, via `jsbarcode`) num canvas oculto do navegador e manda pro
processo principal imprimir — o processo principal do Electron não tem
DOM/canvas pra desenhar sozinho, por isso o desenho acontece no lado da
tela e só a imagem final é enviada pra impressão.

### 6. Relatório de produtos parados
Painel → nova seção, com filtro de 15/30/60/90 dias. Mostra produtos
com estoque (vale a pena vender) mas sem nenhuma venda no período —
complementa o alerta de validade (que só avisa quando já está perto de
vencer). Testado com 4 cenários antes de integrar: produto vendido
recentemente (não aparece), nunca vendido (aparece), vendido há 60 dias
com filtro de 30 (aparece), sem estoque (não aparece mesmo nunca
vendido).

### 7. Lista de cobrança de fiado pendente
Clientes → toggle "Ver só quem deve" — filtra só quem tem saldo
devedor e ordena do maior devedor pro menor, com o total somado no
topo. O backend já calculava o saldo por cliente
(`customerService.listWithSaldo`); só faltava esse jeito de olhar pra
lista pensando em cobrança, não cliente por cliente.

### 8. Atualização automática (prioridade)
`electron-updater`, configurado pra checar o GitHub Releases do
projeto. **Nunca baixa nem instala sozinho sem confirmação** — só avisa
que tem versão nova; verificar e baixar são ações separadas, sempre
com um clique seu. Verifica 1 min depois de abrir o app (não atrasa a
abertura) e depois a cada 4h.

**Passo a passo pra ativar de verdade** (só você consegue fazer, não
tenho acesso à sua conta do GitHub):

1. Crie uma conta no GitHub (github.com) se ainda não tiver.
2. Crie um repositório **novo e PÚBLICO** — sugestão de nome:
   `gerenciaai-releases`. **Precisa ser público mesmo** (não é opcional):
   quando o app já instalado numa máquina qualquer verifica se tem
   atualização, ele faz essa consulta sem nenhuma credencial — só o seu
   `GH_TOKEN` pessoal (usado só na hora de publicar, na sua máquina) tem
   acesso a repositório privado. Repositório privado dá erro 404 na
   verificação, porque o GitHub nem confirma que ele existe pra quem não
   tem permissão. Isso não expõe seu código nem nada sensível — só os
   arquivos do instalador que você decide publicar ali.
3. ~~Trocar owner/repo no package.json~~ — **já feito**, preenchido com
   os dados reais (`arthuraf2013-hue` / `gerenciaai-releases`).
4. Gere um **token de acesso pessoal** no GitHub: Settings → Developer
   settings → Personal access tokens → Tokens (classic) → Generate new
   token (classic) → marque a caixinha **`repo`** → role até o fim e
   clique em **Generate token** (esse clique final é fácil de esquecer).
   Guarde esse token — ele só aparece uma vez.
5. Antes de publicar uma nova versão, defina a variável de ambiente
   `GH_TOKEN` com esse token, **na mesma janela do PowerShell** onde vai
   rodar o publish (a variável não sobrevive se fechar e abrir o
   terminal de novo):
   `$env:GH_TOKEN="seu_token_aqui"`
6. Suba a **versão nova** do número em `package.json` (`"version":
   "0.2.0"`, por exemplo — o electron-updater compara esse número pra
   saber se tem atualização).
7. Rode `npm run build:electron` normalmente, depois publique com:
   `npx electron-builder --publish always`
   Isso builda o instalador **e** sobe ele pro GitHub Releases
   automaticamente, com os arquivos que o electron-updater precisa
   (`latest.yml` + o instalador).
8. Os PDVs com uma versão mais antiga instalada vão detectar a
   atualização sozinhos na próxima verificação (ou clicando em
   "Verificar atualização" em Configurações).

Repita os passos 6-7 a cada nova versão que você quiser distribuir.

**Pegadinha real que já aconteceu**: por padrão o electron-builder cria
a release do GitHub como **rascunho** (draft) — invisível pro app
verificar até alguém publicar manualmente na página do GitHub. Corrigi
isso com `"releaseType": "release"` no `package.json` (faz a release já
sair publicada direto, sem esse passo manual). **Atenção**: o campo
`"draft": false` que eu tinha usado antes **não existe** na versão
24.13.3 do electron-builder — dá erro de configuração inválida. O campo
certo nessa versão é `releaseType`.

Antes desse setup todo, a tela de atualização mostra um erro
mencionando "owner"/"repo" — é esperado, só significa que a publicação
ainda não foi configurada. Repositório **privado** também dá erro (404)
— precisa ser público, o app instalado não tem credencial pra acessar
um repositório privado.

## Busca de produtos mostrando resultado errado (condição de corrida)

Bug real reportado em uso: buscar por código de barras mostrava o
contador certo ("1 no total") mas a lista embaixo continuava mostrando
produtos sem nenhuma relação com a busca.

**Causa**: cada letra digitada dispara uma nova busca; como cada uma é
uma chamada assíncrona independente, não há garantia de que a resposta
chegue na mesma ordem em que foi disparada — uma busca mais antiga
(por exemplo, de quando só tinha sido digitado "7") podia demorar mais
pra responder e chegar **depois** de uma busca mais recente já ter
mostrado o resultado certo, sobrescrevendo a tela com o resultado
errado (mais antigo).

**Correção**: cada chamada de busca agora carrega um número sequencial
próprio; ao voltar, a resposta só é aplicada na tela se esse número
ainda for o mais recente disparado — qualquer resposta de uma busca já
"ultrapassada" é silenciosamente descartada. Testado isoladamente
simulando o cenário exato (uma busca mais lenta disparada primeiro,
uma mais rápida disparada depois) — confirma que só o resultado da
busca mais recente aparece na tela, mesmo com a mais antiga respondendo
por último.

## Total de produtos cadastrados na tela de Produtos

Como a tela usa rolagem infinita (60 por vez), o número total nunca
aparecia em lugar nenhum. Adicionei uma consulta separada só de
contagem (`productService.count`, mesmo filtro de busca/categoria do
`list`) — mostrado ao lado do título ("Produtos (137 no total)"),
atualiza junto quando você busca por nome/SKU. Testado com produto
excluído (não conta) e filtro de categoria/busca antes de integrar.

## Publicação automática (GitHub Actions)

Pedido de automatizar o **seu** lado do processo de atualização — builda
e publica sozinho, sem precisar rodar `$env:GH_TOKEN=...` e
`electron-builder --publish always` manualmente toda vez. **Isso não
muda nada no PDV do cliente** — só facilita como você distribui uma
versão nova.

Como funciona: `.github/workflows/release.yml` roda sozinho sempre que
você envia uma **tag de versão** (ex: `v0.4.0`) pro repositório — builda
numa máquina Windows de verdade (necessário pro instalador NSIS e pro
binário nativo do `better-sqlite3`), e publica a release automaticamente.
Usa o token automático do próprio GitHub Actions — você não precisa mais
do seu token pessoal pra esse fluxo (só continua precisando dele se
publicar manualmente da sua máquina, como antes).

### Passo a passo pra ativar (só você consegue fazer)

**1. Colocar o código-fonte no mesmo repositório usado pros releases.**
Hoje o `gerenciaai-releases` só guarda os instaladores publicados — o
código em si nunca foi enviado pro GitHub. Na pasta do projeto:
```powershell
cd C:\Users\DEFINITECH\Desktop\gerenciaai
git init
git add .
git commit -m "Código fonte do GerenciaAI"
git branch -M main
git remote add origin https://github.com/arthuraf2013-hue/gerenciaai-releases.git
git push -u origin main
```
(Se pedir usuário/senha e der erro de autenticação, use o mesmo token de
acesso pessoal que você já tem, no lugar da senha.)

**2. Publicar uma versão nova, dali em diante, é só:**
```powershell
# 1. Suba o número em package.json (ex: "version": "0.4.0")
git add package.json
git commit -m "Versão 0.4.0"
git push
git tag v0.4.0
git push origin v0.4.0
```
O último `git push origin v0.4.0` é o que dispara o GitHub Actions —
depois disso, é só acompanhar em
`github.com/arthuraf2013-hue/gerenciaai-releases/actions` (a aba
"Actions" do repositório) até aparecer o ✓ verde. A release nova aparece
sozinha em Releases, já publicada (sem passar por rascunho).

**Importante**: o número da tag (`v0.4.0`) precisa bater exatamente com
o `"version"` do `package.json` daquele commit — se não bater,
electron-builder pode publicar com o nome errado.

Validei a sintaxe do YAML antes de entregar, mas não consigo testar o
workflow rodando de verdade (precisa de um repositório real do GitHub
com Actions habilitado, que não tenho acesso aqui) — o primeiro teste de
verdade é você mandar uma tag e acompanhar se o job passa.

## Balão do tour cobrindo o próprio elemento que explica

Bug real reportado em uso: no passo "IA tutora", o balão aparecia
literalmente em cima do robô que ele estava descrevendo — o usuário
não conseguia ver a que ícone o texto se referia.

**Causa**: a lógica só sabia posicionar "embaixo" do elemento; quando
não cabia (elemento perto da borda da tela, como o robô fixo no canto
inferior direito), ela só encolhia a posição pra caber na tela, sem
nunca tentar outro lado — o resultado ficava em cima do próprio alvo.

**Correção**: agora tenta embaixo primeiro (mais natural), depois
acima, depois nas laterais — só centraliza na tela como último recurso,
se genuinamente não couber em nenhum lado sem cobrir o elemento.
Testado com três cenários antes de integrar: elemento no canto inferior
direito (o caso que quebrou), elemento no topo da tela, e um passo de
texto longo perto do fundo — confirma que nunca mais sobrepõe o alvo.

## Balão do tour saindo da tela

Bug real reportado em uso: ao atualizar os textos de alguns passos do
tour (o de Pagamento ficou bem mais longo, mencionando fidelidade e
desconto de gerente), o balão passou a vazar pra fora da tela em
alguns passos.

**Causa**: o cálculo de posição usava uma altura **fixa chutada**
(210px) pra decidir se cabia embaixo do elemento apontado — funcionava
bem enquanto todos os textos eram curtos, mas quebrou assim que um
passo ficou mais alto que esse valor.

**Correção**: agora mede a altura de verdade do balão a cada passo
(`getBoundingClientRect`) e usa esse valor real no cálculo, com limite
tanto por cima quanto por baixo da tela. Também adicionei uma trava de
segurança no CSS (altura máxima + rolagem), caso um texto futuro seja
maior que a tela toda.

## Ícone da IA tutora e botões de atualização maiores

- **Ícone do robô** — você mandou a imagem de referência (robô fofo,
  cabeça com antena e bolinha rosa, tela amarela com carinha, coração
  no peito) que estava pendente desde a implementação da IA tutora.
  Desenhei uma versão original em SVG inspirada nela (não uso a imagem
  enviada diretamente — é um desenho novo, nas mesmas cores e no mesmo
  espírito). Renderizei e conferi tanto ampliado quanto no tamanho real
  do botão (56px) antes de integrar, pra garantir que continua legível
  pequeno.
- **Botões de atualização com área de clique maior** — mais
  preenchimento, altura e largura mínimas, e o texto centralizado
  ocupando o botão inteiro — clicar em qualquer parte do botão
  (não só exatamente em cima do texto) funciona agora.

## Tour guiado e apresentação de treinamento atualizados

Estavam desatualizados desde a rodada de abastecimento, preferências
do PDV e ferramentas de gestão — nenhum dos dois mencionava nada disso.

- **Tour guiado** (botão "?" no PDV): textos do carrinho e pagamento
  atualizados (alerta colorido, cliente/fidelidade, desconto de
  gerente), + 2 passos novos (IA tutora, botão de treinamento). Corrigi
  de passagem um problema pequeno: os botões "?" e "🎓" dividiam a
  mesma classe CSS — o tour não conseguia mirar no botão de treinamento
  especificamente porque `querySelector` sempre pegava o primeiro.
- **Apresentação de treinamento** (botão "🎓"): de 16 para **19 slides**
  — 3 novos (Preferências do PDV, Abastecimento, Ferramentas de gestão
  pra gerente/admin) + textos atualizados em Pagamento/Cliente. Troquei
  alguns ícones por letras simples (ex: "AU", "PF", "BK") em vez de
  símbolos Unicode incomuns, depois de reconsiderar o risco desses
  glifos não renderizarem na fonte usada — mesmo padrão já testado com
  sucesso no círculo "IA" das versões anteriores.

Passou pelo QA de sempre: conteúdo (`markitdown` + checagem de
placeholder), arquivo (`validate.py` — passou limpo) e visual (conferi
os 3 slides novos e o de título).

## Rodapé da barra lateral reorganizado

Antes era uma pilha solta: número do PDV, botão de tema, nome do
usuário em texto simples, "Sair" como link sublinhado avulso. Agora:

- **Avatar com a inicial do nome** + nome/cargo agrupados visualmente.
- **"Sair" com o mesmo tratamento do botão de tema** (sem sublinhado,
  com ícone) — antes era o único botão do rodapé que destoava, ainda
  sublinhado.
- Os dois botões de ação (tema e sair) agrupados numa seção própria,
  separados da informação do usuário.

## Modo escuro — correções de visibilidade

Três problemas reais reportados em uso:

1. **Caixas de busca com fundo branco no modo escuro** (o bug mais sério
   — o estilo global de `input`/`select` nunca definia `background` nem
   `color`, então caía no branco padrão do navegador em vez de seguir o
   tema. Também não existia estilo de foco customizado, por isso o
   contorno amarelo/dourado ao clicar num campo era o padrão do Chromium,
   não algo do app. Os dois corrigidos — inputs, selects e textareas
   agora seguem a mesma paleta do tema, com foco na cor primária do app.
2. **Botão de alternar tema sublinhado, com emoji** — trocado por um
   botão de verdade (sem sublinhado), com ícone em SVG simples (sol/lua
   desenhados, não emoji).
3. **Contraste geral baixo** — paleta escura ajustada: superfícies mais
   destacadas do fundo, bordas mais visíveis, texto secundário mais
   claro.

## Cadastrar produto novo direto no Abastecimento

Quando uma linha da nota não casa com nenhum produto existente, agora
dá pra **cadastrar ali mesmo**, sem sair da tela — botão "+ Cadastrar
novo produto" aparece quando a linha ainda está sem produto vinculado.
Reaproveita a mesma tela de cadastro de produto (`ProductForm`) que já
existia, com nome, código da nota (como SKU) e preço unitário da nota
(como custo) já pré-preenchidos — só falta ajustar o preço de venda
(que começa igual ao custo, de propósito, pra ficar óbvio que precisa
mudar antes de vender). Depois de salvar, o produto já fica vinculado
naquela linha, pronto pra confirmar a entrada.

Continua existindo a opção de **vincular a um produto já existente**
(buscando pelo nome, como já era antes) — as duas opções convivem lado
a lado.

Corrigi de passagem um bug pequeno que essa mudança expôs: o campo de
busca de produto de cada linha só atualizava o texto mostrado quando o
próprio usuário escolhia um resultado — se o produto fosse definido de
fora (como agora acontece ao cadastrar um novo), o texto ficava
desatualizado. Sincronizado.

## Auditoria pós-abastecimento + teste do módulo de abastecimento

Pedido de testar o módulo de abastecimento "de verdade" e fazer uma nova
auditoria geral. Não consigo chamar a API do Gemini de verdade neste
ambiente (sem internet), mas testei a fundo a lógica que dava pra testar
sem isso — e achei um bug crítico:

- **Números com vírgula decimal (formato brasileiro) vinham 100x
  errados na importação de CSV/Excel** — "R$ 15,35" virava 1535. O
  SheetJS, sem `raw: false` no `sheet_to_json`, tentava "adivinhar" o
  número sozinho e interpretava a vírgula errado. Corrigido com um
  parser próprio (`parseNumeroBR`) que entende os dois formatos —
  testado com os valores exatos da nota real que você mandou
  (Atorvastatina R$15,35, Rosuvastatina R$2,10 × 50 = R$105,00) antes e
  depois da correção. Reforcei a mesma regra no prompt da IA (pra
  foto/PDF), já que a mesma ambiguidade podia confundir o modelo.
- Tela de Auditoria e tela de Devolução usavam o relógio cru do sistema
  em vez do relógio sincronizado com a internet — inconsistente com
  Painel e Histórico, que já usam o sincronizado. Corrigido nas duas.
- Bug de React na tela de Abastecimento: as linhas da tabela usavam a
  posição no array como identificador — remover uma linha no meio podia
  fazer o campo de busca de produto de outra linha mostrar o valor
  errado (chave instável numa lista editável). Corrigido com um
  identificador estável por linha, gerado na hora da extração.

## Perfis de negócio prontos (10 no total)

Pedido de preparar perfis pra outros tipos de comércio, pra só escolher
na hora de implementar em vez de configurar campo por campo. Reaproveita
a mesma arquitetura de perfis que já existia (Configurações → Perfis de
negócio) — os novos são só mais linhas na mesma tabela.

| Perfil | Campos extras | Alerta de validade |
|---|---|---|
| Farmácia | lote, validade, princípio ativo, controlado, exige receita | 60 / 7 dias |
| Petshop | espécie do animal, peso/volume, validade, exige receita veterinária | 90 / 15 dias |
| Armazém / Mercearia | validade, peso/volume líquido, perecível | 15 / 3 dias |
| Salão de Beleza / Cabelo | validade, uso profissional (não é pra revenda) | 180 / 30 dias |
| Padaria / Confeitaria | validade, peso em gramas | 2 / 1 dia |
| Loja de Roupas | tamanho, cor | sem alerta de validade |
| Ótica | grau da lente, tipo de lente | sem alerta de validade |
| Material de Construção | garantia em meses | sem alerta de validade |
| Papelaria | (nenhum campo extra) | sem alerta de validade |
| Genérico | (nenhum campo extra) | sem alerta de validade |

Os limiares de dias de cada um são só um ponto de partida sensato pro
tipo de comércio (padaria vence rápido, cosmético de salão dura meses)
— editável a qualquer momento pela própria tela, sem precisar mexer em
código.

**Importante sobre como isso aparece pra você**: os perfis são
adicionados **um por um, só se ainda não existir** — isso significa que
mesmo numa instalação que já está rodando hoje (como a do seu cliente
farmácia), os 8 novos perfis vão aparecer sozinhos na próxima abertura
do app, sem apagar nem duplicar o que já existe. Testei os dois
cenários (instalação nova do zero, e banco já existente só com
Farmácia/Genérico) antes de fechar.

## Diário de bordo: publicando a primeira atualização de verdade

Pra registro — os obstáculos reais que apareceram na primeira publicação
de uma atualização (útil se acontecer de novo, ou pra outra pessoa
seguir o mesmo processo):

1. Repositório de releases **precisa ser público** (privado dá 404 na
   verificação — o app instalado não tem credencial de acesso).
2. Repositório **precisa ter pelo menos um commit** — se estiver
   totalmente vazio, o GitHub não consegue criar a tag da release, e o
   botão "Publish release" fica desabilitado (a página mostra
   `untagged-...` na URL — esse é o sinal). Resolve criando qualquer
   arquivo (um README, por exemplo) direto pela interface do GitHub.
3. Token do GitHub: precisa ir até o final da página e clicar em
   **"Generate token"** — só marcar a caixinha de permissão não é
   suficiente sozinho.
4. A variável `$env:GH_TOKEN` só existe **na mesma janela** do
   PowerShell onde foi definida — some se fechar e abrir o terminal de
   novo.
5. Por padrão o electron-builder cria a release como **rascunho**
   (invisível até publicar manualmente) — corrigido com
   `"releaseType": "release"` no `package.json` (não `"draft": false`,
   que não existe nessa versão e dá erro de configuração inválida),
   então as próximas publicações já saem públicas direto.

## Módulo de abastecimento (leitura de nota de compra + lotes)

Tela nova (Abastecimento) pra dar entrada em mercadoria recebida, lendo a
nota de compra da distribuidora — foto tirada com celular (como a que
você me mandou de exemplo: torta, com anotação à mão por cima, impressa
em impressora térmica/matricial), PDF, ou planilha CSV/Excel.

### Decisão de arquitetura importante
Antes desta rodada, o sistema guardava **um único lote/validade por
produto**. Se eu só sobrescrevesse esse valor a cada reabastecimento,
o lote antigo ainda na prateleira perderia sua validade registrada — o
que destruiria a recomendação de "vender o que vence primeiro" que foi
pedida. Por isso criei uma tabela separada (`product_batches`): cada
entrada de mercadoria vira um lote próprio, com seu próprio validade,
sem apagar os lotes anteriores desse mesmo produto.

**Limitação honesta**: o sistema registra a *quantidade recebida* em
cada lote, mas não rastreia qual lote específico é baixado em cada
venda (isso exigiria escolher o lote item a item no PDV, o que não
existe). A recomendação de venda por validade é uma lista de
**prioridade** (o que vence primeiro deveria ser vendido primeiro), não
um saldo exato de quanto resta de cada lote — o saldo total do produto
continua sendo o mesmo estoque de sempre.

### Como funciona
1. **Anexar nota de compra** → escolhe o arquivo (imagem/PDF/CSV/Excel).
2. **CSV/Excel**: lido direto por um parser estruturado
   (`supplyService.js`), sem gastar IA — tolerante a nomes de coluna
   diferentes entre distribuidoras (compara sem acento/maiúscula: "Cód.
   Prod.", "codigo", "cod_produto" todos batem com o mesmo campo).
   **Achei e corrigi um bug real nesse processo**: ler CSV sem
   especificar `codepage: 65001` (UTF-8) corrompia qualquer acento
   ("Código" virava "Cadigo", "Descrição" virava "Descriaao") — testei
   antes e depois da correção pra confirmar.
3. **PDF/foto**: vai pra IA (Gemini), com um prompt específico pra esse
   tipo de documento — instruído a ignorar anotações feitas à mão
   (checkmarks, círculos, nomes escritos à caneta) e focar só no que
   está impresso.
4. Cada linha extraída já vem com um palpite de produto (busca automática
   pela descrição) — quem está conferindo confirma ou corrige o produto,
   e preenche **lote e validade** (colunas que a nota da distribuidora
   normalmente não traz, por isso são preenchidas manualmente aqui).
5. Confirmar gera um lote (`product_batches`) + a entrada de estoque
   correspondente, pra cada linha.
6. **Recomendação de venda por validade**: lista todos os lotes
   registrados, ordenados por vencimento mais próximo primeiro.

O sistema de alertas existente (ícone no carrinho, tela de Alertas)
também foi atualizado pra usar a validade do lote mais próximo em vez do
campo único antigo — com fallback pro campo antigo pra produtos que
nunca passaram pelo abastecimento (cadastro manual, importação de
planilha de produtos).

Validado: sintaxe completa, schema em SQLite puro (26 tabelas), e um
fluxo de ponta a ponta simulado em SQL — dois lotes do mesmo produto com
validades diferentes, confirmando que o estoque soma certo e a
recomendação ordena pelo lote que vence primeiro.

## Rolagem infinita na tela de Produtos

Antes carregava o catálogo inteiro de uma vez — com muitos produtos
cadastrados, isso ia travar a tela (consulta grande + tabela enorme
renderizada de uma vez).

- `productService.list` ganhou `limit`/`offset` **opcionais** — sem
  passar esses parâmetros, o comportamento continua idêntico ao de
  antes (é assim que a busca do PDV e a grade de categorias continuam
  funcionando, sem paginação, porque já retornam conjuntos pequenos).
- A tela de Produtos carrega 60 por vez. Um `IntersectionObserver`
  observa um marcador invisível logo depois da tabela — quando ele fica
  visível (ou seja, o usuário rolou até perto do fim), carrega o próximo
  lote sozinho e anexa à lista, sem recarregar o que já estava na tela.
- Buscar por nome/SKU reinicia a paginação do zero.
- Testado em SQL puro: 25 produtos, 3 páginas de 10, sem duplicar nem
  pular nenhum.

## Rodada de melhorias (pagamento, auditoria, margem, backup, recibo térmico, consolidado)

Seis pedidos numa lista só — resumo de cada um:

1. **Remover pagamento antes de finalizar** — cada linha de pagamento na
   tela tem "Remover" agora. `saleService.removePayment` só funciona
   enquanto a venda está aberta (mesma regra de sempre).
2. **Tela de Auditoria** (Usuários → Auditoria, só admin) — mostra todo
   cancelamento, devolução e desconto manual da `audit_log`, aprovado ou
   negado, com filtro por período. Índice novo em `audit_log(criado_em)`.
3. **Lucro bruto estimado no Painel** — card + tabela de margem por
   produto. **Limitação deliberada e visível na tela**: usa o custo
   cadastrado *hoje* no produto (`products.custo`), não o custo real de
   quando a venda aconteceu — o sistema não guarda isso por item vendido.
   Se o custo de um produto mudou desde a venda, o número fica
   aproximado. Rastrear custo histórico por venda seria um projeto à
   parte (precisaria "congelar" o custo em `sale_items` no momento da
   venda).
4. **Restaurar backup pela interface** (Configurações → Backup →
   "Restaurar backup") — lista os backups locais, pede confirmação (é
   irreversível), fecha a conexão do SQLite com segurança
   (`database.closeConnection`), sobrescreve o arquivo, limpa os
   resíduos `-wal`/`-shm`, e reinicia o app sozinho (`app.relaunch()`).
5. **Recibo térmico** (Configurações → Recibo) — 58mm, 80mm ou A4.
   Ajusta `@page` CSS e o `pageSize` passado pro diálogo de impressão do
   Electron; fonte um pouco menor no 58mm (cabe menos caractere por
   linha).
6. **Consolidado de vendas entre PDVs** (Painel → "Consultar
   consolidado") — usa o Firebase já configurado na Fase 1 de múltiplos
   PDVs. Ao finalizar uma venda, um resumo (não os itens, não dados de
   cliente) é enviado em segundo plano pro Firestore, best-effort — nunca
   atrasa nem falha a venda local por causa disso.
   **Escopo deliberadamente limitado**: isso é só um espelho de
   *resumo de vendas* pra relatório consolidado — **não sincroniza
   estoque entre terminais**. Sincronizar estoque de verdade entre PDVs
   independentes exigiria um banco compartilhado ou resolução de
   conflitos — um projeto bem mais arriscado, fora do escopo desta
   rodada por decisão consciente (documentado desde a Fase 1).

Validado: sintaxe de todo o backend/frontend, schema aplicado em SQLite
puro (25 tabelas), e a lógica de agregação do consolidado testada
isoladamente (soma por PDV). Não testei a restauração de backup de ponta
a ponta nem a sincronização com Firebase de verdade neste ambiente —
mesma limitação de sempre (sem `better-sqlite3` compilado aqui, sem
internet pra testar contra um projeto Firebase real).

## Data errada em vendas retomadas de um dia pro outro

Bug real reportado em uso: uma venda com carrinho aberto num dia e
finalizada no dia seguinte (usando o "retomar venda aberta") aparecia no
Histórico com a data/hora de quando o carrinho foi **aberto**, não de
quando foi **finalizada** — dava a entender que a venda tinha acontecido
no dia errado.

- `listSalesByRange` agora calcula `COALESCE(finalizada_em, criado_em)`
  como a data de referência — usada no filtro por período, na ordenação
  e na coluna exibida na tela. Corrigido também no relatório exportado
  e nas três consultas do painel de vendas (total do período, vendas por
  dia, produtos mais vendidos), que tinham o mesmo problema.
- Testado em SQL puro com o cenário exato: carrinho aberto às 13:09 de
  um dia, finalizado às 21:58 (UTC) do dia seguinte — antes aparecia no
  dia errado, agora aparece corretamente no dia da finalização.

## Histórico mostrando carrinhos vazios como "venda" + fuso horário inconsistente

Dois bugs reais reportados em uso: o Histórico listava carrinhos abertos
com 0 itens (o rascunho que o sistema cria sozinho ao entrar no PDV,
nunca uma venda de verdade) — e a hora exibida em Histórico, Devolução,
recibo e backup podia ficar diferente do relógio da sidebar.

- **Carrinho vazio no histórico**: `listSalesByRange` agora exclui vendas
  `aberta` sem nenhum item. Carrinho aberto **com** item continua
  aparecendo — o estoque já foi debitado nele (nossa arquitetura baixa o
  estoque na hora de adicionar o item, não só ao finalizar), então vale
  saber que ficou pendente.
- **Fuso horário inconsistente**: o relógio da sidebar sempre forçava
  `America/Sao_Paulo`, mas o resto do app (Histórico, Devolução, recibo
  impresso, status de backup) formatava a hora usando o fuso configurado
  no Windows — se a máquina estivesse com o fuso errado, os dois
  mostravam horas diferentes para o mesmo evento. Agora tudo usa
  explicitamente `timeZone: 'America/Sao_Paulo'`, igual ao relógio.

## Desconto manual autorizado por gerente

Na tela de pagamento, o operador pode solicitar um desconto em reais "a
critério do gerente" — pensado para clientes específicos ou negociações
pontuais, não um desconto de tabela.

- Exige autorização de um gerente/admin diferente do operador (mesmo
  mecanismo já usado em cancelamento/devolução), com motivo opcional e
  rastro em `audit_log`.
- **Separado do desconto de fidelidade** — os dois moram em colunas
  diferentes (`sales.desconto` para fidelidade, `sales.desconto_gerente`
  para o manual) e nunca um sobrescreve o outro; o total a pagar soma os
  dois. Testado com os dois aplicados juntos na mesma venda.
- Nunca deixa a soma dos dois descontos passar do total da venda — cada
  um verifica contra o que resta depois do outro já aplicado.
- Pode ser removido antes de finalizar (ex: operador mudou de ideia),
  sem precisar cancelar a venda inteira.
- Aparece separado do desconto de fidelidade no recibo impresso e no
  relatório do painel de vendas.

## Backup automático do banco

Antes de instalar numa farmácia de verdade, isso era a lacuna mais séria:
não existia nenhuma rotina de backup. Um único arquivo (`gerenciaai.sqlite3`)
guardava tudo — vendas, estoque, clientes, fiado — sem cópia nenhuma.

- **Automático, uma vez por dia** (`electron/services/backupService.js`),
  disparado na abertura do app e verificado de novo a cada 2h (pra farmácias
  que deixam o app aberto o dia inteiro sem reiniciar).
- Usa a **API de backup nativa do SQLite** (`db.backup()` do
  `better-sqlite3`) — não é uma cópia de arquivo comum. Isso importa porque
  o banco roda em modo WAL (melhor performance de escrita), e uma cópia de
  arquivo simples enquanto o app está em uso poderia perder dados recentes
  ainda não gravados no arquivo principal.
- Guarda os últimos 30 dias localmente (`userData/backups/`), com rotação
  automática dos mais antigos.
- **Pasta secundária opcional** (Configurações → Backup) — aponta pra um
  pendrive ou uma pasta sincronizada por nuvem (OneDrive/Google Drive). Sem
  isso configurado, o único lugar onde os dados existem é o próprio
  computador — recomendo fortemente configurar antes de confiar em produção.
- Nunca trava o app: se o backup falhar (pasta secundária desconectada,
  disco cheio, etc.), só registra o erro e a operação normal continua.

**Ainda não implementado, se fizer sentido depois**: restauração de backup
pela própria interface (hoje é manual — trocar o arquivo `.sqlite3` do
`userData` pelo backup escolhido, com o app fechado) e backup para a nuvem
de verdade (upload automático, não só copiar pra uma pasta sincronizada).

## Auditoria de pré-produção (preparação para uso real numa farmácia)

Revisão sistemática de integridade financeira/estoque, segurança e telas
que podiam quebrar — pedida antes de colocar o sistema numa farmácia de
verdade. Resumo do que foi corrigido:

**Integridade financeira/estoque:**
- `cancelSale` não conferia se a venda já estava finalizada — dava pra
  "cancelar" uma venda já paga, sumindo o valor retroativamente do
  cálculo do caixa. Agora só cancela vendas em aberto; venda paga usa
  Devolução.
- Devolução não validava no servidor se a quantidade excedia o vendido
  (ou já devolvido antes) — só existia essa checagem na tela. Agora
  valida de forma acumulada (testado com devoluções parciais).
- `addItem`/`addPayment` não conferiam se a venda ainda estava aberta.
- `redeemLoyaltyPoints` aceitava pontos zero/negativos, gerando desconto
  negativo (cliente pagando mais, não menos).
- Faltava validação de valores negativos no caixa, preço/estoque mínimo
  negativo no produto, nome vazio em cliente/fornecedor.

**Segurança:**
- `changeOwnPin` não aplicava o bloqueio por tentativas que `login` e
  `authorizeManagerOverride` já tinham — dava pra tentar adivinhar o PIN
  de alguém infinitamente por esse caminho específico.
- `resetPin` (admin) agora força troca de PIN no próximo login.

**Telas que quebravam em branco** (mesmo padrão recorrente de sempre —
resposta de erro do IPC sendo tratada como se fosse a lista esperada):
corrigido na tela de login (a mais crítica — travaria o acesso ao app
inteiro), fechamento de caixa, modal de autorização de gerente (usado em
todo cancelamento/devolução), busca de produtos no PDV, anexos de venda.

**Performance:** faltavam índices em `sale_items(sale_id)` e
`payments(sale_id)` — consultados constantemente sem índice. Adicionados
também em `sales` e `products`.

**Funcionalidade órfã:** existia ajuste manual de estoque (entrada de
mercadoria, perda/quebra) pronto no backend mas sem nenhuma tela —
essencial pra farmácia real. Tela criada em Produtos → "Ajustar estoque".

**Inconsistência:** a tela de Alertas calculava crítico/aviso de um jeito
diferente do ícone no carrinho — podiam discordar. Unificados na mesma
função (`stockService.computeProductAlert`).

**Testes:** adicionados casos cobrindo todos os bugs acima em
`/tests` — não rodaram neste ambiente (sem `better-sqlite3` disponível
aqui), revisão de compatibilidade feita manualmente. Rode `npm test` na
sua máquina antes de confiar em produção.

## Rodada grande de funcionalidades (devolução, clientes, fornecedores, testes...)

Validação feita: sintaxe de todo o backend/frontend (`node --check` +
esbuild), schema aplicado com sucesso em SQLite puro (22 tabelas), e um
fluxo completo simulado direto em SQL (venda → fiado → devolução →
dashboard → sugestão de compra) batendo com os valores esperados. Os
testes automatizados (`npm test`) **não rodaram neste ambiente** — sem
binário pré-compilado do `better-sqlite3` disponível aqui — mas devem
rodar normalmente na sua máquina.

- **Devolução pós-venda** (`returnService.js`, tela "Devolução"): busca
  uma venda finalizada, escolhe itens e quantidades, exige autorização de
  gerente (mesmo princípio do cancelamento). Gera entrada de estoque.
- **Segredos criptografados** (`secretsService.js`): chave da API de IA,
  senha do certificado digital e CSC token agora são criptografados com
  `safeStorage` do Electron (cofre do próprio Windows) antes de ir pro
  banco. Se a criptografia do SO não estiver disponível, cai para texto
  puro em vez de travar o app.
- **Testes automatizados** (`/tests`): cobrem o bloqueio de PIN, a regra
  de "nunca autoriza a si mesmo", validação de estoque, estorno em
  cancelamento, fiado exigindo cliente, resgate de pontos, e o cálculo de
  diferença no fechamento de caixa. Rodar com `npm test`.
- **Clientes + fiado real** (tela "Clientes"): cadastro, saldo devedor
  como ledger (nunca edita, só lança movimento), histórico, registro de
  pagamento. Pagamento em "fiado" numa venda agora exige cliente vinculado.
- **Fidelidade**: Configurações → Programa de fidelidade define quantos
  reais valem 1 ponto e quanto cada ponto vale no resgate. Cliente
  vinculado a uma venda finalizada acumula pontos automaticamente; pontos
  podem virar desconto na hora do pagamento.
- **Fornecedores + sugestão de compra** (tela "Fornecedores"): cadastro
  simples + sugestão baseada na velocidade de venda dos últimos 30 dias
  (estatística, sem IA) para produtos no estoque mínimo ou abaixo.
- ~~Notificação desktop nativa~~ — **removida a pedido do Arthur** (era
  intrusiva). Substituída pelo ícone de alerta clicável no carrinho (ver
  seção "Limiares de alerta configuráveis" mais abaixo) — clicar no ícone
  abre um balão com o motivo exato, ao lado do item, sem sair do app.
- **Impressão de recibo** (`printService.js`): botão "Imprimir recibo"
  depois de finalizar a venda, abre o diálogo de impressão nativo do
  sistema com um recibo simples formatado.
- **Painel de vendas** (tela "Painel"): total do período, vendas por dia
  (barras), produtos mais vendidos, devoluções, e um botão de resumo em
  linguagem natural via IA (reaproveita a mesma configuração da extração
  de receitas).

## Múltiplos PDVs — Fase 1: numeração automática por CNPJ (não testado contra Firebase real)

**Aviso importante**: esta é a primeira peça de infraestrutura em nuvem do
GerenciaAI. Todo o código segue a documentação oficial do SDK do Firebase
e foi validado localmente (sintaxe, imports, lógica da transação), mas eu
**não tenho como testar contra um projeto Firebase real** neste ambiente
— sem internet aqui. Teste com atenção antes de confiar em produção.

### O que foi implementado
- `electron/services/pdvRegistryService.js`: registra este PDV no
  Firestore, sob o CNPJ configurado em Fiscal, usando uma **transação
  atômica** — dois PDVs registrando ao mesmo tempo nunca recebem o mesmo
  número. Idempotente: se este PDV já tem número, reabrir o app ou clicar
  em "Registrar" de novo devolve o mesmo número, nunca cria um segundo.
- Cada PDV tem um `device_uid` gerado uma única vez, localmente
  (`locations.device_uid`), independente do Firebase — é a chave que
  garante a idempotência.
- Configurações → Sincronização entre PDVs: cole as credenciais do seu
  projeto Firebase, ative, e clique em "Registrar este PDV".
- O número aparece na sidebar (perto do seu usuário) assim que registrado.
- **Totalmente opcional** — sem configurar nada, o app continua 100%
  local, como sempre foi.

### Checklist no Firebase Console (obrigatório antes de usar)

1. **Criar o projeto**: [console.firebase.google.com](https://console.firebase.google.com) → "Adicionar projeto".
2. **Ativar o Firestore**: menu lateral → Firestore Database → "Criar banco de dados" → modo produção.
3. **Ativar autenticação anônima**: Authentication → Sign-in method → ative "Anônimo". O app usa isso só para ter uma identidade estável nas regras de segurança — não pede login nenhum ao operador.
4. **Pegar as credenciais**: Configurações do projeto (engrenagem) → Geral → role até "Seus apps" → "</> Web" → registre um app → copie `apiKey`, `authDomain`, `projectId`, `appId`. Cole esses 4 valores em Configurações → Sincronização no GerenciaAI.
5. **Configurar as regras de segurança do Firestore** (Firestore Database → Regras) — sem isso, o banco fica aberto para qualquer um escrever:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /cnpjs/{cnpj} {
      allow read: if request.auth != null;
      allow write: if request.auth != null
                   && request.resource.data.keys().hasOnly(['proximoNumero'])
                   && request.resource.data.proximoNumero is int;

      match /pdvs/{pdvId} {
        allow read: if request.auth != null;
        allow create: if request.auth != null
                      && request.resource.data.keys().hasAll(['numero', 'nomeLocal', 'registradoEm']);
        allow update, delete: if false; // um PDV registrado nunca é reescrito nem apagado pelo app
      }
    }
  }
}
```

6. Teste em **dois computadores diferentes** (ou dois perfis do app) com o
   mesmo CNPJ antes de confiar isso numa loja de verdade — confirme que
   viram PDV001 e PDV002, não os dois PDV001.

### O que fica pra depois (Fase 2, se você decidir seguir)
Descoberta entre PDVs pela rede local (mDNS), como conversamos — só faz
sentido avaliar depois que a Fase 1 estiver rodando de verdade numa loja.

## Fiscal (NFC-e) — fundação pronta, emissão real pendente

**Importante: a emissão de NFC-e NÃO está implementada.** O que existe hoje
é a fundação para quando ela puder ser desenvolvida de verdade:

- **Configurações → Fiscal**: CNPJ, Inscrição Estadual, razão social,
  regime tributário, UF, ambiente (homologação/produção), caminho do
  certificado digital, CSC — tudo fica guardado em `fiscal_config`.
- **Cadastro de produto**: campos NCM, CEST, CFOP, CST/CSOSN, origem da
  mercadoria — opcionais, sem exigir nada até a emissão estar ativa.
- **`electron/services/fiscalService.js`**: valida se a configuração está
  completa e, se estiver, explica claramente que a assinatura/transmissão
  do XML ainda não foi implementada — nunca finge que emitiu uma nota.
- **`nfce_emitidas`**: tabela pronta para registrar o rastro de cada
  emissão (número, série, chave de acesso, protocolo, status) assim que a
  emissão real existir.
- No PDV, depois de finalizar uma venda, tem um botão opcional "Emitir
  NFC-e" — hoje ele sempre volta a mensagem de "ainda não implementado",
  mas a venda em si nunca depende disso para ser concluída.

### Por que não fingir que funciona
Gerar uma NFC-e de verdade exige assinar o XML com o certificado digital,
montar o layout exato (4.00) que a SEFAZ do estado exige, transmitir para
o webservice certo, tratar autorização/rejeição/contingência, e gerar o
QR Code com o CSC do estado. Simular isso sem testar contra o ambiente de
homologação real geraria documentos fiscais tecnicamente inválidos — um
risco real para quem for usar o sistema. Por isso o `fiscalService`
valida e explica, mas não emite.

### O que falta para implementar de verdade
1. **Ter CNPJ com Inscrição Estadual ativa e certificado digital (A1 ou
   A3)** — pré-requisito de negócio, não de código.
2. Decidir o caminho técnico:
   - **API paga de terceiros** (Focus NFe, eNotas, TecnoSpeed): muito mais
     rápido de integrar (REST simples, eles cuidam da assinatura/SEFAZ),
     tem mensalidade.
   - **Integração direta com a SEFAZ** (caminho escolhido): sem
     mensalidade, mas exige assinar XML (ex: `node-forge` ou `xml-crypto`
     para assinatura digital), montar o XML no layout da NFC-e, descobrir
     o webservice certo pro estado (muitos estados menores usam o SVRS —
     SEFAZ Virtual do RS — em vez de webservice próprio), e testar tudo
     no **ambiente de homologação** antes de cogitar produção.
3. Gerar a chave de acesso (regra de 44 dígitos por estado/CNPJ/modelo/
   série/número/data/código numérico + dígito verificador).
4. Implementar contingência (o que fazer quando a SEFAZ está fora do ar —
   normalmente EPEC ou emissão em contingência offline).
5. Impressão do DANFE NFC-e (o cupom que vai para o cliente) — impressora
   térmica ESC/POS ou impressão comum em PDF.
6. Depois disso, considerar SPED Fiscal para a contabilidade — mas isso
   já é mais responsabilidade do contador do que do próprio app.

## Melhorias aplicadas automaticamente (última rodada)

1. **Abertura e fechamento de caixa**: o PDV agora exige uma sessão de
   caixa aberta para o local antes de qualquer venda. Ao abrir, o
   operador informa quanto tem em dinheiro; ao fechar (botão "Fechar
   caixa" no cabeçalho do PDV), o sistema mostra o valor esperado por
   método de pagamento (calculado a partir de `payments`/`sales` desde a
   abertura) e a diferença contra o valor contado. Tudo em
   `cashService.js` / tabela `cash_sessions`.
2. **Bloqueio por tentativas de PIN erradas**: depois de 5 tentativas
   erradas seguidas (seja no login, seja na autorização de gerente para
   cancelamento), o usuário fica bloqueado por 10 minutos. Aplica-se aos
   dois pontos de entrada de PIN do sistema (`authService.login` e
   `authorizeManagerOverride`), já que ambos são alvo possível de força
   bruta.

### Adição automática dos medicamentos da receita ao carrinho
Depois que a IA extrai os medicamentos de uma receita anexada
(`sale_attachments.extracao_json.medicamentos`), o PDV busca cada nome no
catálogo (mesma busca por nome/SKU/código de barras da busca manual) e:
- **Encontrado + com estoque** → adiciona ao carrinho automaticamente.
- **Encontrado mas sem estoque suficiente** → não adiciona, entra num aviso.
- **Não encontrado no catálogo** → não adiciona, entra num aviso.

Um único aviso resume tudo no final (`POSScreen.addProductsFromPrescription`),
sem travar a venda em nenhum dos casos. A correspondência é simples (o
primeiro resultado da busca por nome) — não é um match "inteligente" via
IA, então nomes muito parecidos entre produtos diferentes podem escolher
o item errado; vale conferir o carrinho depois de uma extração.

## IA — leitura automática de anexos (implementado)

A primeira automação de IA do GerenciaAI está pronta: **extração de dados de
receitas/notas anexadas**, usando a Gemini Developer API diretamente
(chamada HTTP simples do processo principal — sem precisar configurar um
projeto Firebase completo nem o App Check, que é mais voltado a apps
móveis/web públicos do que a um desktop app local como este).

### Como configurar
1. Gere uma chave gratuita em [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Vá em **Configurações → IA (opcional)**, cole a chave, ative e salve.
   A chave fica guardada só no SQLite local (`ai_settings`), nunca sai da
   máquina exceto para chamar a própria API do Google.
3. No PDV, abra **Anexar receita/arquivo**, anexe uma imagem ou PDF, e
   clique em **"Extrair dados com IA"** no anexo.

### Como funciona
- 100% sob demanda — nada roda automaticamente, nada bloqueia a venda.
- `aiService.extractAttachment` lê o arquivo, envia para o modelo Gemini
  (multimodal: aceita imagem e PDF) pedindo um JSON estruturado
  (`medico`, `crm`, `numeroReceita`, `dataReceita`, `medicamentos`,
  `observacoes`) e grava o resultado em `sale_attachments.extracao_json`.
- A UI deixa claro que é uma **sugestão da IA para conferir**, não um dado
  validado — erros de leitura (letra ruim, foto tremida) podem acontecer.
- Falhas (sem internet, chave inválida, limite de uso) retornam mensagens
  específicas em vez de travar a tela.

### Por que Gemini direto em vez de Firebase AI Logic
O Firebase AI Logic é voltado a apps móveis/web com Firebase App Check
(proteção contra abuso via Play Integrity, etc.), o que não se aplica bem a
um app desktop Electron de uso local. Chamar a Gemini Developer API
diretamente do processo principal é mais simples aqui e usa a mesma chave/
camada gratuita. Se no futuro o GerenciaAI ganhar sincronização via
Firebase (como o Bolso Certo), reavaliar a migração faz sentido.

### Próximas automações de IA sugeridas (ainda não implementadas)
1. **Sugestão de reposição de estoque** a partir do histórico de vendas.
2. **Categorização automática** de produtos ao importar planilha.
3. **Resumos em linguagem natural** do histórico de vendas.
4. **Assistente de suporte contextual** para o operador.

Automação que **não depende de IA** e já dá pra priorizar antes disso:
- Backup automático agendado do SQLite.
- Notificações desktop nativas quando o estoque ficar baixo.
- Geração automática de relatório de fechamento do dia.

## Roadmap estrutural (fora do escopo de IA)

1. **Motor de sincronização** (`/electron/services/syncService.js`): fila de
   `stock_movements`/`sales` não sincronizados, push em background quando
   houver internet — o ledger já foi desenhado pensando nisso.
2. **Rastreamento de validade por lote** (hoje validade é 1 valor por
   produto; para farmácias com lotes múltiplos do mesmo item, vale mover
   isso para uma tabela `product_batches`).
3. **Multi-loja de fato**: hoje `location_id` já existe em tudo, falta a
   tela de seleção/criação de lojas quando houver mais de uma.
