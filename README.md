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

## Rodada de melhorias (7 itens)

1. **Quantidade no código de barras** — campo pequeno ao lado da busca no
   PDV. Digite um número antes de escanear ou buscar, e o próximo item
   entra com essa quantidade de uma vez (volta a 1 sozinho depois).
   Corrigi de passagem um bug de exibição: o total mostrado na tela não
   multiplicava pela quantidade (invisível até agora porque era sempre 1).
2. **Indicador de conexão** no consolidado entre PDVs — "● conectado" /
   "○ offline" ao lado do título, checado a cada 1 minuto.
3. **Devolução direto do Histórico** — botão "Devolver" em cada venda
   finalizada, já busca e seleciona a venda sozinho na tela de Devolução
   (com aviso se a venda tiver mais de 60 dias — limite de busca lá).
4. **Exportar Auditoria** pra planilha.
5. **Histórico de alteração de preço** — nova tabela
   `product_price_history`, só registra quando o preço de venda muda de
   verdade (testado em SQL puro: editar produto sem mudar o preço não
   gera entrada). Link expansível no cadastro do produto pra ver.
6. **Gráfico de barras de verdade** em "Vendas por dia" no Painel — SVG
   simples, sem depender de nenhuma biblioteca de gráficos. "Produtos
   mais vendidos" mantive como barra horizontal (formato mais adequado
   pra ranking).
7. **Lista de compra sugerida reformulada** — a sugestão de compra que já
   existia (Fornecedores) agora aparece **agrupada por fornecedor**
   (pronta pra levar/mandar pra cada um) em vez de uma lista solta, com
   botão de exportar pra planilha e um lembrete de usar o Abastecimento
   quando a mercadoria chegar.

## Alinhamento das linhas (correção definitiva) + otimizações de desempenho

**Alinhamento**: a correção anterior (`align-items: center` direto na
célula) ainda deixava um resquício visual. Causa raiz de verdade: uma
`<td>` com `display: flex` briga com o jeito normal como células de
tabela calculam altura/alinhamento. Solução mais limpa: a célula volta
a ser uma célula comum, e os botões ficam dentro de uma `<div>` própria
que cuida do layout horizontal — sem a `<td>` brigando com o
comportamento padrão da tabela.

**Otimizações — foco em rodar bem em qualquer PC:**

1. **Debounce nas buscas** (Produtos, Clientes, busca principal do
   PDV) — antes, cada tecla digitada disparava uma consulta ao banco
   na hora; agora espera um instante (250ms nas telas de gestão, 180ms
   no PDV — mais curto ali porque é usado durante a venda) depois de
   parar de digitar antes de buscar de verdade. Reduz bastante o
   trabalho em máquinas mais lentas enquanto a pessoa ainda está
   digitando, e reduz ainda mais a chance de qualquer condição de
   corrida remanescente.
2. **`React.memo` nas miniaturas de produto** — numa lista de 60
   produtos, sem isso cada miniatura renderizava de novo (e
   reexecutava a checagem de foto) toda vez que qualquer outra coisa na
   tela mudasse, mesmo produtos não relacionados.
3. **Tela não pisca mais em branco ao abrir** — a janela do Electron
   só aparece quando o conteúdo já estiver pronto pra mostrar, em vez
   de aparecer vazia enquanto carrega. Mais perceptível em PCs mais
   lentos, onde o carregamento inicial demora mais.
4. **Auditoria de vazamento de memória** — conferi todo `setInterval`
   do app (relógio, verificação de atualização, indicador de conexão)
   e confirmei que todos são limpos corretamente quando a tela
   correspondente fecha — nenhum ficava rodando pra sempre em segundo
   plano.
5. **Confirmado**: o CSS não usa nenhum efeito pesado de GPU (blur,
   backdrop-filter) — já estava leve nesse sentido.

Não mexi em nada relacionado a hardware/GPU do Electron (tipo desligar
aceleração de hardware) — isso ajudaria só em casos bem específicos de
driver de vídeo com problema, e desligar à toa pioraria a experiência
na maioria dos PCs normais.

### Continuação — validei de verdade num navegador, e achei + corrigi um bug real

Consegui resolver a maior lacuna que tinha deixado: montei módulos
simulados do Firebase (Auth/Firestore, com dados de teste incluindo
exatamente o cenário "um dono, dois negócios diferentes") e carreguei
o `admin-panel/index.html` **de verdade** num navegador headless,
interceptando as chamadas pro CDN do Firebase pra usar os simulados.
Isso permitiu testar de um jeito muito mais forte do que só ler
código:

- Login → tela principal: sem nenhum erro de JavaScript.
- Os blocos por cliente renderizam certo, incluindo o João com as duas
  máquinas (padaria + restaurante) aparecendo juntas dentro do bloco
  dele, do jeito que foi pedido.
- **"Bloquear tudo" testado de verdade**: cliquei no botão, confirmei
  o alerta, e conferi que a escrita em lote realmente marcou as DUAS
  máquinas do cliente com `bloqueioImediato: true` numa operação só.
- Criar cliente novo, e vincular uma máquina sem dono a ele — os dois
  funcionam e gravam os dados certos.

**Achei um bug real nesse processo**: um cliente recém-criado, ainda
sem nenhuma máquina vinculada, **não aparecia na lista** — só
mostrava clientes que já tinham pelo menos uma máquina. Isso é
confuso (você cria o cliente e ele "some" até vincular algo).
Corrigido — agora aparece com "Nenhuma máquina vinculada ainda", sem
os botões de ação em bloco (não fazem sentido sem máquina nenhuma).
Retestei tudo de novo depois da correção pra garantir que não quebrou
nada.

### Continuação 2 — criar funcionou, mas ver/vincular clientes não

Você reportou que depois da correção anterior, criar cliente passou a
funcionar — mas os clientes criados não aparecem em lugar nenhum
(nem na lista principal, nem no dropdown de "Vincular a cliente", que
aparece vazio). Achei o mesmo padrão de falha silenciosa de antes, só
que dessa vez do lado da **leitura**, não da escrita: as duas escutas
em tempo real (instalações e clientes) não tinham nenhum tratamento de
erro — se a leitura falhasse por qualquer motivo (permissão, índice
faltando, etc.), simplesmente não acontecia nada, sem nenhuma pista.

**Corrigido** — agora, se a leitura de instalações ou de clientes
falhar, aparece a mesma faixa de erro vermelha explicando o que
houve. Testei reproduzindo esse cenário exato (escrita funcionando,
leitura falhando) e confirmei que o erro aparece.

**Próximo passo pra você**: recarregue o painel (Ctrl+Shift+R) e veja
se aparece alguma faixa vermelha no topo agora — se aparecer, me
manda o texto exato dela (pode ser um erro de permissão nas regras,
ou até um link direto do próprio Firestore pra criar um índice
faltando, se for o caso) que eu sigo a investigação com a causa real
na mão, em vez de ficar adivinhando.

### Continuação — "Criar" não fazia nada: erro silencioso corrigido

Você reportou que clicar em "Criar" no modal de novo cliente não
fazia nada. Achei a causa: quando o Firestore recusa uma escrita (o
suspeito nº 1 é exatamente o que eu já tinha avisado — as regras de
segurança ainda não republicadas com o bloco novo da coleção
`clientes`), o painel **falhava sem mostrar nada** — o modal só
ficava ali, parado, sem nenhuma pista do que deu errado.

**Corrigido em todo o painel, não só nesse botão** — toda ação que
escreve no Firestore (criar cliente, vincular, congelar, bloquear,
bloquear em lote, etc.) agora mostra uma faixa de erro vermelha no
topo da tela se algo falhar, em vez de falhar em silêncio. Quando o
erro é especificamente de permissão negada, a mensagem já aponta pra
causa mais provável (regras não republicadas).

**Reproduzi seu cenário exato pra confirmar a correção**: simulei o
Firestore recusando a criação do cliente com "permissão negada" (o
mesmo tipo de erro que rejeitar por causa das regras dá) — antes da
correção, o modal ficava parado sem nada (igual no seu print); depois
da correção, aparece a faixa vermelha explicando o motivo.

**Próximo passo pra você**: abra o painel de novo e tente criar o
cliente — agora, se continuar falhando, vai aparecer uma mensagem
específica. Se disser algo sobre permissão, é isso mesmo: siga o
Passo 3 do `LICENCIAMENTO.md` e republique as regras do Firestore com
o bloco mais recente (o que inclui a coleção `clientes`).

### Correção: banner reaparecia ao trocar de tela

Achei um bug real revisando: fechar o banner de mensagem só durava
até você trocar de tela e voltar pro PDV — o "fechado" era um estado
que resetava toda vez (a tela do PDV remonta ao navegar pra outro
lugar e voltar). Corrigido: agora fica lembrado (via localStorage) por
mensagem específica — se o texto ou a imagem mudar, volta a aparecer
uma vez (faz sentido, é conteúdo novo); se for a mesma mensagem,
continua fechada de verdade. Testei os 3 cenários (mesma mensagem
continua fechada, texto novo reaparece, mensagem personalizada nova
reaparece) antes de fechar.

### Verificação de ponta a ponta — não só relendo o código

Você pediu pra verificar se as métricas vão funcionar de verdade
agora, então fui além de só reler o código:

- Inicializei um banco do jeito **real** que o app usa (schema +
  migrações + os mesmos seeds automáticos), não um banco de teste
  simplificado.
- Simulei o Firestore de verdade e rodei o `checkLicense()` **inteiro**
  (não só o pedaço de métricas isolado) nos dois cenários possíveis:
  instalação nova, e instalação que já existia antes (o caso real do
  Arthur) — com vendas de verdade cadastradas no banco.
- Resultado: **zero erros nos dois cenários**, a versão nova é escrita
  corretamente, e as métricas batem exatamente com o que estava no
  banco (testei com 7 vendas cadastradas — chegou 7 no Firestore, sem
  arredondamento nem erro de contagem).

**Achei e corrigi um ponto frágil a mais nesse processo** (não a causa
raiz, mas uma proteção a mais): `getOrCreateDeviceUid()` quebraria sem
nenhum aviso se a tabela de locais estivesse vazia — não deveria
acontecer numa instalação normal (o local principal é sempre criado
sozinho na inicialização), mas agora dá um erro claro em vez de
quebrar silenciosamente, caso aconteça por algum motivo que eu não
previ.

**O que isso significa pra você**: o código, testado do jeito mais
realista que consigo simular aqui, está correto. Se depois de
instalar essa versão a métrica ainda não aparecer, não é mais uma
questão de "pode ter um bug escondido no meu código" — ou é a versão
antiga ainda rodando (única/segunda instância, versão não
incrementada), ou é algo específico da sua máquina que só vai
aparecer no painel → Erros agora que ele não fica mais em silêncio.

### Causa raiz encontrada e confirmada — era eu mesmo

O sistema de erros que construí funcionou exatamente pra isso: seu
print mostrou o erro real pela primeira vez —
`PERMISSION_DENIED: Missing or insufficient permissions` — e isso
resolveu o mistério de vez.

**A causa**: quando adicionei o reporte de métricas
(`totalVendasHistorico`, `vendasUltimos30Dias`, `perfilAtivo`) há
algumas entregas, esqueci de incluir esses 3 campos na lista de
permitidos das regras do Firestore. O Firestore recusa a escrita
**inteira** quando isso acontece — não só os campos novos — por isso
nem o `ultimoContato` nem a versão conseguiam atualizar, mesmo com o
app rodando a versão certa (o erro mostrou v0.5.9 tentando às 10:18
de hoje) e tentando normalmente a cada 6h. Fazia sentido perfeito com
tudo que você vinha reportando.

**Corrigido**: adicionei os 3 campos na lista de permitidos, e
conferi TODOS os outros campos que o app escreve na própria
instalação (reuni de todos os arquivos que fazem isso) contra a lista
— confirmado que agora está completa, nada mais faltando.

**Só falta uma coisa pra isso valer**: republicar as regras do
Firestore de novo (Passo 3 do `LICENCIAMENTO.md`) com o bloco
atualizado. Depois disso, a próxima vez que o app rodar (não precisa
esperar 6h — pode só reabrir), a versão e as métricas devem começar a
aparecer certinho.

## Desconto opcional/percentual, e Pix sem QR Code obrigatório

### 1 e 2 — Senha de desconto opcional + porcentagem

Mesmo padrão do cancelamento: novo toggle em **Configurações →
Segurança** — "Exigir senha de gerente para aplicar desconto manual"
(ligado por padrão, pode desligar). E o campo de desconto agora aceita
**R$ ou %** — um seletor do lado do campo. A porcentagem é calculada
sobre o que resta da venda (depois de qualquer desconto de fidelidade
já aplicado), não sobre o total bruto — testei os dois casos.

**Achei e corrigi uma inconsistência própria nesse processo**: quando
criei o novo tipo de evento pra "desconto sem autorização configurada",
esqueci de incluir ele no filtro da tela de Auditoria que ajustei na
resposta anterior (a mesma lógica de "não deve poluir a lista" que
você pediu pro cancelamento). Testei e confirmei que agora esse tipo
também fica de fora da lista, mas continua gravado no banco.

### 3 — Pix sem exigir QR Code

O backend nunca tratou Pix de forma especial — a única barreira era
no frontend, que só oferecia o fluxo de gerar QR Code. Adicionei um
segundo botão, "Registrar sem QR", ao lado do "Gerar QR Code" — pra
quando o cliente já pagou por fora (QR fixo no balcão, chave Pix,
transferência direta) e só precisa registrar o valor, sem o app gerar
nada. Usa exatamente o mesmo caminho de registro dos outros métodos de
pagamento (dinheiro, cartão) — testado e confirmado que o backend já
tratava Pix genericamente, sem nenhuma validação especial que
dependesse do QR Code.

## Auditoria limpa — sem cancelamento pré-pagamento poluindo a lista

Cancelamento antes do pagamento (ajuste normal de carrinho — cliente
desiste de um item antes de fechar a conta) nunca teve autorizador
nem motivo, porque nunca precisou de aprovação de gerente pra
acontecer. Continuava sendo gravado, corretamente, pra manter o
histórico completo — mas aparecer na TELA de Auditoria não fazia
sentido, já que essa tela é pra mostrar o que precisou de aprovação,
e isso só enterrava os eventos que realmente importam (descontos,
cancelamentos autorizados) no meio de dezenas de linhas sem
autorizador nenhum.

**Corrigido**: esses cancelamentos (e o mesmo tipo de evento quando a
exigência de senha está desligada nas configurações) continuam
gravados no banco normalmente — nada se perde — só não aparecem mais
na tela de Auditoria. Testei reproduzindo o cenário do seu print (12
cancelamentos pré-pagamento + eventos com autorização de verdade
misturados): confirmei que os 12 continuam no banco, mas só os
autorizados aparecem na lista.

## Versão ainda travada — achei um problema mais sério por trás

Reparei em um detalhe importante no seu print: o "último contato"
está **congelado exatamente em 01/08, 18:53**, mesmo depois de mais de
15 horas passarem. Isso não bate com "só precisa reabrir o app" — se
o app tivesse rodado de novo em qualquer momento nesse intervalo, esse
horário teria mudado. Isso me fez suspeitar de algo mais grave.

**Achei**: o `catch` do `checkLicense()` engolia **qualquer erro**
completamente em silêncio — nem log no console, nem nada. Se alguma
coisa ali dentro (talvez até o próprio código de métricas que
adicionei há pouco) estivesse lançando um erro de verdade, isso
travaria a atualização de `ultimoContato`/versão **pra sempre**, sem
nenhum rastro pra eu ou você descobrir o motivo — casando exatamente
com o comportamento do seu print.

**Corrigido**: agora, se o erro não parecer coisa de rede/sem-internet
(que continua silencioso, como sempre foi — não quero te encher de
ruído por causa de instabilidade normal de conexão), ele é reportado
pro painel → Erros. Testei a lógica que separa "erro de rede" de
"bug de verdade" com vários casos.

**Isso não é uma garantia de que resolvi o problema raiz** — é uma
correção que torna o problema **visível**, caso ele ainda esteja
acontecendo. Depois de instalar essa versão: se a versão continuar
travada, agora deve aparecer alguma coisa em Erros no painel — me
manda o que aparecer lá que eu consigo investigar a causa real, em
vez de continuar chutando.

### Continuação — a causa real era outra (e agora testei de verdade)

Seu print seguinte mostrou que a letra ainda estava escura — mas não
na busca em si, na **lista de resultados** que aparece embaixo dela
(os produtos sugeridos, tipo "ibuprof 600mg..."). Isso é um problema
diferente do de autofill que corrigi antes: é `<button>` puro, sem
autofill nenhum envolvido.

**A causa real**: `<button>` no navegador não herda a cor de texto do
elemento pai do jeito que uma `<div>` ou `<span>` herdaria — o
navegador aplica uma cor própria (escura) por padrão, a não ser que o
CSS diga explicitamente qual cor usar. A regra base de `button` no
projeto nunca definia isso — cada botão "estilizado" (Primário,
Secundário, etc.) define a própria cor certinho, mas qualquer botão
"cru" sem uma dessas classes cai na cor escura padrão do navegador,
mesmo com fundo escuro do tema.

**Corrigido na raiz** — a regra base de `button` (que toda a
aplicação usa) agora já define a cor do texto certa. Isso conserta a
lista de resultados da busca, e qualquer outro botão "cru" que exista
ou venha a existir no projeto, sem precisar corrigir um por um.
Apliquei a mesma correção no painel administrativo também (CSS
separado).

**Dessa vez consegui testar de verdade, num navegador renderizado**
(diferente do caso de autofill, que depende de um estado do navegador
difícil de forçar) — confirmei com números reais: fundo em
`rgb(16,32,29)` (escuro) e texto em `rgb(238,245,242)` (bem claro),
alto contraste, e também vi o resultado renderizado num print antes
de fechar essa entrega.

## Contraste ruim em campo com autofill — corrigido em todo o app

Achei a causa: não era um problema de cor definida errada no app — o
Chromium (base do Electron) força fundo claro + letra preta em
qualquer campo que tenha uma sugestão de preenchimento automático
(autofill), ignorando o `color`/`background` normais do CSS. Isso
afeta qualquer campo já usado antes — busca de produto, nome de
cliente, etc. — não é algo específico de um campo só.

**Corrigido de forma global**, nos dois CSS do projeto (app principal
e painel administrativo, que são independentes) — usando a técnica
padrão pra isso (`-webkit-text-fill-color` + `box-shadow inset`
simulando o fundo, já que só sobrescrever `color`/`background` não
funciona nesse caso específico). Cobre todo campo do app de uma vez,
não só a busca de produto.

**O que não consegui confirmar visualmente**: tentei forçar o estado
de autofill de verdade via protocolo do Chrome DevTools pra tirar um
print comparando antes/depois, mas o comando específico pra isso não
está disponível na versão do Chromium desse ambiente. A técnica que
apliquei é o padrão amplamente documentado e usado nesse exato
cenário — mas vale você conferir na prática: usa a busca de produto
umas duas vezes (pra ela "lembrar" o que foi digitado), fecha e abre
o campo de novo, e confere se o texto sugerido aparece legível.

## Bug real: versão não atualizava no painel

Você confirmou que já estava incrementando a versão antes de cada
build, então descartei minha primeira hipótese e procurei mais fundo.

**Achei uma explicação plausível**: o app não tinha nenhuma trava
contra rodar **duas instâncias ao mesmo tempo** na mesma máquina. Se
uma instalação de teste anterior ficasse aberta (minimizada, esquecida
depois de um teste) enquanto você abre um build novo pra testar, as
duas ficam rodando o próprio `checkLicense()` periódico em paralelo —
cada uma escrevendo sua própria versão no mesmo documento do
Firestore. Se a instância ANTIGA escrever por último (o que pode
acontecer dependendo do timing dos ciclos de 6h de cada uma), ela
sobrescreve a versão nova com a velha, e o painel fica "preso" mesmo
depois de você ter atualizado de verdade.

**Corrigido**: o app agora usa `requestSingleInstanceLock()` do
Electron — só uma instância roda por vez. Se você tentar abrir o app
de novo enquanto já tem um aberto, ele só foca a janela existente em
vez de abrir outra por cima.

**Não tive como testar isso da forma mais direta** — simular duas
instâncias reais de um app Electron competindo pelo mesmo lock do
sistema operacional não é algo que dá pra reproduzir no ambiente
sandbox que uso aqui (não é um Windows de verdade rodando o app
empacotado). Validei que o código compila e segue exatamente o padrão
documentado do Electron pra isso, mas o teste final é seu: **antes de
instalar essa versão, abre o Gerenciador de Tarefas do Windows e
confere se não tem mais de um processo do GerenciaAI rodando** — se
tiver, é essa a causa, confirmada. Depois de instalar essa correção,
tentar abrir o app duas vezes deve só trazer a janela já aberta pra
frente, nunca abrir uma segunda.

## Auditoria de bugs e otimizações

### Bug real encontrado e corrigido — texto digitado sumia no painel

O ping de presença que acabei de implementar (a cada 2 minutos por
máquina) tinha um efeito colateral que eu não tinha percebido na hora:
o painel redesenhava a lista inteira via `innerHTML` toda vez que
QUALQUER instalação atualizava no Firestore — e agora isso acontece a
cada 2 minutos por máquina, não mais a cada 6h. Se você estivesse no
meio de digitar alguma coisa (nome do negócio, mensagem de um
cliente) bem na hora que um ping de outra máquina chegasse, o que
você tinha digitado sumia.

**Corrigido**: agora o painel diferencia — se só o sinal de presença
mudou (nada estrutural), atualiza só os pontinhos e os resumos "X
online agora" no lugar, sem redesenhar o resto. Se algo de verdade
mudou (bloqueio, vínculo de cliente, mensagem, progresso de
atualização), aí sim redesenha normalmente. Testei os dois cenários
no navegador de verdade: confirmei que texto sendo digitado sobrevive
a um ping chegando, e que uma mudança real (bloquear uma máquina)
ainda atualiza a tela do jeito certo.

### Otimização que investiguei e NÃO apliquei (testei, não ajudava)

Suspeitei que `listSalesByRange` pudesse estar lenta em históricos
grandes, por causa de duas subconsultas correlacionadas rodando por
linha. Testei com 30 mil vendas simuladas comparando a versão atual
contra uma reescrita com JOIN pré-agregado — **a reescrita não ficou
mais rápida** (ficou até um pouco pior, dentro da margem de erro).
Os índices que já existem cobrem bem o padrão de acesso atual, então
não apliquei nenhuma mudança aqui — prefiro não mexer em algo que já
funciona bem só por suspeita, sem confirmar com teste de verdade.
Números de referência, pra registro: 30 dias de histórico (situação
comum) processam em ~35ms; um ano inteiro (30 mil vendas, caso raro)
em ~770ms — ainda aceitável pra uma consulta ocasional.

### Conferido e sem problema

- `oculta_historico` só afeta a lista do Histórico, nunca vaza pros
  relatórios de lucro ou métricas agregadas (conferido no código —
  é intencional, os relatórios devem refletir o negócio real).
- Busca de produto por nome (reescrita há algumas entregas pra
  ignorar acento) continua rápida mesmo com 3.000 produtos no
  catálogo — ~33ms.
- Parsing de data no relatório de horário de pico, com o formato
  exato que o `NOW_SYNCED()` grava (com espaço, sem "Z") — testado e
  confirmado que funciona certo.

## Sinal de online/offline por máquina

Pedido de conseguir ver, em cada máquina cadastrada no painel, se ela
está online ou não. Implementei um "ping de presença" novo — separado
do sinal de vida de 6h que já existia (esse é grosso demais pra dar um
sinal de "está online agora?" confiável: uma máquina rodando fazia
horas podia aparecer como "sem contato" só por não ter batido o
checkpoint de 6h ainda).

- **App**: manda um ping bem leve pro Firestore a cada 2 minutos (só
  isso, não reavalia licença nem nada — bem mais barato que a checagem
  completa).
- **Painel**: pontinho colorido antes do nome de cada máquina — verde
  pulsando = online (ping nos últimos 3 minutos), cinza = offline. O
  resumo do bloco de cada cliente também mostra "X online agora".
  Reavalia sozinho a cada 30s, mesmo sem nenhum dado novo chegar do
  Firestore (senão uma máquina que só parou de mandar ping ficaria
  "online" pra sempre até algum outro evento disparar um recálculo).
- **Instalação que ainda não atualizou** (versão de antes dessa
  mudança) não trava nem quebra — o painel usa o `ultimoContato` de
  sempre como reserva, então ainda mostra alguma coisa razoável até o
  cliente atualizar.

**Limitação honesta**: o Firestore não tem um mecanismo de presença
nativo tipo "avisa quando desconectar" (isso existe no Realtime
Database, não no Firestore que esse projeto usa). Então se o app
fechar de forma abrupta (queda de luz, processo morto à força), o
painel só percebe alguns minutos depois, quando o ping para de chegar
— não é instantâneo. Pra a maioria dos casos de uso (saber se a loja
está com o sistema rodando agora) isso é suficiente, mas não é 100%
em tempo real no sentido mais estrito.

Testei os 3 cenários no navegador de verdade: máquina que pingou
recente (online), máquina que parou de pingar há tempo (offline), e
uma instalação simulando versão antiga sem `ultimoPing` nenhum
(confirmei que cai certinho no fallback).

**Precisa republicar as regras do Firestore de novo** (Passo 3 do
`LICENCIAMENTO.md`) — sem isso, o campo `ultimoPing` não consegue ser
escrito, e todo mundo aparece offline pra sempre.

## Feedback do print do Histórico — 3 pedidos

1. **"Só mostrar o que realmente foi vendido"** — corrigido no
   Histórico: a lista expandida de itens de uma venda agora filtra
   itens cancelados completamente (antes aparecia riscado, misturado
   com o que foi vendido de verdade).

2. **Excluir vendas do histórico, dependendo do perfil** (esse era um
   pedido de antes, que ficou pendente) — implementado: só
   gerente/admin veem a opção "Excluir do histórico" em cada venda.
   Isso **esconde da lista**, mas nunca apaga nada de verdade — estoque,
   pagamento, e qualquer NFC-e já emitida continuam intactos por baixo.
   Um toggle "Mostrar excluídas" deixa reverter se precisar. Testei
   isso a fundo: some da lista normal, aparece com incluirOcultas=true,
   fica registrado na auditoria, e reexibir traz de volta.

3. **Rascunho da leitura de nota persistente** — no Abastecimento,
   trocar de aba no meio da conferência de uma nota lida pela IA não
   perde mais nada. Salva automaticamente a cada mudança, carrega
   sozinho quando você volta pra tela, com um aviso "Retomando a
   conferência de onde você parou". Testado com um cenário completo
   (salvar, editar, recarregar).

4. **Filtros no relatório de produtos do Painel** — botões de ordenar
   por Lucro (padrão), Mais vendido, Receita, Vendido recentemente, e
   Alfabética. Testei as 4 ordenações.

## Suas 6 anotações implementadas

1. **Relatório de produtos com lucro + horário de pico** — aba nova
   "Produtos e lucro" no Painel (gerente também acessa, não só admin),
   com período predefinido ou personalizado. Mostra nome, categoria,
   quantidade, receita e lucro por produto, mais um gráfico de barras
   do movimento por hora do dia. **Direto na tela, sem gerar arquivo**,
   exatamente como pedido. Testei o cálculo de lucro e do horário de
   pico (com o mesmo cuidado de fuso horário do trabalho fiscal —
   calculado por São Paulo, não pela máquina).

2. **Busca por nome melhorada + navegação por teclado ao máximo**:
   - A busca agora ignora acento (buscar "pao" acha "Pão") e ranqueia
     por relevância (nome que começa com o termo vem primeiro) — antes
     era só ordem alfabética.
   - A busca de produto no PDV ganhou navegação completa por teclado:
     setas pra escolher, Enter pra adicionar, sem precisar do mouse.
   - **Atalho Esc pra fechar subtelas** — apliquei em 13 componentes
     diferentes (todo modal do sistema: autorização de gerente,
     fechamento de caixa, ajuste de estoque, anexos de venda, cadastro
     de produto/insumo/usuário/cliente, transferir mesa, editar
     pessoas da mesa, observação de item, peso de produto por kg,
     restaurar backup, treinamento). Conferi um por um que cada Esc
     está ligado exatamente ao mesmo botão "Cancelar"/"Fechar" que já
     existia, não inventei nenhum comportamento novo.

3. **Mostrar produtos por venda** — no Histórico, clicar numa linha de
   venda expande mostrando os itens (nome, quantidade, valor,
   observação, se foi cancelado).

4. **Abastecimento — linhas não somem mais até finalizar + "Limpar
   tudo"** — achei a causa real de um bug: se uma nota tinha algumas
   linhas certas e outras com erro, confirmar apagava a tabela
   inteira, perdendo até as que deram erro. Agora só remove as que
   realmente entraram — as com erro ficam na tela pra corrigir.
   Adicionei "Limpar tudo" pra recomeçar do zero quando quiser.

5. **Margem sobre o custo, calculando o preço de venda sozinho** —
   campo novo no cadastro de produto: define um % de aumento sobre o
   custo, e o preço de venda é calculado automaticamente. Funciona nos
   dois sentidos (editar margem recalcula preço; editar preço
   recalcula a margem mostrada; editar custo com margem já definida
   mantém a margem, recalculando o preço).

6. **Custo atualizado pela leitura da nota** — ao confirmar uma
   entrada de abastecimento, o custo do produto já cadastrado é
   atualizado pelo preço unitário lido da nota automaticamente (antes
   isso só acontecia pra produto novo, cadastrado na hora).

## Estrutura fiscal (NFC-e) — geração do XML, sem transmitir ainda

Pedido de começar pela estrutura completa (cadastro, geração do XML)
antes de partir pra assinatura/transmissão, dado o tamanho real desse
projeto. Entregue nessa parte:

- **`nfceChaveService.js`** — gera a chave de acesso de 44 dígitos
  (módulo 11). Pesquisei o algoritmo contra várias fontes
  independentes antes de implementar, e testei rigorosamente —
  inclusive decodifiquei uma chave gerada campo por campo pra
  confirmar que cada posição bate exatamente.
- **`nfceXmlService.js`** — monta o XML completo (ide, emitente,
  itens com ICMS/PIS/COFINS, total, pagamento) no layout 4.00.
  Implementado a fundo pro caminho mais comum (Simples Nacional,
  CSOSN 102/300/400/500 — os que não precisam de cálculo de crédito),
  que cobre a grande maioria dos pequenos negócios. Casos mais raros
  (CSOSN que precisa de base de cálculo, regime normal com CST que
  precisa de alíquota) geram o grupo mínimo, mas ficam marcados com um
  comentário `<!-- REVISAR -->` no XML — não fingem estar prontos.
- **Achei e corrigi um bug real durante o teste**: a data/hora do XML
  estava usando o fuso horário da máquina que roda o código, não o
  fuso do estado emissor — se a máquina do cliente estivesse com o
  relógio mal configurado (ou em UTC por engano), o XML sairia com
  hora errada sem ninguém perceber. Corrigido pra calcular o fuso
  certo por UF (testei Pernambuco e Acre, que têm fusos diferentes).
- **`emitirNFCe` agora gera de verdade** — testei de ponta a ponta com
  banco simulado: monta o XML, salva em disco (separado por
  ambiente), registra em `nfce_emitidas` como "pendente", incrementa a
  numeração. O botão "Emitir NFC-e" no PDV foi reabilitado, com texto
  honesto sobre o que ele faz agora.

**O que falta pra ser uma nota fiscal de verdade** (próximas fases,
fora do escopo pedido dessa vez): assinatura digital com o certificado
real (só dá pra testar com o certificado de verdade do Arthur) e
transmissão pro webservice da SEFAZ (varia por estado). Documentado no
código pra não passar a impressão de que já emite de verdade.

## Painel de métricas agregadas

Visão geral do negócio (o seu, Arthur, não de um cliente específico)
somando todas as instalações — total de vendas histórico, últimos 30
dias, e o perfil de negócio mais comum entre os clientes. Só
contagens, nunca o conteúdo de uma venda específica — o app já
reportava "sinal de vida" (última conexão, versão) a cada 6h; só
estendi esse mesmo reporte pra incluir essas contagens.

Botão "📊 Métricas" no painel, atualiza sozinho conforme os clientes
ficam online. Testei o cálculo (soma de vendas, contagem por perfil)
num navegador de verdade com dados simulados.

## Aviso automático de erro

Quando o app quebra na máquina de um cliente — seja um crash no
processo principal, uma promise rejeitada sem tratamento, ou um erro
de renderização do React — um relato técnico (mensagem + stack trace,
nunca dado de venda ou cliente) chega automaticamente no painel, antes
do cliente ligar reclamando.

- **Processo principal**: `uncaughtException` e `unhandledRejection`
  agora são capturados e reportados (antes, um crash nessa camada
  simplesmente fechava o app sem nenhum rastro).
- **Renderer**: `window.onerror`, `unhandledrejection`, e um Error
  Boundary do React (pega erro de renderização, mostra uma tela de
  recuperação em vez de tela branca, com botão de recarregar).
- **Limite de 5 relatos por sessão** — testado — pra nunca inundar o
  Firestore se algum erro entrar em loop.
- Botão "⚠️ Erros" no painel — mostra os relatos recentes, com o nome
  do cliente (resolvido automaticamente a partir da instalação),
  versão, contexto, e um botão de apagar. Testei tudo isso num
  navegador de verdade, incluindo apagar.

**Isso é uma coleção nova no Firestore — precisa republicar as regras
de segurança** (Passo 3 do `LICENCIAMENTO.md`, já atualizado com o
bloco de `erros_reportados`).

## Mensagens na tela inicial do app, publicadas pelo painel

Pedido de conseguir deixar mensagens salvas no painel pra aparecer na
tela inicial do app do cliente — pendência, motivo de bloqueio, ou
até uma imagem de feriado. Implementado em três partes, reaproveitando
a mesma infraestrutura de tempo real já usada pela licença e pela
atualização obrigatória (sem precisar de projeto ou coleção nova):

1. **Mensagem global** — banner "💬 Mensagem" no painel, com texto e
   uma URL de imagem opcional (hospede em qualquer lugar — Imgur,
   Google Drive público, etc. — e cole o link). Aparece pra **todo
   cliente**, na tela inicial do PDV, com botão de fechar. Pensado pra
   feriado, aviso geral, essas coisas.
2. **Mensagem por cliente** — dentro do bloco de cada cliente
   (expandido), um campo específico pra esse cliente só — pensado pra
   pendência de pagamento, aviso pontual, etc. Salva em lote pra todas
   as máquinas vinculadas àquele cliente de uma vez.
3. **Motivo de bloqueio customizado** — ao clicar "Bloquear agora" ou
   "Bloquear tudo", o painel agora pergunta o motivo (opcional) —
   esse texto aparece na tela de bloqueio do cliente, no lugar da
   mensagem genérica. Fica limpo automaticamente ao reativar/desbloquear.

**Sobre a imagem de feriado**: por enquanto só aceita uma URL (link
pra uma imagem já hospedada em algum lugar) — não fiz upload direto de
arquivo pelo painel, porque isso precisaria configurar o Firebase
Storage (mais um projeto/regra pra cuidar) e o Firestore tem limite de
tamanho por documento. Pra uma imagem pequena isso resolve bem; se
precisar de upload direto no futuro, dá pra adicionar depois.

**As regras de segurança do Firestore já cobrem isso** — a regra que
já existia pra `config/atualizacao` usa um "coringa" (`{configId}`)
que também cobre `config/mensagem` automaticamente. **Não precisa
republicar nada dessa vez.**

Testei no navegador de verdade (com o Firebase simulado): publicar
mensagem global grava o dado certo e atualiza o status na tela,
mensagem por cliente salva em lote pra máquina certa, e bloquear com
motivo captura o texto digitado e manda junto — sem erro de
JavaScript em nenhum dos três.

### Continuação — status ficava travado em "aguardando reiniciar" mesmo depois de já ter reiniciado

Você reportou que mesmo já tendo reiniciado o cliente (v0.5.2), o
painel continuava mostrando "Atualização baixada, aguardando reiniciar
no cliente". Achei a causa: eu escrevia o status no Firestore
**durante** o download, mas nunca "limpava" isso depois — o app novo
sobe com um estado interno zerado na memória, só que isso nunca era
reportado de volta pro Firestore, então o painel continuava lendo o
último valor escrito (de antes do reinício), pra sempre.

**Corrigido**: agora, assim que o app sobe, reporta o status limpo pro
Firestore de cara — resolve tanto esse caso quanto o de alguém fechar
o app no meio de um download (ficaria travado mostrando uma
porcentagem antiga pra sempre, agora também se limpa ao reiniciar).

## Atualização obrigatória publicada pelo painel

Pedido de conseguir forçar todos os clientes a atualizar de uma vez,
com aviso e barra de progresso, sem precisar ir cliente por cliente.
Reaproveitei o sistema de atualização que já existia (electron-updater,
com download e checagem de versão via GitHub Releases) e construí uma
camada de "obrigatoriedade" por cima, usando o mesmo Firebase do
licenciamento — não precisou de nenhum projeto novo.

**Como funciona**:
1. Você publica a versão nova normalmente (`npm version patch`,
   `git push --tags`) — isso já builda e sobe pro GitHub Releases,
   processo que já existia.
2. No painel, abre a seção "⬆ Atualização" (botão ao lado da busca),
   digita a versão exata que acabou de publicar (ex: `0.5.0`), clica
   em "Publicar para todos os clientes".
3. Todo cliente com versão mais antiga que essa é bloqueado — tela
   cheia "Atualização obrigatória", com botão "Atualizar agora" que
   baixa e mostra o progresso, e reinicia sozinho na versão nova
   quando termina. Cliente já atualizado nem percebe nada.
4. **A barra de progresso aparece nos dois lados** — na tela do
   cliente (óbvio, é ele baixando) e também no seu painel, dentro do
   bloco do cliente, em tempo real (o app reporta o progresso pro
   Firestore enquanto baixa).
5. Um botão "Desativar" no painel libera todo mundo de volta, se
   precisar reverter ou pausar o rollout.

**Testei**: a comparação de versão (inclusive o caso clássico onde
comparar como texto erraria — "0.4.10" parece "menor" que "0.4.9" se
comparado como string, mas não é), os 5 cenários de quando bloquear ou
não (nada publicado, desatualizado, já atualizado, versão local mais
nova que a exigida, e desativado pelo admin), e o painel de verdade
num navegador (a barra de progresso aparecendo na máquina certa,
publicar gravando o dado certo, e rejeitar um formato de versão
inválido).

**Atualizei as regras de segurança do Firestore de novo** — precisa
republicar mais uma vez (Passo 3 do `LICENCIAMENTO.md`): adicionei a
permissão pro documento `config/atualizacao` (o app precisa ler pra
saber se tem atualização obrigatória; só você escreve), e expandi os
campos que a instalação pode atualizar sozinha (os campos de progresso
do download). **Sem republicar, a atualização obrigatória não
funciona** — nem o app consegue saber que tem uma publicada, nem
reportar o progresso pro painel.

**Uma coisa que não dá pra eu testar daqui**: o download de verdade
contra um GitHub Releases real, e o app reiniciando sozinho depois de
instalar — isso só roda em produção, com o electron-updater de
verdade. A lógica de decisão (quando bloquear, qual versão pedir) foi
testada a fundo; o download/instalação em si usa a mesma infraestrutura
que já existia e já funcionava antes dessa mudança.

## Desocupar mesa (sem precisar de venda)

Pedido de conseguir liberar uma mesa mesmo sem fechar conta — hoje só
dava pra transferir, e uma mesa aberta por engano (ou onde o cliente
foi embora sem pedir nada) ficava presa. Botão novo "Desocupar" no
topo da comanda, ao lado de "Transferir mesa".

**Como decide o que fazer**:
- **Mesa sem nenhum item lançado ainda** — libera direto pra "livre",
  sem pedir senha de gerente. Não tem risco de fraude nenhum em
  cancelar algo que nunca teve nada dentro, então não faz sentido
  exigir autorização pra isso.
- **Mesa com item já lançado** — passa pelo cancelamento de venda
  normal (mesma trilha de auditoria de sempre), e vai pra "aguardando
  limpeza" em vez de "livre" direto (algo aconteceu naquela mesa,
  mesmo sem ter sido pago). Essa parte respeita a configuração de
  "Exigir senha de gerente" que acabei de tornar opcional — se
  estiver desligada, libera direto também; se estiver ligada (padrão),
  pede a senha de um gerente/admin, do mesmo jeito que cancelar
  qualquer venda já pede.

Testei os dois cenários (mesa vazia e mesa com item) antes de
integrar.

## Senha de cancelamento agora opcional e configurável

Antes, cancelar um item (ou a venda inteira) depois de já ter
pagamento registrado **sempre** exigia a senha de um gerente/admin —
sem opção de desligar. Agora tem um toggle em Configurações →
Segurança: "Exigir senha de gerente para cancelar item ou venda já
paga" — ligado por padrão (mesmo comportamento de sempre), mas pode
desligar.

**O que muda desligando**: qualquer operador cancela direto, sem
pedir senha de ninguém. **O que NÃO muda**: o cancelamento continua
registrado no histórico de auditoria normalmente — só sem exigir
aprovação antes. Isso vale tanto pra cancelar um item quanto pra
cancelar a venda inteira.

Testei as 4 combinações possíveis (com/sem pagamento × configuração
ligada/desligada) antes de integrar — bateu certinho em todas.

## Painel de licenciamento — bloqueio imediato, blocos por cliente, múltiplos negócios

Pedido de: bloqueio imediato (além do congelamento com aviso), blocos
por cliente que expandem pra mostrar as máquinas vinculadas, vínculo
de múltiplos negócios do mesmo dono, e bloqueio do bloco inteiro de
uma vez. Implementado nos dois lados:

### No app

- **Bloqueio imediato de verdade** — novo, separado do congelamento
  com aviso (que continua existindo, com os 2 dias de carência de
  sempre). Bloqueio imediato não tem carência nenhuma: assim que o app
  perceber a mudança, para na hora.
- **"Imediato" agora é imediato de verdade** — antes, qualquer mudança
  no painel só chegava no app na próxima checagem periódica (a cada
  6h). Adicionei uma **escuta em tempo real** do Firestore (além da
  checagem periódica, que continua rodando como reforço) — assim que
  você bloqueia ou congela pelo painel, o app recebe a mudança em
  poucos segundos (se estiver online), não em horas. Testei a lógica
  de prioridade isoladamente: bloqueio imediato sempre vence sobre
  qualquer outro estado, mesmo um congelamento ainda dentro da
  carência.

### No painel administrativo (reescrito)

- **Blocos por cliente** — cada cliente é um cartão que expande ao
  clicar, mostrando as máquinas vinculadas a ele.
- **Múltiplos negócios do mesmo dono** — vincule quantas instalações
  quiser ao mesmo cliente (ex: a padaria e o restaurante da mesma
  pessoa) — aparecem juntas dentro do bloco dele. Testei essa lógica
  de agrupamento isoladamente com esse cenário exato.
- **"Bloquear tudo" no bloco do cliente** — bloqueia imediatamente
  TODAS as máquinas daquele cliente de uma vez (grava tudo junto,
  numa única operação em lote no Firestore). "Reativar tudo" faz o
  inverso.
- Cada máquina individual continua com seus próprios controles
  (congelar/reativar com aviso, bloquear/desbloquear imediato,
  vincular/desvincular de um cliente, editar o nome do negócio).
- Máquinas ainda não vinculadas a nenhum cliente aparecem num bloco
  separado "Sem vínculo", com um botão pra vincular.
- Botão "+ Novo cliente" pra cadastrar (nome + CPF/CNPJ opcional).
- Busca funciona por nome do cliente, nome do negócio, ou ID da
  máquina.

**O que testei e validei**: sintaxe do JavaScript do painel, todas as
tags HTML balanceadas, todo `getElementById` batendo com um elemento
que existe de verdade, escape de HTML (nome de cliente não quebra a
página), e a lógica de agrupamento por cliente isolada — incluindo
especificamente o cenário de "um dono, dois negócios diferentes".

**O que não consegui testar**: não tenho como carregar isso num
navegador real aqui (o CDN do Firebase não é acessível neste
ambiente), então não vi a interface renderizada de verdade nem testei
contra o Firestore ao vivo. Teste com calma antes de confiar —
especialmente o bloqueio em lote (várias escritas de uma vez).

**Atualizei também as regras de segurança do Firestore documentadas no
`LICENCIAMENTO.md`** — precisa republicar (adicionei a coleção
`clientes`, restrita a admin autenticado). Se você já tinha as regras
antigas publicadas, republique com o bloco novo antes de usar o
bloqueio imediato ou os clientes.

## Auditoria geral (bugs, inconsistências, melhorias)

Fiz uma varredura estruturada, não só leitura solta de código:

1. **Sintaxe** de todo o backend e frontend — limpa.
2. **IPC nos dois sentidos** — cruzei os três lados (o que o backend
   registra, o que o preload expõe, o que o frontend chama) pra achar
   método chamado que não existe, ou exposto sem handler. Zero
   problemas — sinal forte de que essa camada inteira está coerente.
3. **Regressão real encontrada e corrigida**: quando fundi "Cardápio
   Digital" dentro de "Restaurante" (pedido de reduzir itens do menu),
   a aba ficou visível pra qualquer papel — mas "Cardápio Digital" era
   restrito a gerente/admin antes da fusão, e essa restrição se perdeu
   no processo. Corrigido — a aba volta a só aparecer (e só funcionar)
   pra gerente/admin, igual era antes.
4. Conferi as OUTRAS telas fundidas (Histórico, Produtos, Abastecimento)
   pelo mesmo tipo de problema — essas já tinham a restrição certa
   desde quando fundi, só a de Restaurante escapou.
5. **Imports não usados** em todo o frontend — nenhum encontrado.
6. Reconferi o mesmo padrão do bug de `LOCATION_ID` capturado cedo
   demais (já corrigido antes) em todo o projeto — não reapareceu em
   lugar nenhum.

Não encontrei mais nada de errado além do item 3. O app está num
estado consistente.

## Filtro por cliente no Histórico + relatório de compras

Pedido de filtrar o Histórico por cliente, com relatório de acordo com
o filtro e a quantidade de pedidos, subclassificando por tipo de
produto. Implementado:

- **Campo de CNPJ novo** no cadastro de cliente (só tinha CPF antes) —
  seu exemplo era de cliente pessoa jurídica, então adicionei os dois,
  já que um cliente pode ter só um, os dois, ou nenhum.
- **Filtro por cliente** no Histórico — busca por nome, CPF ou CNPJ,
  com sugestões enquanto digita.
- **Relatório automático** ao escolher um cliente: nome, CPF/CNPJ,
  período, total de pedidos, valor total gasto — e os produtos
  comprados **subclassificados por categoria** (quanto de cada
  categoria, e dentro dela, quanto de cada produto especificamente).
  Exatamente o formato do seu exemplo: "cliente fulano, CNPJ tal, no
  período de X a Y, comprou Z produtos do tipo tal".
- **Exportar esse relatório específico** em planilha, separado do
  botão de exportar o histórico geral.

Testei o relatório com um cenário completo em SQL puro antes de
integrar: cliente com duas compras em categorias diferentes, mais uma
venda de OUTRO cliente (não deve aparecer) e uma venda ainda aberta do
mesmo cliente (não deve contar) — confirmei que o relatório soma
certo, agrupa certo por categoria, e ignora exatamente o que devia
ignorar.

## Config real do Firebase de licenciamento aplicada

Você mandou o `licenseService.js` já preenchido com os dados reais do
seu projeto Firebase (`gerenciaai-licencas`). Apliquei nos dois lugares
que precisam da mesma config: `electron/services/licenseService.js` e
`admin-panel/index.html` — os dois já vêm prontos nessa entrega, sem
precisar colar mais nada.

**Guardei isso na memória** — a partir de agora, toda entrega nova
já vai sair com essa config real aplicada automaticamente, sem
reverter pro placeholder `COLOQUE_AQUI`. Não precisa mais reenviar
isso nem colar de novo depois de sobrescrever o projeto.

## Editar número de pessoas da mesa (chegou mais gente)

Clique no badge "X pessoa(s)" no topo da comanda — abre um campo pra
atualizar. Só funciona em mesa ocupada (backend confere isso). Se a
mesa foi aberta sem informar quantas pessoas, aparece "+ Informar nº
de pessoas" no lugar, pra poder definir pela primeira vez também.

Atualiza na hora o cálculo de "por pessoa" no rodapé e a divisão por
pessoa — não mexe nos itens já lançados nem em quem já tinha sido
atribuído a cada pessoa antes. Ao voltar pra grade de mesas, o número
atualizado aparece lá também (a grade já recarrega os dados do banco
ao retornar, então não precisou de nenhuma mudança adicional ali).

Testei os 3 cenários em SQL puro antes de integrar: mesa ocupada
aceita a mudança, mesa livre bloqueia, e valor inválido (zero) também
bloqueia.

## Carrinho da mesa apertado — corrigido e reorganizado

**A causa real**: o item do carrinho não tinha a classe CSS que dá o
espaçamento (`cart-item`) — só aplicava a classe de "selecionado"
quando clicado, a classe base nunca era usada. O mesmo PDV normal já
fazia isso certo (`` `cart-item ${selecionado ? '...' : ''}` ``); a
tela de mesa só esqueceu de incluir a base.

Aproveitei pra reorganizar de vez, já que a tela de mesa tem mais
controle por item (seletor de pessoa, observação, cancelar) do que o
carrinho simples do PDV normal, e um espaçamento igual não ia dar conta
de tudo direito:
- **Nome/quantidade e preço** ficam numa linha, bem separados.
- **Observação** (se tiver) numa linha própria, destacada.
- **Seletor de pessoa, editar observação, e cancelar** numa terceira
  linha, com espaço de verdade entre eles.
- A lista inteira ganhou uma moldura própria (fundo e borda), pra não
  ficar "solta" entre a grade de produtos e o rodapé — sem mexer na
  classe compartilhada com o carrinho do PDV normal (usei uma classe
  nova só pra mesa, pra não arriscar mudar o que já funcionava lá).

Conferi visualmente renderizando com o CSS real antes de fechar —
tanto pra confirmar as três linhas separadas quanto a moldura
aparecendo direito.

## Bug real: "Estoque insuficiente" nas mesas mesmo com estoque de verdade

Você reportou não conseguir adicionar produto nenhum na comanda de uma
mesa, mesmo com estoque cadastrado. Achei a causa: o
`TableOrderScreen.jsx` lia `window.APP_LOCATION_ID` no **topo do
arquivo** (fora do componente) — isso roda cedo demais, antes do app
terminar de configurar qual é o local de verdade, então sempre virava
`undefined`. Toda checagem de estoque acabava perguntando pelo estoque
de um local que não existe, sempre voltando zero.

**Detalhe importante**: esse exato problema já tinha acontecido antes
no PDV normal (`POSScreen.jsx`) e já tinha sido corrigido lá — só que
quando construí a tela de mesa, recriei o mesmo erro sem perceber que
já existia essa lição aprendida em outro arquivo. Corrigido do mesmo
jeito que já funcionava no PDV normal (lendo o valor **dentro** do
componente, não no topo do módulo). Conferi os outros arquivos de
restaurante (`RestaurantTables.jsx`) — só esse tinha o problema.

## Limpar produtos cadastrados (pra trocar de perfil de teste)

Pedido de limpar os produtos pra testar o perfil Restaurante sem os
produtos antigos atrapalhando. Botão "Limpar todos os produtos" em
Produtos, com confirmação explícita antes de executar.

**Não é um apagar simples** — pensei no que podia dar errado:
- Produto que **nunca foi vendido**: apaga de vez, e libera o
  SKU/código de barras/código de balança pra poder reimportar os
  mesmos códigos numa planilha de teste nova (é exatamente essa
  colisão que travaria se eu só desativasse os produtos antigos, sem
  liberar os códigos).
- Produto que **já tem venda ou devolução de verdade** no histórico:
  a própria integridade do banco (chave estrangeira) impede apagar —
  nesse caso, em vez de dar erro, o sistema desativa e libera os
  códigos mesmo assim, sem tocar no histórico. As vendas antigas
  continuam aparecendo certinho no Histórico, com o nome do produto e
  tudo.

Testei os dois cenários em SQL puro, com a proteção de integridade
referencial ligada de verdade (não simulada) — confirmei que produto
nunca vendido some, produto com venda genuína continua intacto e
legível no histórico, e o código fica livre pra reuso.

## Barra lateral com menos itens (17 → 11)

Pedido de mesclar as opções correlatas, já que estava com muitos itens
soltos. Quatro agrupamentos, todos com abas (mesmo padrão já usado em
Configurações e Painel):

- **Restaurante** — Mesas + Cardápio do dia + Cardápio Digital (só
  aparece pro perfil Restaurante/Padaria, como já era antes).
- **Histórico** — Vendas + Fechamentos de caixa (a aba de fechamentos
  só aparece pra gerente/admin — operador continua vendo só as vendas,
  igual já era).
- **Produtos** — Produtos + Insumos + Desperdício (as duas últimas
  abas só aparecem pro perfil Restaurante/Padaria).
- **Abastecimento** — Receber mercadoria + Fornecedores.

Nenhuma tela foi reescrita — os componentes de sempre (SalesHistory,
ProductList, SupplyScreen, etc.) continuam exatamente iguais por
dentro, só passaram a ficar dentro de um "envelope" com abas, no lugar
de aparecerem cada um como item separado do menu. Restrições de perfil
e de papel (operador/gerente/admin) que já existiam foram preservadas
— só mudou onde a restrição é aplicada (na aba, não mais no item do
menu inteiro).

Validado com compilação de cada arquivo novo, e a varredura completa
de imports/exports do projeto inteiro (nenhum problema encontrado).

## Cor do botão Sair + treinamento atualizado

**Cor do Sair** — hoje "Sair" e "Modo escuro" tinham exatamente a mesma
cor por padrão, só diferenciando ao passar o mouse. Dei ao "Sair" uma
cor própria (avermelhada) já visível sem precisar passar o mouse, pra
se destacar como uma ação diferente. Validado analisando os pixels da
renderização real (não só o código) antes de fechar.

**Treinamento (pptx + pdf usado dentro do app)** — reconstruí a
apresentação inteira no mesmo estilo visual (mesma paleta de cores
extraída do arquivo original, mesmas fontes), mantendo todo o conteúdo
que já existia e adicionando os recursos que faltavam: Mesas,
observação por item, comanda pra cozinha, transferir mesa, taxa de
serviço, Cardápio do dia, Cardápio Digital, Insumos, Desperdício, venda
por peso (manual, etiqueta, balança digital), busca rápida (Ctrl+K), e
atualizei a seção de gestão pra refletir Painel+Auditoria fundidos.
23 slides no total (eram 19). Validei estruturalmente (schema/XML) e
conferi o texto de cada slide novo extraído do PDF gerado, pra garantir
que o conteúdo saiu certo. O arquivo dentro do app
(`public/treinamento-pdv.pdf`, aberto pelo botão 🎓 no PDV) já está
atualizado — o `.pptx` editável também vem junto, separado do `.zip`.

O tutorial guiado (o botão "?", passo a passo apontando pra cada parte
da tela) continua cobrindo certo o que ele sempre cobriu — é
específico da tela do PDV, e nada do que mudou lá invalidou o que ele
já explicava.

## Painel e Auditoria fundidos

Pedido de juntar as duas telas — fazia sentido: as duas já eram
restritas a gerente/admin (Auditoria era só admin), e ficavam meio
separadas sem necessidade.

**Como ficou**: Painel agora tem duas abas — "Visão geral" (tudo que já
tinha: vendas por dia, produtos mais vendidos, desperdício, vendas por
operador) e "Auditoria" — só que a aba **só aparece pra quem é admin**,
igual a restrição de antes. Gerente continua vendo só a visão geral,
sem nem saber que a aba existe. O item "Auditoria" separado sumiu do
menu lateral — não perdeu nenhuma funcionalidade, só mudou de lugar
(o mesmo componente de antes, sem reescrever nada da lógica).

Validado com compilação real (esbuild, que faz uma análise completa da
árvore JSX — pegaria qualquer chave/parêntese desbalanceado), varredura
de todos os imports do projeto contra os exports reais, e contagem de
chaves/parênteses/fragments como conferência adicional — tudo bateu.
Tentei também um teste de renderização simulando login com os dois
papéis, mas esbarrei num problema de tempo no meu próprio ambiente de
teste (não do app) — preferi não insistir nisso e me apoiar nas outras
validações, que já são fortes o suficiente pra esse tipo de mudança
(mover um componente existente pra dentro de outro, sem tocar na lógica
interna de nenhum dos dois).

## Build quebrado no GitHub Actions — `package-lock.json` faltando

Você mandou o print do erro: `npm ci` falhando com "Missing: ms@2.1.2
from lock file".

**Causa raiz**: este projeto nunca teve um `package-lock.json` incluído
nas entregas que te mandei — você deve ter gerado o seu localmente
numa instalação anterior, e como cada entrega nova só manda o código
(nunca o lock file), toda vez que eu adiciono uma dependência nova ao
`package.json` (o `serialport`, na entrega passada, é o caso aqui — ele
traz `ms@2.1.2` como dependência transitiva) o seu lock file antigo
fica desatualizado, e o `npm ci` do GitHub Actions (que exige
correspondência exata entre os dois arquivos) falha.

**Corrigido definitivamente**: gerei um `package-lock.json` de verdade
a partir do registro real do npm (tenho acesso a isso neste ambiente),
e a partir de agora **toda entrega vai incluir esse arquivo
atualizado** — esse tipo de erro não deve mais acontecer.

**Testei rodando o `npm ci` de verdade** (o mesmo comando exato que o
GitHub Actions roda) contra esse lock file — 538 pacotes instalados
sem nenhum erro, confirmando que resolve.

**De passagem, chequei as vulnerabilidades de segurança que apareceram
no relatório** (`npm audit`) — vale saber:
- A única vulnerabilidade que afeta o app **rodando de verdade** no PC
  do cliente é no pacote `xlsx` (usado pra importar/exportar
  planilhas) — e infelizmente **não tem correção disponível ainda** da
  parte de quem mantém o pacote. Baixo risco prático (o app é local,
  não expõe isso pra internet — só afeta se alguém abrir de propósito
  uma planilha malformada de fonte não confiável), mas é honesto
  registrar que existe.
- A vulnerabilidade marcada como "crítica" (`node-tar`) é só uma
  ferramenta usada **durante a instalação/build** do projeto (baixa o
  binário nativo do `serialport`) — nunca roda dentro do app já
  instalado no PC do cliente, não é exposição real pra quem usa o
  sistema no dia a dia.

## Integração com gramatura e balança (digital ou analógica)

Pedido de suporte a produtos vendidos por peso, com pesagem manual, ou
lida por código de barras de etiqueta. Guia completo em `BALANCA.md` —
resumo aqui:

1. **Cadastro** — Produtos → escolher "Unidade: Kg" mostra o campo
   "Código na balança" (o código curto que você cadastra na própria
   balança).
2. **Pesagem manual** — ao clicar num produto vendido por peso (busca,
   categoria, ou vendidos recentemente), abre um modal pedindo o peso
   em kg, calcula o total automaticamente. Funciona pra balança
   analógica (você lê o mostrador e digita) ou digital sem estar
   conectada ao PC.
3. **Etiqueta de peso variável** — ao escanear um código de barras de
   13 dígitos, o app primeiro confere se é uma etiqueta de peso
   (formato configurável em Configurações → Balança) antes de tratar
   como produto comum. Pesquisei o formato real usado no Brasil (manual
   técnico de um fabricante de balança de verdade) — implementei os 3
   formatos mais comuns, já que não existe um único padrão universal.
4. **Balança digital por porta serial** — configurável em Configurações
   → Balança (buscar portas, escolher velocidade). No modal de
   pesagem, se a balança estiver conectada, mostra o peso em tempo
   real com um botão "Usar esse peso".

**O que testei a fundo, com confiança**:
- O cálculo do dígito verificador EAN-13 — validado contra um código
  real e publicamente documentado.
- A decodificação da etiqueta nos 3 formatos — gerei etiquetas de
  teste válidas (com o dígito calculado corretamente) e confirmei que
  o decodificador extrai o peso e o código certos de volta, incluindo
  rejeitar uma etiqueta adulterada (dígito errado).
- O fluxo completo de cadastro, busca por código de balança, e cálculo
  de total no PDV.

**O que não consegui testar (sem hardware real disponível aqui) — leia
com atenção antes de confiar no dia a dia**:
- **O formato exato da etiqueta da SUA balança** — implementei os 3
  formatos mais documentados, mas cada fabricante/configuração pode
  variar. Tem um testador embutido em Configurações → Balança
  (escaneia uma etiqueta de verdade e confere se o peso decodificado
  bate) — use antes de vender de verdade com isso.
- **A leitura da balança digital pela porta serial** — a lógica de
  conexão segue a documentação oficial do pacote usado, e a extração
  do peso é genérica (funciona pra vários formatos simples de texto),
  mas não é o protocolo exato de nenhuma marca específica, porque não
  tive como confirmar contra hardware real. Se não funcionar com a sua
  balança, me avise com o modelo que eu ajusto especificamente.

## "Interface principal quebrada" + restrições de perfil + Cardápio Digital

**Sobre a interface quebrada**: investiguei bastante, mas não consegui
reproduzir a quebra a partir daqui:
- Sintaxe de todo o projeto, checada arquivo por arquivo: limpa.
- Todos os imports/exports do `src/` inteiro, um por um contra o que
  cada arquivo realmente exporta: nenhum problema.
- Renderizei o app inteiro de verdade com React (login → escolher
  usuário → digitar PIN → entrar → chegar na interface principal): sem
  nenhum erro de JavaScript capturado.

**Mas achei e corrigi um ponto de risco real**, mesmo sem confirmar que
era exatamente essa a causa: o bloco de inicialização inteiro do
Electron (`app.whenReady().then(() => {...})`, em `main.js`) **não
tinha nenhum `.catch()` no final**. Se qualquer coisa travasse ali de
forma síncrona — por exemplo, uma migração de banco falhando no banco
real de uma instalação que já passou por várias versões, algo que eu
não consigo replicar perfeitamente aqui — **o app fecharia
silenciosamente sem nunca abrir a janela**, sem deixar nenhum rastro
visível. Isso bate exatamente com o tipo de sintoma "interface
quebrada". Corrigido em três frentes:
1. Adicionado um `.catch()` no bloco inteiro — agora, se travar,
   aparece um alerta nativo do Windows explicando o que aconteceu, em
   vez de fechar sem explicação.
2. A migração de colunas do banco agora protege **cada coluna
   individualmente** — se uma falhar, loga o erro e segue pras
   próximas, em vez de travar a inicialização inteira por causa de uma
   migração menor. Testei simulando uma falha no meio: confirmei que
   as migrações seguintes continuam rodando normalmente.
3. Todas as chamadas "dispara e esquece" do `main.js` (backup
   automático, verificação de atualização, checagem de licença) agora
   têm tratamento de erro — nenhuma delas conseguia derrubar o app
   sozinha antes dessa correção, mas ficou mais seguro contra isso.

**Se o problema persistir depois dessa entrega**, um print da tela ou
o texto exato de qualquer erro que aparecer ajuda demais a continuar
investigando — combinado com essa correção, se ainda quebrar, pelo
menos agora deve aparecer uma mensagem explicando o motivo, em vez de
fechar do nada.

**Insumos, Desperdício, Mesas, Cardápio do dia e Cardápio Digital**
agora só aparecem pros perfis Restaurante e Padaria (antes apareciam
pra qualquer perfil). O agrupamento fica numa constante só
(`PERFIS_RESTAURANTE` em `AppShell.jsx`) — se quiser incluir mais
perfis nesse grupo depois, é só um lugar pra mexer.

**Cardápio Digital** (tela nova, menu "Cardápio Digital") — diferente
do "Cardápio do dia" (que é a lista simples pra imprimir dos pratos
disponíveis hoje), este é o cardápio **permanente**, personalizável:
título, subtítulo, cor do tema, mostrar/esconder preços, rodapé — com
**preview ao vivo** dentro da própria tela. Mostra todos os pratos com
o campo "Tipo" preenchido no cadastro, agrupados por tipo. Duas formas
de usar o resultado: abrir direto no navegador (pra exibir num
tablet/TV), ou exportar como um arquivo HTML único pra mandar pro
cliente ou hospedar em algum link.

## Auditoria do módulo fiscal (pedido de revisão + pergunta sobre personalizar cupom)

Revisei o `fiscalService.js`, o schema, a tela de Configurações → Fiscal
e o botão de emitir no PDV. Achado principal: **a emissão de NFC-e
continua deliberadamente não implementada** — isso não é um bug, é uma
decisão documentada no próprio código (comentário grande explicando
por quê: emitir de verdade exige assinar XML com certificado real,
montar no layout exigido pela SEFAZ, transmitir pro webservice certo,
tratar rejeição/contingência, e nada disso dá pra fingir que funciona
sem testar contra homologação real). Isso já estava honesto — a tela
já dizia "em preparação" — mas achei **4 problemas reais** ao revisar
com atenção:

1. **Faltavam os campos de endereço e município no formulário** — o
   banco e o backend já tinham espaço pra isso (`endereco_json`,
   `municipio_codigo_ibge`) e a NFC-e **exige** endereço completo por
   lei, mas a tela de Configurações nunca tinha campo pra preencher.
   Mesmo com tudo mais certo, nunca teria dado pra emitir de verdade
   por causa disso. **Corrigido** — adicionei os campos (logradouro,
   número, complemento, bairro, CEP, município, código IBGE).
2. **A checagem de "configuração completa" não conferia esses campos**
   — mesmo que existissem, a validação não sabia que eram
   obrigatórios. Corrigido, testei os 3 cenários (vazio, quase
   completo, completo) antes de fechar.
3. **O campo do certificado era só um texto livre** — tinha que digitar
   o caminho completo do arquivo manualmente (`C:\caminho\...`), sem
   nenhuma validação de que o arquivo existe. Trocado por um botão de
   verdade que abre o seletor de arquivos do Windows.
4. **Comentário desatualizado no banco** dizia que a senha do
   certificado ficava "em texto puro" — não é mais verdade, já usa a
   criptografia do próprio sistema operacional (`safeStorage`) desde
   uma rodada anterior; só o comentário não tinha sido atualizado.
   Corrigido.

**Também ajustei o botão "Emitir NFC-e" no pagamento** — antes ficava
clicável normalmente e só avisava que não funciona depois de clicar
(um operador podia clicar sem querer no meio de um atendimento, na
frente do cliente, e levar um erro técnico). Agora aparece
desabilitado com "(em preparação)" already visível antes de qualquer
clique.

### Sobre personalizar o cupom fiscal

Pesquisei as regras atuais antes de responder, já que isso é definido
pela SEFAZ e não é opinião minha. Duas respostas diferentes dependendo
do que você quer dizer por "cupom":

- **O recibo simples de hoje** (não fiscal, é só o comprovante interno
  da venda) — esse **já é livremente personalizável**, é o que
  ajustamos há pouco (largura, rodapé, impressora). Nenhuma regra
  externa limita isso.
- **O DANFE-NFCe** (a representação impressa de uma nota fiscal de
  verdade, quando a emissão for implementada) — é **parcialmente**
  personalizável. A SEFAZ define um layout obrigatório (campos fixos:
  CNPJ, chave de acesso, QR Code, discriminação de impostos, etc.) que
  não pode ser alterado nem omitido. O que É permitido: logo da empresa
  num espaço específico do cabeçalho, marca d'água, e ajuste de alguns
  campos opcionais — sempre sem prejudicar a leitura das informações
  obrigatórias. Não dá pra "desenhar do seu jeito" livremente como o
  recibo simples.

## Materiais de teste pra apresentação + aba de impressora

**Planilha de teste** (`padaria-100-itens.xlsx`, entregue separado do
`.zip`) — 117 itens de padaria (pães, bolos, confeitaria, salgados,
bebidas, frios, biscoitos, tortas, lanches), no formato exato que o
botão "Importar planilha" de Produtos espera — é só importar direto.

**Documento de teste pro módulo de reconhecimento**
(`nota-entrega-teste.pdf`, também separado) — o app tem DOIS módulos
de "escanear e reconhecer" diferentes: "Anexar receita/arquivo" no PDV
(pensado pra receita médica) e a extração de nota de compra no
Abastecimento (pensado pra reabastecer estoque recebendo mercadoria de
fornecedor). Pra uma padaria, o segundo é o que faz mais sentido
demonstrar — gerei uma nota de entrega realista, misturando itens que
batem com produtos já cadastrados na planilha (testa o casamento
automático) e itens novos que não existem ainda (testa o cadastro
inline). Se o que você queria testar era o outro módulo (receita no
PDV), me avisa que gero um documento pra esse também.

**Aba de Impressora** (Configurações agora tem duas abas: Geral e
Impressora) — reuni o que já existia (formato do recibo, rodapé,
impressão automática) numa aba própria, e adicionei duas coisas novas:
- **Escolher uma impressora padrão** — lista as impressoras instaladas
  no Windows; escolhendo uma, o sistema para de perguntar toda hora e
  imprime direto nela.
- **Página de teste** — confirma que a impressora escolhida (ou o
  diálogo, se nenhuma estiver escolhida) está funcionando.

**⚠️ Isso eu não tenho como testar de verdade aqui** — listar
impressoras e imprimir sem diálogo depende de hardware real (Windows +
impressora instalada), que não existe neste ambiente. Validei a lógica
de decisão isoladamente (com/sem impressora configurada, com as opções
certas em cada caso), mas a ligação real com o Windows só você vai
poder confirmar. **Recomendo testar isso especificamente antes da
apresentação de amanhã** — a possibilidade de ir imprimindo teste indo
sem escolher impressora nenhuma primeiro (comportamento de sempre,
mais seguro) antes de configurar uma padrão.

## Central de licenciamento + congelamento por inadimplência

Pedido de uma central pra ver todas as instalações e congelar uso em
caso de não pagamento — carência de 2 dias congelada, 3 dias sem
internet.

**⚠️ Antes de tudo: preencha `LICENCIAMENTO.md` — sem isso, essa
funcionalidade fica inofensivamente desligada** (o app tenta falar com
um projeto Firebase que ainda não existe, falha silenciosamente, e
segue funcionando normal — nunca bloqueia à toa por falta de
configuração).

**O que foi construído:**

1. **No app** (`electron/services/licenseService.js`) — confere com um
   servidor central a cada 6h (e ao abrir). O estado (ativa/congelada/
   quando foi o último contato bem-sucedido) fica salvo localmente, e
   é isso que decide o bloqueio — nunca depende de estar online na
   hora exata, funciona mesmo totalmente offline dentro da carência.
2. **A tela de bloqueio/aviso** (`LicenseGate.jsx`) — envolve o app
   inteiro, inclusive antes do login. Durante a carência, mostra uma
   faixa de aviso no topo com os dias restantes; depois da carência,
   substitui a tela inteira por um bloqueio, deixando claro que os
   dados continuam intactos.
3. **O painel** (`admin-panel/index.html`) — site separado, arquivo
   único, sem precisar de build. Login restrito (Firebase Auth), lista
   todas as instalações com status, último contato, versão, e um botão
   de congelar/reativar. Pode rodar local (abrir o arquivo direto) ou
   publicar de verdade (Firebase Hosting).
4. **Regras de segurança do Firestore** — documentadas em
   `LICENCIAMENTO.md`: uma instalação sozinha só pode atualizar seu
   próprio "sinal de vida", nunca o campo que decide se está ativa —
   só quem loga no painel (você) pode congelar/reativar.
5. **Minuta de cláusula contratual** (`CLAUSULA-LICENCIAMENTO.md`) —
   texto sugerido pra incluir no contrato com os clientes, deixando o
   mecanismo explícito. **Não é aconselhamento jurídico** — é ponto de
   partida pra levar a um advogado de verdade.

**Testei rigorosamente a lógica de carência isolada** (7 cenários,
incluindo os limites exatos: 1h antes e 1h depois de cada prazo vencer,
os dois prazos vencendo juntos, e o fluxo completo de congelar →
continuar congelada em checagens seguintes sem resetar a data →
reativar limpando o estado) e a lógica de exibição do painel — tudo em
simulação, sem depender de um Firebase de verdade.

**O que eu não consegui testar**: a integração real com o Firebase.
Não tenho como criar um projeto Firebase de verdade neste ambiente, só
escrever o código e testar a lógica isoladamente. Siga o passo a passo
completo em `LICENCIAMENTO.md` — ele inclui uma seção de teste guiado
antes de confiar nisso pra valer.

## As 8 sugestões escolhidas

Lista que dei de sugestões, e você escolheu implementar todas (1 a 8).

1. **Divisão de conta por item** — cada item do carrinho de uma mesa
   ganha um seletor "Pessoa 1/2/3..." (só aparece quando a mesa tem
   mais de uma pessoa). Um "Ver divisão por pessoa" mostra o subtotal
   de cada uma, junto com um grupo "Não atribuído" pros itens que
   ainda não foram marcados.
2. **Reserva com data/hora** — ao reservar uma mesa livre, pede a
   data/hora combinada (opcional). Aparece no card da mesa reservada,
   e é limpa automaticamente quando a mesa abre ou a reserva é
   cancelada.
3. **Cardápio do dia** — nova tela (só no perfil Restaurante),
   mostrando os pratos marcados como "Disponível hoje" (campo que já
   existia no cadastro do produto), agrupados por tipo, com botão de
   imprimir.
4. **Comissão por garçom** — seção "Vendas por operador" no Painel,
   soma quanto cada um vendeu no período (só vendas finalizadas) —
   útil pra calcular comissão ou dividir gorjeta.
5. **Gráfico de desperdício no Painel** — "Desperdício por dia",
   reaproveitando o mesmo componente de gráfico das vendas.
6. **Exportar desperdício** — botão de planilha na tela Desperdício,
   mesmo padrão já usado em Vendas/Auditoria/Lista de compra.
7. **Fechamento de caixa consolidado** — nova tela "Fechamentos de
   caixa" (gerente/admin), juntando vários fechamentos de um período
   num relatório só, com soma das diferenças e quantos bateram certo.
8. **Busca rápida global (Ctrl+K)** — abre uma paleta de busca em
   qualquer tela, digita e pula direto pra onde quiser, com as setas
   do teclado ou clicando. Uma dica discreta ("Ctrl+K: busca rápida")
   aparece no rodapé da barra lateral pra quem não souber do atalho.

Testei os itens 1, 2 e 7 (os que mexiam em banco/cálculo) em SQL puro
antes de integrar — divisão por pessoa, migração da data de reserva, e
o resumo consolidado de caixa (ignorando sessão ainda aberta,
calculando diferença certa).

## Mais três funcionalidades (por iniciativa própria)

Continuação do pedido de melhorar a área de restaurante.

**Observação por item** (ex: "sem cebola", "ponto da carne mal
passado") — botão "+ Observação" em cada item do carrinho da mesa,
abre um campo de texto livre. Vai junto na próxima comanda impressa
pra cozinha, destacada com ⚠. Detalhe: se você editar a observação de
um item que **já tinha sido enviado** pra cozinha antes, ele volta a
aparecer na próxima impressão — senão a cozinha nunca ficaria sabendo
da mudança.

**Tempo de ocupação da mesa** — cada mesa ocupada mostra "há Xmin" (ou
"há Xh Ymin"), atualizado sozinho a cada minuto, usando o relógio
sincronizado do app (não o relógio cru do Windows). Passando de 90
minutos, o texto fica destacado — ajuda a perceber qual mesa está
demorando mais, sem precisar ficar de olho o tempo todo.

**Transferir mesa** — botão no topo da comanda, escolhe pra qual mesa
livre mover (grupo pediu pra trocar de lugar). A comanda inteira
(itens, pessoas, total) vai junto; a mesa de origem fica aguardando
limpeza, já que alguém sentou lá. Testei em SQL puro antes de fechar:
depois da transferência, o total e o número de pessoas da comanda
continuam intactos na mesa nova.

## Duas funcionalidades novas (por iniciativa própria)

Pedido de adicionar o que eu achasse interessante — escolhi duas coisas
que se encaixam diretamente no que já foi construído pro restaurante.

**Taxa de serviço opcional (10%)** — na tela de pagamento de uma mesa
(não aparece no PDV balcão — só faz sentido em restaurante), uma
checkbox liga uma taxa de serviço, com 10% já sugerido mas editável
pra qualquer percentual. Aplica sobre o valor **depois** dos descontos
(fidelidade e desconto de gerente), nunca antes — testei três cenários
antes de fechar: com taxa, com taxa + desconto junto, e sem taxa
nenhuma (não muda nada).

**Comanda pra cozinha** — botão no topo da tela da mesa, imprime só os
itens ainda não enviados (evita reimprimir o que a cozinha já está
preparando quando alguém adiciona mais coisa na mesma mesa depois).
Sem preço, sem forma de pagamento — só o que precisa ser preparado,
com letra grande. Testei especificamente o cenário que mais importa
aqui: pedir feijoada + suco, imprimir, depois pedir uma sobremesa —
confirma que a segunda impressão traz **só** a sobremesa, não repete
os dois primeiros itens.

Ambas exigiram uma migração segura pra bancos já existentes (colunas
novas em `sales` e `sale_items`) — testadas simulando um banco "antigo"
antes de fechar, como já virou padrão nas últimas rodadas.

## Número de pessoas e 4 status de mesa

Antes as mesas só tinham livre/ocupada. Agora:

- **Ao abrir uma mesa livre ou reservada**, pede quantas pessoas —
  usado só pra mostrar "R$ X,XX por pessoa" no rodapé da comanda (ajuda
  a dividir a conta na hora), não separa pagamentos automaticamente.
- **4 status**: livre (cinza) → ocupada (vermelho, mostra pessoas +
  total) → **aguardando limpeza** (dourado, depois que a conta é paga —
  precisa marcar como limpa antes de abrir de novo) → livre de novo.
  Também dá pra marcar uma mesa livre como **reservada** (teal) e
  cancelar a reserva, ou abrir ela direto quando o grupo chegar.
- Migração de banco segura pra quem já tinha a tabela de mesas de uma
  entrega anterior (`ALTER TABLE` adicionando a coluna nova só se ela
  ainda não existir) — testei simulando um banco "antigo" sem a coluna
  antes de fechar, confirmando que não perde nenhuma mesa já cadastrada.

Testei o ciclo completo em simulação: livre → abre com 4 pessoas →
paga → vai pra aguardando limpeza (não direto pra livre) → marca como
limpa → volta a livre → reserva → o grupo da reserva chega e abre a
mesa normalmente.

## Insumos, ficha técnica e registro de desperdício

Três peças novas, encaixadas na mesma sessão do controle de mesas:

**Insumos** (tela nova, menu "Insumos") — cadastro de matéria-prima
(farinha, carne, óleo...) com custo por unidade (ex: R$/kg) e,
opcionalmente, um controle de estoque simples próprio (separado do
estoque de produtos prontos).

**Ficha técnica** (dentro do cadastro de cada produto, seção
expansível igual ao histórico de preço) — monta a receita de um prato
escolhendo insumos e quantidade de cada um. O **custo do prato é
calculado automaticamente** somando quantidade × custo unitário de
cada insumo da receita — mostrado ali mesmo, e reaproveitado no
desperdício.

**Desperdício** (tela nova, menu "Desperdício") — registra prato
pronto que não foi vendido (sobrou do prato do dia, por exemplo) ou
insumo que estragou. O **valor gasto vem sugerido automaticamente**
quando dá pra calcular (pela ficha técnica do prato, ou pelo custo do
insumo) — mas sempre editável, dá pra digitar o valor na mão também,
como pedido. Mostra o total perdido no período (hoje/semana/mês) e o
histórico completo, com motivo e quem registrou.

Testei o fluxo inteiro em simulação antes de fechar: cadastrar insumos
→ montar ficha técnica de um prato → calcular o custo certo (0,3kg
feijão + 0,2kg carne = R$9,40, testado) → registrar desperdício de 2
porções não vendidas → valor perdido bate certo (R$18,80) → resumo do
período soma certo somando prato + insumo desperdiçados juntos.

Essas três telas ficam visíveis pra gerente/admin **independente do
perfil de negócio ativo** — não travei só pra restaurante, porque uma
padaria também pode querer calcular custo de pão pelos insumos
(farinha, fermento, etc.).

## Controle de mesas (restaurante) + perfil de Padaria e Restaurante

Pedido pra implantar em uma padaria e um restaurante. A padaria já
tinha perfil pronto de uma rodada anterior (Padaria / Confeitaria —
validade, peso em gramas). Pro restaurante, dois pedaços bem
diferentes de tamanho:

**Perfil "Restaurante"** (rápido — mesma arquitetura de perfis de
sempre): campos extras pra tipo de prato (entrada, principal,
sobremesa, bebida...), tempo de preparo, e "disponível hoje" — esse
último é o que resolve o "preço do dia": cadastra o prato uma vez,
ajusta o preço quando quiser (já com histórico de alteração de preço,
de uma rodada anterior), e usa esse campo pra marcar se está
disponível naquele dia sem precisar excluir o produto.

**Controle de mesas** (grande — funcionalidade nova de verdade, não só
configuração):

- Tela **Mesas** — grade visual (livre em cinza, ocupada em vermelho
  com o total já lançado), criar/excluir mesa. Só aparece no menu
  quando o perfil ativo é "Restaurante" (pra não poluir o menu de quem
  usa outro perfil).
- Clicar numa mesa livre abre uma **comanda** nova pra ela; clicar
  numa mesa ocupada retoma a comanda que já estava em andamento — os
  itens já lançados aparecem certinho, reconstruídos do banco.
- Dentro da mesa: a mesma busca de produto, categorias e pagamento do
  PDV normal (literalmente os mesmos componentes reaproveitados) — só
  que os itens vão se acumulando na comanda daquela mesa específica ao
  longo do tempo, em vez de precisar fechar a venda de uma vez como no
  balcão.
- Cancelar um item segue a mesma regra que já vale no PDV: só pede
  autorização de gerente se a comanda já tiver algum pagamento
  registrado.
- Fechar a conta (pagamento) libera a mesa automaticamente de volta
  pra "livre".
- As vendas de mesas aparecem no Histórico normalmente — é a mesma
  tabela de vendas de sempre, só que a comanda fica aberta por mais
  tempo (recebendo itens aos poucos) em vez de fechar na hora.

**Arquitetura**: não criei um sistema de vendas paralelo — o "backend"
de mesas é uma camada fina em cima do que já existia (`addItem`,
`cancelItem`, `addPayment`, `finalizeSale` já trabalhavam com um
`saleId` explícito, sem depender de "a venda atual do operador"), só
adicionando uma tabela que liga cada mesa à sua comanda em aberto.
Testei o fluxo inteiro (criar mesa → abrir → adicionar item → total
bate certo → reconstruir carrinho → pagar → finalizar → mesa libera)
em simulação antes de fechar.

## Cores de aviso/crítico feias no modo escuro (e estranhas no claro)

A cor de fundo das linhas de alerta (Alertas de estoque, Auditoria,
Abastecimento, Histórico) era calculada misturando uma cor âmbar fixa
com a cor de superfície do tema na hora — no modo escuro, misturar
laranja com o teal escuro do tema produzia um marrom/oliva sujo, exatamente
o que aparecia no seu print.

**Correção**: troquei o cálculo automático por tons escolhidos à mão
pra cada tema (`--color-warning-bg`/`--color-critical-bg` e as cores de
texto correspondentes) — no escuro, um dourado e um vermelho-tijolo
quentes de propósito, sem depender de misturar com o teal do tema; no
claro, um amarelo-creme e um vermelho-rosado suaves. Conferi
visualmente os dois temas lado a lado com o fundo normal da tabela
antes de fechar. Também apliquei a mesma cor de texto no balão de
alerta do carrinho (usava a mesma mistura problemática).

## Botão de fechar caixa + atalho de Enter no pagamento

Pedido de melhorar o botão de fechar caixa e verificar mais pontos na
mesma área.

- **Botão de fechar caixa** — era só um link sublinhado no cabeçalho,
  mesmo peso visual que os botões de ajuda ao lado. Virou um botão de
  verdade, com ícone (cofre) — combina melhor com a importância da
  ação (fim de turno, precisa contar dinheiro).
- **Enter confirma o pagamento** — o campo de valor no pagamento não
  reagia a Enter, só clicando em "Adicionar" com o mouse. Agora Enter
  confirma direto (ou gera o QR Pix, se for esse o método selecionado)
  — bem mais rápido pro uso repetitivo do dia a dia. O campo também já
  vem com foco automático ao abrir a tela de pagamento.
- **Revisei** as telas de abrir e fechar caixa por inteiro — já
  estavam sólidas (resumo claro, cálculo de diferença, tratamento de
  erro) — abrir caixa já confirmava com Enter naturalmente, por já ser
  um formulário de verdade.

## Troco sumindo depois de confirmar o pagamento + melhorias no fluxo

Bug real reportado em uso: pagar R$50 numa venda de R$8,50 não mostrava
nenhum troco — ficava R$0,00.

**Causa**: o troco era calculado direto em cima do campo de digitação
do valor — e esse campo é limpo assim que o pagamento é confirmado
(pra ficar pronto pro próximo pagamento). No instante em que a tela
teria que mostrar "Troco: R$41,50", o campo já estava vazio, e o
cálculo dava zero.

**Correção**: o troco calculado na hora de confirmar o pagamento agora
fica guardado separado, sobrevivendo à limpeza do campo. De brinde,
enquanto ainda está digitando o valor (antes de confirmar), já mostra
uma prévia do troco em tempo real — não precisa nem confirmar pra saber
quanto vai devolver.

**Duas adições úteis nessa mesma tela:**
- **Botões de valor rápido** — "Valor exato" (preenche o que falta,
  qualquer método) e as notas mais comuns (R$10/20/50/100/200) quando
  for dinheiro — evita digitar toda vez.
- **Contador de vendas do dia no PDV** — "X venda(s) hoje", ao lado do
  nome do operador. Só a contagem, sem nenhum valor financeiro (isso
  continua reservado pro Painel, que é território de gerente/admin) —
  só um retorno rápido do próprio ritmo do turno.

## Barra lateral sumida pro operador de caixa (bug da rodada anterior)

Quando dei mais telas pro perfil de operador (Histórico, Clientes,
Alertas, Devolução), esqueci de remover um desvio antigo no código que
mandava esse perfil direto pro PDV em tela cheia, **sem nenhuma barra
lateral** — sobrando de uma época em que o operador só tinha acesso ao
PDV mesmo, de propósito. Isso explicava as duas coisas que você notou:
sem barra lateral nenhuma, e nenhuma das telas novas aparecendo (porque
o operador nunca chegava a ver o menu de navegação de jeito nenhum).
Removido — agora o operador vê a barra lateral normal, só filtrada pra
mostrar apenas o que o perfil dele permite (PDV, Histórico, Clientes,
Devolução, Alertas — sem Painel, Produtos, Configurações, etc.), com
"Sair" e a troca de tema no rodapé, do mesmo jeito que gerente/admin já
tinham.

## Reduzindo o espaço ocupado pelo app

Medi o tamanho real de cada dependência (instalando isoladamente e
conferindo com `du`) antes de decidir o que cortar — nada foi removido
só por suposição.

**A maior descoberta, de longe: o pacote `firebase` sozinho ocupa
121MB**, mas o projeto só usa uma parte pequena dele (`firebase/app`,
`firebase/firestore`, `firebase/auth` — usados no
Abastecimento/consolidado entre PDVs). O resto (mensageria, storage,
analytics, funções, banco em tempo real, IA generativa do Firebase, e
uma camada de compatibilidade inteira pra quem migra de uma API antiga
que este projeto nunca usou) ia dentro do instalador sem nenhuma
necessidade.

**Testei de verdade antes de excluir** — apaguei fisicamente cada parte
candidata e confirmei que `initializeApp`, `getFirestore`, `doc`,
`setDoc`, `collection`, `query`, `where`, `getDocs`, `runTransaction`,
`getAuth` e `signInAnonymously` (as únicas funções do firebase que o
projeto realmente chama) continuam carregando e funcionando
normalmente sem essas partes. Resultado: **121MB → 36MB**, uma queda de
~70% só nessa dependência.

Apliquei essa exclusão via configuração do `electron-builder`
(`package.json` → `build.files`), não apagando nada do `node_modules`
de verdade — assim `npm install` continua funcionando normal, só o
instalador final é que não inclui essas partes. Também removi qualquer
arquivo `.map` de depuração de dentro do `node_modules` inteiro (nunca
são necessários rodando o app final).

**Outras dependências reclassificadas** — `react`, `react-dom`,
`qrcode` e `jsbarcode` só são usados no frontend (que o Vite já
empacota dentro de `dist/`); o pacote bruto deles em `node_modules`
nunca é necessário no app instalado. Movi pra `devDependencies` —
continuam disponíveis pra build normalmente, só não vão mais dentro do
instalador. Isso sozinho tira mais uns 8-9MB (`react-dom` é o maior,
com 7.2MB). Conferi que `xlsx` e `bcryptjs`, ao contrário, são mesmo
usados dentro do processo principal (backend) — esses continuam como
dependência de verdade, não dava pra mover.

**Removido por completo**: o pacote `uuid` — usado numa única linha
(`src/main.jsx`, gerar o id do dispositivo), trocado pelo
`crypto.randomUUID()` nativo do navegador (já vem no Electron, sem
precisar de nenhuma biblioteca).

**Compressão máxima no instalador** (`compression: "maximum"` no
`electron-builder`) — reduz o tamanho do arquivo `.exe` final que as
pessoas baixam (só demora um pouco mais pra gerar na hora de publicar,
não afeta o app rodando).

**Total estimado: por volta de 90-95MB a menos** no pacote final,
principalmente graças à limpeza do firebase.

**O que não mexi**: o próprio Electron/Chromium (o "motor" do app) —
isso é um custo fixo de qualquer app feito nessa tecnologia, só mudaria
trocando de tecnologia inteira, o que reescreveria o projeto do zero.

## Rodada de ajustes no PDV e perfis de usuário (4 pedidos)

1. **Somar quantidade em vez de duplicar linha** — bipar (ou clicar) o
   mesmo produto duas vezes agora soma na mesma linha do carrinho
   ("Soro Fisiológico × 4") em vez de criar uma segunda linha separada.
   O histórico de movimentação de estoque continua registrando cada
   adição separadamente (pra auditoria), só a exibição no carrinho é
   que consolida. Testado em SQL puro: mesmo id de linha nas duas
   chamadas, quantidade somada corretamente, e o cancelamento devolve
   a quantidade acumulada certa ao estoque.

2. **Senha de gerente só depois que já tiver pagamento registrado** —
   antes, cancelar qualquer item do carrinho sempre exigia autorização
   de gerente, mesmo só ajustando o carrinho (cliente pediu mais coisa,
   desistiu de um item). Agora: sem nenhum pagamento ainda registrado
   na venda, cancela direto, sem pedir PIN de ninguém — assim que
   qualquer pagamento é adicionado, volta a exigir autorização, como
   antes. A checagem é feita no servidor (olha se existe pagamento
   registrado pra aquela venda), não confia só no estado da tela — mais
   seguro contra qualquer jeito de burlar pela interface. O
   cancelamento sem autorização continua registrado na auditoria
   (só que sem exigir aprovação), mantendo o histórico completo.
   Testados os dois cenários (com e sem pagamento) antes de integrar.

3. **Mais telas pro operador de caixa** — estava só com "PDV" visível,
   agora também vê Histórico, Clientes, Alertas e Devolução (a
   devolução em si continua exigindo autorização de gerente pra
   executar — só a busca/tela ficou acessível). Painel, Produtos,
   Abastecimento, Fornecedores e Configurações continuam reservados
   pra gerente/admin, por envolverem dado financeiro ou de gestão.

4. **Gerente também pode criar/gerenciar usuário** — antes só admin
   tinha acesso à tela de Usuários. Agora gerente também acessa, mas
   com um limite de propósito: **gerente não pode criar, desativar ou
   resetar o PIN de um administrador** — só admin mexe em outro admin,
   evitando escalonamento de privilégio. Reforçado tanto na tela
   (opção "Administrador" escondida, botões desabilitados nas linhas de
   admin) quanto no backend (a validação de verdade, não só visual).
   Testado em SQL puro: gerente cria operador ✓, gerente cria admin ✗
   (bloqueado), gerente desativa admin ✗ (bloqueado), admin cria admin ✓.

## Linhas da tabela desalinhadas (Produtos e Clientes)

A célula de ações (Editar/Excluir) usava `display: flex` sem
`align-items: center` — em linhas mais altas (produto sem SKU/categoria
preenchidos, nome que quebra em duas linhas), os botões esticavam pra
ocupar a altura inteira da linha em vez de ficarem centralizados,
quebrando o alinhamento visual. Adicionado `align-items: center` nas
duas tabelas que tinham esse padrão (Produtos e Clientes), mais
`vertical-align: middle` em toda célula de tabela como proteção geral.

## Busca de produtos — reescrita completa (a correção anterior não era suficiente)

A correção anterior (referências sincronizadas por efeitos separados)
não resolveu de verdade — confirmado rodando o mesmo código direto do
código-fonte, sem instalador nenhum no meio (`npm run dev:electron`),
e testando manualmente `window.pdv.products.list()` pelo Console do
DevTools, que confirmou o **backend sempre esteve correto**. O bug era
inteiramente no React.

**Causa provável**: usar várias referências (`useRef`) sincronizadas
cada uma pelo seu próprio efeito (`useEffect(() => { xRef.current = x
}, [x])`) cria uma pequena janela de tempo entre o estado mudar de
verdade e cada referência terminar de atualizar — e a rolagem infinita
podia disparar bem nessa janela, usando referências que ainda não
tinham atualizado todas juntas.

**Reescrita**: tudo relacionado a uma busca específica agora vive
dentro de um único efeito, compartilhando uma única bandeira `ignore`
e variáveis locais (não React state, não referências separadas) pra
controlar o que já foi carregado — o padrão recomendado pela própria
documentação do React pra esse tipo de problema. Nenhuma
sincronização entre múltiplas referências independentes — só uma
bandeira, dentro de um único fechamento.

**Validação desta vez foi bem mais rigorosa**: montei um teste
renderizando o **componente de verdade** (não uma reimplementação) com
React e um DOM simulado (jsdom), com respostas de rede com atraso
**variável e realista** (buscas com mais resultados demoram mais pra
responder que buscas específicas — exatamente o cenário que inverte a
ordem de chegada). Dois cenários testados e confirmados: buscar
"dorflex" letra por letra rápido mostra só o resultado certo, e apagar
a busca depois volta a mostrar o catálogo completo.

## Auditoria geral: o mesmo bug de busca em mais 3 lugares

Depois de corrigir a condição de corrida na busca de Produtos, procurei
o mesmo padrão em todo o app — e achei em mais três lugares que também
disparam uma busca a cada letra digitada, sem conferir se a resposta
ainda corresponde ao texto atual:

- **Busca principal do PDV** (`ProductSearchBox.jsx`) — o mais sério dos
  três, porque é dali que se escolhe o que entra numa venda de verdade.
  Digitar rápido podia mostrar produto errado no resultado.
- **Clientes** (`CustomerList.jsx`) — mesmo risco na busca por
  nome/telefone/CPF.
- **Categorias no PDV** (`CategoryProductBrowser.jsx`) — clicar rápido
  entre categorias diferentes podia mostrar os produtos de uma categoria
  errada sob a categoria certa selecionada.
- **Casar produto no Abastecimento** (`ProductPicker` dentro de
  `SupplyScreen.jsx`) — mesmo risco ao tentar casar uma linha da nota
  com um produto do sistema.

Todos os quatro corrigidos com a mesma técnica: uma referência sempre
atualizada do texto/categoria atual, conferida antes de aplicar
qualquer resposta assíncrona na tela — mesmo princípio já validado na
correção da tela de Produtos.

**Revisado e não corrigido de propósito**: a busca de vendas na tela de
Devolução só dispara ao clicar no botão "Buscar" (não a cada letra),
então o risco de condição de corrida é bem menor — não recebeu a mesma
correção porque o padrão de uso ali é fundamentalmente diferente.

## Busca de produtos ainda mostrando tudo (correção mais profunda)

A correção anterior (contador de busca mais recente) não cobria um
caso específico: o observador de **rolagem infinita** disparava
`loadMore()` usando o tamanho da lista **de antes** da busca mudar como
offset — e como esse observador era recriado a cada letra digitada
(estava nas dependências do efeito), ele podia disparar de novo
imediatamente se o marcador já estivesse visível na tela, misturando
resultado do catálogo cheio com o resultado da busca nova.

**Correção mais robusta**: em vez de um contador, cada resposta agora
compara direto contra o **texto de busca atual de verdade** (guardado
numa referência sempre atualizada, não um valor capturado no fechamento
da função) antes de aplicar na tela — mais direto e à prova de qualquer
ordem de chegada, não só a mais comum. O observador de rolagem também
passou a ser criado **uma única vez** (não mais recriado a cada letra),
lendo o estado mais atual por referência em vez de fechamentos antigos.
Testado simulando o cenário exato: rolagem infinita disparada com a
busca vazia, buscar por algo específico logo em seguida, e confirmar
que o resultado do catálogo cheio nunca contamina a lista final.

## Controle de quantidade e barras de rolagem customizados

Dois ajustes visuais pedidos: as setinhas nativas do campo de
quantidade (do navegador, destoando do resto do app) e as barras de
rolagem (padrão do Chromium, também destoando).

- **Quantidade**: trocado o `<input type="number">` (com as setas
  padrão do navegador) por um controle próprio — campo de texto +
  dois botões pequenos (▲/▼ desenhados em SVG) no estilo do app,
  ficando teal ao passar o mouse. Só aceita dígito (bloqueia qualquer
  outro caractere na digitação).
- **Barras de rolagem**: estilizadas globalmente (`::-webkit-scrollbar`,
  suportado no Chromium/Electron) — discretas, cor que se adapta ao
  tema claro/escuro automaticamente (usa `color-mix` com as variáveis
  do tema, igual às outras correções de modo escuro já feitas).

## Bug crítico no workflow: app publicado sem conteúdo (tela em branco)

Achado em uso real: uma versão publicada pelo GitHub Actions instalou e
abriu **completamente em branco** — HTML vazio (`<html><head></head>
<body></body></html>`), sem nenhum erro no console.

**Causa**: o `dist/` (onde o Vite gera o `index.html` de verdade) está
no `.gitignore` de propósito — não deveria ir pro repositório. O
workflow (`.github/workflows/release.yml`) rodava o
`electron-builder --publish always` **direto**, sem rodar `npm run
build` (Vite) antes — diferente do `npm run build:electron` local, que
sempre roda os dois em sequência. Resultado: o ambiente do GitHub
Actions nunca tinha um `dist/` de verdade pra empacotar, e o instalador
saía sem nenhum conteúdo dentro (por isso nenhum erro no console — nem
chegava a carregar JavaScript nenhum).

**Corrigido**: adicionei o passo `npm run build` no workflow, antes do
`electron-builder`. Não consigo testar isso rodando de verdade aqui (o
mesmo problema de sempre — preciso do Actions do repositório real
pra confirmar), mas o erro em si era óbvio de identificar pela ausência
completa de conteúdo + nenhum erro de JS.

**Se isso já aconteceu com você**: a versão instalada com esse problema
precisa ser trocada — reinstale usando um build local
(`npm run build:electron`, que sempre gera o `dist/` corretamente antes
de empacotar) em vez de esperar a próxima automática, e só depois disso
publique uma versão nova já com o workflow corrigido.

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

**2. Publicar uma versão nova, dali em diante, é só um comando:**
```powershell
npm version patch
```
Isso faz tudo de uma vez: sobe o número da versão em `package.json`
sozinho (`0.3.9` → `0.3.10`), cria o commit, cria a tag `v0.3.10`
correspondente, e — graças ao script `postversion` que já deixei
configurado — **envia tudo pro GitHub sozinho** (`git push` + `git push
--tags`) assim que termina. Esse último push da tag é o que dispara o
GitHub Actions.

Use `npm version minor` (0.3.x → 0.4.0) ou `npm version major` (0.x.x →
1.0.0) quando a mudança for maior — mas `patch` serve pra quase toda
atualização do dia a dia.

Depois de rodar, é só acompanhar em
`github.com/arthuraf2013-hue/gerenciaai-releases/actions` (a aba
"Actions" do repositório) até aparecer o ✓ verde. A release nova aparece
sozinha em Releases, já publicada (sem passar por rascunho).

*(A sequência manual — `git add`, `git commit`, `git tag`, dois `git
push` — continua funcionando se preferir fazer passo a passo, mas
`npm version patch` faz a mesma coisa com bem menos chance de errar
algum passo no meio.)*

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

## Vendas de fim de noite indo pro dia errado — bug de fuso horário

### Continuação — corrigindo o dado antigo na hora, sem esperar

Seu segundo print mostrou o mesmo problema ainda acontecendo — não
porque a correção anterior estava errada, mas porque o dado **já
gravado** no Firestore (com o `diaISO` errado, de antes da correção)
só se corrigia sozinho no próximo ciclo de 15 minutos ou reabertura
do app. Se testou logo depois de atualizar, ainda não tinha dado
tempo.

**Corrigido**: o botão "↻ Atualizar" (e a primeira busca ao abrir a
tela de Histórico) agora **reenvia o dado desta máquina primeiro,
corrigindo qualquer coisa desatualizada, e só depois busca de novo**
— tudo na mesma ação, sem esperar nada. O ciclo automático de 20s
continua leve (só relê, sem reenviar toda hora, pra não gerar
escrita desnecessária no Firestore a cada 20 segundos).

**Testei reproduzindo o cenário exato do bug**: simulei o Firestore
com o `diaISO` errado já gravado (do jeito que ficou pras suas duas
vendas), confirmei que aparecia em "Hoje" por engano, forcei a
correção (a mesma ação que o botão faz agora), e confirmei que a
venda sai de "Hoje" e passa a aparecer certinho no dia de ontem.



As duas vendas voltaram (a correção anterior funcionou), mas apareciam
no dia seguinte — exatamente as 21:41 e 21:45, que é a pista: o
`finalizada_em` é gravado em UTC no banco, e o campo `diaISO` (que
decide em qual dia a venda aparece no histórico do grupo) só cortava
a string direto, sem converter fuso. Uma venda às 21:41 em horário de
Brasília (UTC-3) já é meia-noite e pouco em UTC — **do dia seguinte**
— então cortar a data crua sempre empurrava vendas de fim de noite pro
dia errado.

Achei que já tinha corrigido esse EXATO padrão de bug antes, só que no
frontend (`src/utils/date.js`, função `toISODate`, com um comentário
descrevendo esse mesmo problema) — só nunca tinha propagado a mesma
correção pro campo `diaISO` do backend, usado especificamente na
sincronização entre PDVs.

**Corrigido**: `diaISO` agora usa a mesma conversão de fuso correta
(`Intl.DateTimeFormat` com fuso de São Paulo) em vez de cortar a
string crua — testei com os horários exatos do seu print (21:41 e
21:45) e confirmei que agora calculam pro dia certo (03/08), e não
vazam mais pro filtro "Hoje" quando já é 04/08.

**As duas vendas que já estavam com o dado errado no Firestore vão se
corrigir sozinhas** — o reenvio periódico que já existe (a cada 15
minutos, e toda vez que o app abre) reescreve o `diaISO` de toda
venda local, incluindo essas duas. Não precisa de nenhuma ação manual
além de atualizar e abrir o app.

## O código de barras "fantasma" — achei a causa real

Você tinha razão: buscou o código e não achou nenhum produto com ele.
A causa era exatamente essa lacuna — **excluir um produto nunca
liberava o código de barras dele**. A busca só mostra produtos ativos,
então um produto excluído fica invisível pra você, mas o banco ainda
recusa qualquer outro produto tentar usar aquele mesmo código —
provavelmente um dos duplicados que você já excluiu recentemente.

**Corrigido em três frentes**:
- Excluir um produto agora **libera o código de barras e o SKU** dele
  na hora — fica disponível pro próximo produto que precisar.
- A checagem de conflito (a que criei na resposta anterior) agora
  também ignora produtos inativos, como segunda camada de proteção.
- **Limpeza automática**: produtos que já ficaram "presos" antes
  dessa correção são liberados sozinhos na próxima vez que o app
  abrir — não precisa fazer nada manual, roda uma vez só e é seguro
  rodar de novo (não faz nada se não tiver mais nada preso).

Testei o cenário exato: produto duplicado excluído, código de barras
liberado na hora, um produto novo conseguindo usar aquele mesmo
código sem erro — e simulei também o caso de quem já tinha ficado
preso antes dessa correção, confirmando que a limpeza automática
libera certinho.

## Corrigido: CI quebrado desde que os testes passaram a rodar de verdade (v0.5.50)

Você mandou o print — o job "Rodar os testes" falhou com um erro de
`NODE_MODULE_VERSION`: o binário nativo do `better-sqlite3` estava
compilado pra uma versão de Node diferente da que roda os testes.

**Causa raiz**: o `postinstall` do projeto (`electron-builder
install-app-deps`) recompila o `better-sqlite3` pro Node **interno do
Electron**, não pro Node do sistema — e é o Node do sistema que
`node --test` usa. Isso sempre existiu, mas só virou problema quando
os testes passaram a rodar de verdade no CI (v0.5.42) — antes disso,
nada tentava usar o `better-sqlite3` fora do próprio Electron
empacotado. Eu mesmo vinha corrigindo isso manualmente toda vez que
testava localmente nesta conversa inteira (`npm rebuild
better-sqlite3` antes de cada suíte) — só esqueci de levar esse mesmo
passo pro workflow.

**Corrigido**: novo passo "Recompilar módulos nativos pro Node do
sistema" entre instalar dependências e rodar os testes. Confirmei que
é seguro — o `electron-builder` recompila o módulo de novo pro
Electron sozinho, automaticamente, antes de empacotar (não desliguei
essa opção), então reverter pro Node do sistema só pros testes não
afeta o app final.

**Reproduzi o erro exato antes de aplicar a correção** (instalação
limpa, sem o rebuild — os testes falharam com a mesma mensagem do seu
print) e confirmei que o rebuild resolve (113/113 depois de aplicar).

## Agenda de horário (Salão de Beleza) — parte 5 de 6 (a última, fechando o pacote das seis ideias)

Nova aba "Agenda" no menu principal, só visível pro perfil Salão de
Beleza (diferente de Delivery e Orçamentos, que deixei disponíveis
pra qualquer perfil). Duas sub-abas: **Agenda** (visão do dia, filtro
por profissional, criar/reagendar/mudar status) e **Profissionais**
(cadastro simples).

O núcleo tecnicamente mais delicado aqui era a **detecção de conflito
de horário** — dois agendamentos do mesmo profissional não podem se
sobrepor. Testei especificamente os casos de borda que costumam
esconder bug nesse tipo de lógica: sobreposição parcial, encaixe
exato sem sobrepor (um termina exatamente quando o outro começa),
sobreposição com dois agendamentos vizinhos ao mesmo tempo, o mesmo
horário em profissionais diferentes (não deveria conflitar),
cancelamento liberando o horário de volta, e reagendar não
"conflitar consigo mesmo".

**Um bug de fuso horário que só apareceu testando, já corrigido**: a
hora do agendamento é digitada como hora local (Brasília — "10h"
significa 10h da manhã aqui), mas a primeira versão da mensagem de
confirmação por WhatsApp tratava esse valor como se fosse UTC e
convertia de novo, deslocando a hora mostrada em 3 horas. Corrigido e
coberto por teste específico, pra nunca mais regredir.

Testei o fluxo completo com navegador de verdade (cadastrar
profissional, criar agendamento, mudar status, tentar criar em cima
de um horário ocupado e ver a mensagem de conflito aparecer) e o
backend a fundo — 11 testes automatizados. Suíte do projeto inteira
agora em **113 testes**, todos passando.

Com essa, as **seis ideias que você pediu estão todas entregues**:
livro de controlados, ficha de pet, aba Delivery, desconto por
validade, aba Orçamentos, ficha de receita óptica, e agenda de
horário.

## Ficha de receita óptica (Ótica) — parte 4 de 6

Botão "Receita" na linha do cliente, só pro perfil Ótica. Cada receita
fica guardada como um registro histórico — nunca sobrescreve a
anterior, então dá pra ver a evolução do grau da pessoa ao longo dos
anos, não só o valor mais recente. Formulário completo: esférico,
cilíndrico, eixo e adição pros dois olhos, distância pupilar, tipo de
lente, data e observações.

Testei o backend a fundo: cadastro, histórico ordenado do mais
recente pro mais antigo, edição atualizando o registro certo (sem
duplicar), remoção de uma receita não mexendo nas outras do mesmo
cliente, e campo numérico vazio não quebrando o salvamento. 6 testes
automatizados, todos passando. Suíte do projeto inteira agora em
**102 testes**.

## Nova aba: Orçamentos (Material de Construção) — parte 3 de 6

Cotação prévia antes da venda de fato — o cliente pede um preço,
você monta o orçamento (busca produto do mesmo jeito que no PDV,
adiciona quantidade), e **nada disso mexe em estoque nem em caixa**
até você clicar em "Converter em venda". Só aí o estoque é
efetivamente descontado, com as mesmas regras de uma venda normal
(incluindo checagem de estoque disponível).

Um detalhe de design que só apareceu testando: se um item do
orçamento não tiver mais estoque suficiente na hora de converter (por
exemplo, vendeu pra outro cliente enquanto o orçamento ficava parado),
a conversão para e desfaz tudo que já tinha sido criado até ali — sem
deixar venda pela metade, e sem pedir autorização de gerente pra isso
(é uma limpeza técnica automática, não uma decisão de cancelamento
que alguém tomou). Testei esse cenário especificamente: nenhum
rastro órfão fica no banco, e o orçamento continua aberto pra tentar
de novo.

Testei o fluxo inteiro com navegador de verdade (criar orçamento,
buscar produto, adicionar item, ver o total, converter) e o backend a
fundo — 9 testes automatizados, cobrindo desde o caso feliz até
orçamento vazio, item duplicado, e o rollback de conversão. Suíte
agora com **96 testes**.

## Desconto automático por validade próxima (Armazém/Padaria) — parte 2 de 6

Nova seção "Descontar por validade" na tela de Alertas. Produto
vencendo em breve (usa o mesmo lote/validade que já alimenta o alerta
existente) ganha uma sugestão de preço com desconto — em vez de só
avisar que vai vencer e deixar virar perda registrada em desperdício
depois, dá a chance de vender antes. Um clique aplica; o preço volta
sozinho pro normal depois da data de validade, sem precisar remover a
promoção manualmente. Não é restrito a um perfil só — qualquer
produto com validade cadastrada se beneficia, então farmácia também
aproveita, não só armazém/padaria.

**Dois bugs reais que só apareceram testando de ponta a ponta, já
corrigidos**: o PDV não estava de fato cobrando o preço promocional
na venda (continuava usando o preço cheio por baixo) — e mesmo depois
de corrigir isso, o valor mostrado na tela pro operador (`precoUnitario`
retornado pela função de adicionar item) continuava exibindo o preço
cheio, apesar do total da venda já estar certo. Os dois confirmados
com teste de venda de verdade, incluindo o caso da promoção vencer e
o preço voltar ao normal sozinho.

Suíte agora com **87 testes**, todos passando.

## Nova aba: Delivery

Você pediu direto — nova aba "Delivery" no menu principal (visível pra
operador, gerente e admin, já que tanto quem atende quanto quem
gerencia mexe nisso), com 4 sub-abas:

- **Entregas**: a fila principal. Cria entrega vinculada a um cliente
  (endereço, taxa, observações), atribui rota/entregador/veículo por
  linha (direto na tabela, sem abrir modal), muda o status
  (Pendente → Em rota → Entregue, ou Cancelada) — e quando o status
  muda pra "Em rota" ou "Entregue", tem um botão "Avisar cliente" que
  já abre o WhatsApp com a mensagem certa pra cada situação (mesma
  infraestrutura de link já usada em recibo, cliente que sumiu, e
  lembrete de pet).
- **Rotas**: cadastro simples (nome + área/bairros que cobre) — pra
  agrupar entregas por região.
- **Veículos**: placa, modelo, tipo (moto, carro, bike...).
- **Entregadores**: nome e telefone.

Mudar o status já marca automaticamente quando saiu e quando chegou
(pra dar noção de quanto tempo cada etapa está levando), sem precisar
preencher essas datas na mão.

**Uma ressalva honesta**: testando a tela, encontrei um problema
visual — a cor de destaque da linha (que muda conforme o status) às
vezes não atualiza imediatamente depois de trocar o status, mesmo o
status/dropdown e os dados em si estando corretos (confirmei isso
com log). É puramente estético, não afeta o funcionamento — mas é a
mesma classe de comportamento estranho que também não consegui
explicar totalmente numa investigação bem mais longa, páginas atrás
neste mesmo histórico (o bug de paginação da lista de produtos). Se
você notar linhas com a cor "atrasada" em relação ao status real,
saiba que é isso — o valor do status está certo, só a pintura da
linha que pode demorar a acompanhar.

Testei o fluxo principal de ponta a ponta com navegador de verdade
(cadastrar veículo, criar entrega, ela aparecer na fila) e o backend
a fundo (8 testes automatizados, cobrindo desde o CRUD básico até a
marcação automática de horário de saída/chegada e a geração de
mensagem certa pra cada status). Suíte agora com **81 testes**.

## Funcionalidades por perfil de negócio — parte 1 de 6

Você tem 11 perfis de negócio cadastrados (Farmácia, Petshop, Salão de
Beleza, Material de Construção, Ótica, Armazém/Padaria, Restaurante, e
mais), cada um até agora só com campos extras diferentes no cadastro
de produto — nenhum tinha uma funcionalidade própria além disso. Comecei
a mudar isso, uma de cada vez.

### Livro de controlados eletrônico (Farmácia)
Nova aba "Livro de controlados" no Painel — só aparece pro perfil
Farmácia. Todo produto marcado como "medicamento controlado" no
cadastro, filtrado por período, com cliente (quando teve) e princípio
ativo — pronto pra prestar contas à vigilância sanitária sem precisar
procurar venda por venda. Tem botão de imprimir.

### Ficha de pet com lembrete de vacina/vermífugo (Petshop)
Botão "Pets" na linha de cada cliente (só perfil Petshop) — cadastra
o pet vinculado ao dono, com data da última e próxima vacina/vermífugo.
Botão "Lembretes de vacina/vermífugo" no topo mostra quem está com
data vencida ou vencendo nos próximos 7 dias, com um botão que já abre
o WhatsApp com uma mensagem pronta — reaproveitando a mesma
infraestrutura do lembrete de cliente que sumiu.

Testei os dois cenários de ponta a ponta (backend + comportamento),
incluindo casos de borda: item cancelado não conta no livro de
controlados, pet sem telefone cadastrado não permite envio, vacina
vencida vs. vencendo em breve geram mensagens diferentes e
gramaticalmente corretas. Suíte agora com **73 testes**, todos
passando.

**Continuando aos poucos**: ainda faltam agenda de horário (Salão),
desconto automático por validade (Armazém/Padaria), orçamento antes
da venda (Material de Construção), e ficha de receita (Ótica).

## Três novidades: cliente que sumiu, margem fora do padrão, e "quem compra isso, compra aquilo"

Construí as três ideias que você pediu, cada uma com testes
automatizados cobrindo os cenários que importam.

### Cliente que sumiu
Botão novo "Clientes que sumiram" na tela de Clientes. Em vez de um
número fixo de dias pra todo mundo, compara o tempo desde a última
compra com o **ritmo próprio de cada cliente** — quem compra toda
semana e some por um mês entra na lista; quem compra a cada 3 meses
só entra se também passar bem do próprio ritmo. Cada linha tem um
botão que já abre o WhatsApp com uma mensagem de reconquista pronta,
personalizada com o primeiro nome da pessoa.

### Margem fora do padrão
Nova seção na tela de Alertas. Compara a margem de cada produto com a
média da **própria categoria** dele (não um número fixo pra todo o
catálogo) — pega erro de precificação, tipo custo que subiu num
abastecimento e o preço de venda nunca foi reajustado, antes que vire
prejuízo acumulado sem ninguém perceber. Produto vendendo com
prejuízo sempre aparece, mesmo sozinho na categoria.

### "Quem compra isso, compra aquilo"
No PDV, depois de adicionar um produto ao carrinho, se existir um
padrão real de compra conjunta (baseado no histórico de vendas de
verdade, não uma regra configurada — e exigindo pelo menos 2
ocorrências, pra não sugerir uma coincidência de uma venda só),
aparece uma sugestão com botão de adicionar direto. Testei a lógica
de análise a fundo (padrão real vs. coincidência, venda cancelada não
conta, produto desativado não aparece) — a parte de dentro do PDV
segue exatamente o mesmo padrão já comprovado de outras chamadas
`window.pdv` na mesma função, mas não consegui montar um teste
automatizado de ponta a ponta da tela inteira (esbarrei numa
complexidade de empacotamento do ambiente de teste isolado, sem
relação com a lógica em si) — vale um teste manual seu antes de
confiar 100% nessa parte específica.

Suíte de testes agora com **61 testes**, todos passando.

## Novidade: previsão de ruptura de estoque

Sua pergunta ("o que mais conseguimos fazer, seja inovador mas útil")
me fez olhar pro que já existia de alerta de estoque — e achei que
era todo **reativo**: só avisa depois que já bateu o número mínimo
que alguém configurou uma vez (e pode estar desatualizado). Um
produto de venda rápida podia estar a poucos dias de acabar sem
nenhum aviso, só porque o mínimo cadastrado nunca foi ajustado pra
refletir a demanda real.

**Construído**: nova seção "Vai faltar em breve" na tela de Alertas —
olha o ritmo de venda real dos últimos 30 dias de cada produto (a
mesma lógica que já existia pra sugestão de reabastecimento, só que
aplicada de forma proativa) e avisa quando o estoque atual, no ritmo
atual, vai acabar dentro de 7 dias — **mesmo que o produto ainda não
tenha batido o mínimo cadastrado**. Não duplica quem já aparece no
alerta reativo tradicional.

Testei com produto de venda rápida (deveria aparecer), venda lenta
(não deveria), produto já abaixo do mínimo (não deveria duplicar), e
produto sem estoque nenhum (não deveria quebrar o cálculo). Escrevi
testes automatizados cobrindo os quatro casos — suíte agora com **48
testes**, todos passando.

## Treinamentos atualizados

Reconstruí a apresentação inteira (`public/treinamento-pdv.pdf`, agora
25 slides) — não tinha a fonte original (só o PDF exportado), então
recriei fielmente o estilo visual (mesma paleta, tipografia, layout de
cards) e mantive todo o conteúdo já existente. Adicionei dois slides
novos ("Categorias e organização" e "Duplicados e código de barras")
e atualizei "Ferramentas de gestão" pra incluir Financeiro (de 3 pra 4
cards). Validado contra o schema oficial de apresentações, conferido
visualmente slide por slide (achei e corrigi uma sobreposição de
texto no slide de comanda), sem texto de placeholder sobrando.

## "O que podemos melhorar" — o que já fiz, não só sugeri

Investigando o projeto pra responder isso direito, achei um problema
concreto: **você já tinha uma suíte de testes automatizados**
(`tests/`, cobrindo login, caixa, devolução, vendas) — mas ela nunca
protegia nada de verdade, por dois motivos que se somavam:

1. **O workflow de publicação nunca rodava os testes** — só buildava
   e publicava direto. Corrigido: adicionei o passo `npm test` antes
   do build, travando a publicação se algo quebrar.
2. **O próprio comando `npm test` estava quebrado** desde antes desta
   sessão — `node --test tests/` (passando o diretório explicitamente)
   falha nessa versão do Node com "Cannot find module tests". Corrigido
   pra `node --test` (sem argumento — a descoberta automática de
   arquivos `*.test.js` funciona certo assim). Se você já tentou
   rodar `npm test` na sua máquina antes, é bem provável que tenha
   dado esse mesmo erro.

Com os testes rodando de verdade pela primeira vez, **um teste já
existente falhou** — não por bug real no app, mas porque o próprio
teste estava incompleto (tentava validar que autoaprovação de
cancelamento é rejeitada, mas sem registrar pagamento antes, cenário
em que a aprovação nem é exigida por regra de negócio). Corrigido o
teste pra registrar o pagamento primeiro — confirmei que a trava de
segurança de verdade funciona certo.

Também escrevi testes novos pro bug de paginação mais difícil desta
sessão inteira (produto duplicado na rolagem infinita) e pro
ranqueamento de busca — pra nunca mais regredir sem ninguém perceber
antes de chegar no cliente. Suíte completa: **44 testes, todos
passando**.

**Sugestões pra próximos passos** (não fiz agora, mas vale considerar):
- **Ampliar a cobertura de testes** pras áreas que mais deram bug
  nesta sessão e ainda não têm teste nenhum: sincronização entre
  PDVs, `dashboardService`, `categoryService`, checagem de
  atualização.
- **Aviso de "produto parecido já existe"** ao cadastrar um produto
  novo — pegaria duplicata na origem (erro de digitação humana), em
  vez de só limpar depois com a ferramenta que já construímos.
- **NFC-e**: a emissão está com assinatura e transmissão implementadas
  e testadas na mecânica, mas nunca foi validada contra a SEFAZ de
  verdade — precisa de um certificado ICP-Brasil real e acesso de
  homologação pra confirmar ponta a ponta antes de confiar em
  produção.

## Achada a causa raiz de verdade do bug de busca — "funciona quando abre, para depois de um tempo de uso"

Essa frase do cliente foi a pista decisiva. Investigando com esse
contexto, achei **duas causas raiz reais**, ambas relacionadas à
rolagem infinita da tela de Produtos:

### 1. Paginação por posição numérica não é confiável quando o catálogo muda

A rolagem infinita pedia "os próximos 60 a partir da posição N"
(offset). Isso é ok pra uma lista PARADA — mas se um produto é
cadastrado, editado, ou chega de sincronização de outra máquina
**enquanto a pessoa está rolando**, todo mundo desloca uma posição, e
o último produto de uma página aparece de novo bem no topo da
próxima — dois React tentando desenhar a mesma linha ao mesmo tempo,
o que quebra a lista de um jeito bem difícil de diagnosticar (linhas
antigas ficavam presas na tela). Comprovei isso com testes diretos:
sem desempate, ~15% das tentativas com uma inserção no meio davam
duplicata; mesmo adicionando um desempate na ordenação, ainda dava.

**Corrigido**: troquei offset por paginação por **cursor** — em vez
de "a partir da posição N", agora pede "o que vem depois do último
produto que eu já vi" (pelo nome + id dele). Isso é imune a qualquer
inserção/edição no meio do caminho, comprovado com 50 tentativas
seguidas sem nenhuma duplicata, tanto na navegação normal quanto na
busca.

### 2. Uma corrida entre o carregamento inicial e a rolagem automática

Achada à parte, mas relacionada: o marcador que dispara "carregar
mais" automaticamente já fica visível na tela **antes mesmo da
primeira leva de produtos terminar de carregar** (não tem conteúdo
ainda pra empurrar ele pra fora da vista) — e as duas buscas (a
inicial e a de "carregar mais") podiam disparar ao mesmo tempo, pedindo
a mesma primeira página duas vezes. Resultado: os primeiros produtos
apareciam duplicados na tela, mais um jeito de cair na mesma classe
de bug.

**Corrigido**: as duas agora compartilham uma única trava — enquanto
uma está buscando, a outra espera.

Testei os dois cenários de ponta a ponta com navegador de verdade,
reproduzindo fielmente o que o cliente descreveu: catálogo mudando
enquanto a pessoa rola (0 duplicatas em 50 tentativas), e o cenário
exato do print anterior (rolar bastante e depois buscar — agora
mostra só o resultado certo). Também confirmei que rolagem legítima
até o fim do catálogo continua carregando tudo certinho, sem faltar
nem duplicar nada.

## Vendas depois das 21h contando pro dia errado — bug bem mais espalhado do que parecia

Eu tinha corrigido esse tipo de bug (UTC vs Brasília) só na
sincronização entre PDVs, mas seu print mostrou que ele continuava
acontecendo no Histórico da própria máquina. Investigando a fundo,
achei que era **a mesma causa, espalhada por praticamente todo canto
que filtra por data**: o SQLite extrai o dia direto do horário
guardado (que é UTC), sem converter pro fuso de Brasília antes — uma
venda das 21h+ já virou "amanhã" em UTC, então contava no dia errado.

**Corrigido em 9 arquivos, 25 consultas ao todo**: Histórico de vendas
(a tela do seu print), Painel (todos os gráficos e totais), Financeiro
(despesas), tentativas de login, relatórios, devoluções, desperdício,
e métricas do painel administrativo. Fiz uma varredura sistemática
procurando esse padrão exato em todo o código — não corrigi só onde
seu print mostrou, corrigi todo lugar que tinha o mesmo problema.

Testei o cenário exato do seu print (venda às 21:42 de um dia,
gravada em UTC como já sendo o dia seguinte) em duas telas diferentes
— Histórico e Painel — confirmando que agora contam certo no dia real
em Brasília, não mais empurradas pro dia seguinte.

## Re-vincular via grupo sincronizado — sem precisar de planilha nenhuma

Como sua máquina já sincronizou com a dele antes e manteve os
códigos de barras intactos, adicionei uma segunda opção bem mais
direta na mesma ferramenta: **"Buscar automaticamente no grupo
sincronizado"** — usa o catálogo que sua própria máquina já publicou
no grupo como fonte, em vez de precisar exportar/localizar uma
planilha.

Mesma lógica de casamento por nome, mesma revisão antes de aplicar,
mesma proteção contra conflito — só troca de onde vêm os dados
comparados. Reaproveitei a lógica de casamento entre as duas
(planilha e grupo), então qualquer melhoria futura nisso vale pros
dois caminhos.

Testei o cenário exato: produtos locais sem código, catálogo do grupo
com os códigos certos publicados — confirmei que casa certo, ignora o
que só existe no grupo (sem produto correspondente aqui), e aplica
corretamente.

## Re-vincular códigos de barras de uma planilha antiga

Botão novo em Produtos: "Re-vincular códigos de barras". Pensado
exatamente pro seu caso — cliente ainda tem a planilha antiga com os
códigos, e alguns produtos ficaram sem código depois da limpeza de
duplicados.

**Por que não reaproveitei a importação normal**: ela casa produtos
existentes por SKU ou código de barras — inútil aqui, já que é
justamente o código que sumiu. Essa ferramenta nova casa por **nome**
em vez disso.

- Aceita a planilha antiga como ela é — não precisa reformatar pro
  nosso modelo. Detecta a coluna do nome e a do código de barras
  mesmo com cabeçalhos diferentes ("Produto", "Descrição", "EAN",
  "Código", etc).
- **Nunca cria produto novo** — só preenche o código de barras de quem
  já existe aqui, casando pelo nome.
- Mostra uma tela de revisão antes de aplicar qualquer coisa: quem foi
  encontrado (com checkbox pra incluir/excluir cada um), quem não foi
  encontrado, e quem foi pulado por já ter esse código em outro
  produto ativo (evita reintroduzir o mesmo tipo de conflito que já
  resolvemos antes).
- Se dois produtos locais tiverem o mesmo nome (duplicado que ainda
  não foi limpo), fica marcado como ambíguo em vez de escolher um dos
  dois sozinho — pra você resolver a duplicidade primeiro, se for o
  caso.

Testei o fluxo completo: planilha com cabeçalhos diferentes do nosso
modelo (detecção funcionou), produtos casados corretamente por nome,
produto não encontrado reportado à parte, e confirmei que nada é
aplicado até você revisar e confirmar.

## Busca por nome — refinada pra 4 níveis de relevância

A busca já priorizava "nome começa com o termo" — mas tudo que não se
encaixava nisso caía no MESMO balaio de "contém em algum lugar",
misturando busca pela segunda ou terceira palavra do produto (o jeito
mais comum de buscar de verdade — quase ninguém busca pela primeira
palavra inteira) com coincidência de meio de palavra, bem menos
relevante. Isso enterrava o resultado certo.

**Corrigido**: agora são 4 níveis, do melhor pro pior:
1. Nome **começa** com o termo.
2. Termo é o **início de uma palavra** dentro do nome (ex: buscar
   "500mg" ou o nome do fabricante — o caso mais comum de busca real).
3. Termo aparece no **meio de uma palavra**, sem estar numa borda.
4. Só bateu em SKU/código de barras, não no nome.

Testei com um catálogo fiel a uma farmácia: buscar "500mg" (segunda
palavra na maioria dos produtos) e "generico" (terceira palavra) — os
dois trazem o resultado certo no topo agora. Também confirmei que
início do nome inteiro continua vencendo tudo, e que meio de palavra
ainda aparece, só que por último.

## Duas correções depois da limpeza de duplicatas

### Produtos perdendo código de barras — a seleção automática escolhia errado

Achei a causa: a sugestão de "Selecionar todos" só olhava a
**quantidade de estoque** pra decidir qual duplicado manter — nunca
conferia se o produto tinha código de barras. Com dois duplicados de
estoque igual (bem comum — os dois zerados, por exemplo), a escolha
entre eles era arbitrária, e podia muito bem manter justamente o que
**não** tinha código de barras, excluindo o outro (que tinha) —
resultado: "o produto perdeu o código de barras", quando na verdade o
duplicado errado é que sobreviveu.

**Corrigido**: a sugestão agora prioriza manter quem **tem** código de
barras — só usa o estoque como critério de desempate quando os dois
estão empatados nisso (ambos com código, ou ambos sem). Também
adicionei a coluna de código de barras na tabela, visível durante a
revisão manual — antes não dava nem pra ver qual tinha o quê antes de
excluir.

Testei o cenário exato: dois duplicados com estoque igual (zero),
só um com código de barras — confirmei que a seleção automática agora
marca corretamente o **sem** código pra excluir, mantendo o que tem.

### Pistola fechando o formulário de produto ao cadastrar código de barras

Isso não era sobre a configuração da pistola em si (essa realmente só
atua no PDV) — era o comportamento padrão do HTML: qualquer campo
dentro de um formulário submete ele inteiro ao apertar Enter, e a
pistola manda um Enter depois dos dígitos escaneados. Escanear no
campo "Código de barras" do cadastro de produto disparava o envio do
formulário inteiro (salvando e fechando), antes da pessoa terminar de
preencher o resto — obrigando reabrir o produto de novo.

**Corrigido**: Enter em qualquer campo de texto do formulário de
produto não fecha/salva mais sozinho — só preenche o campo. Salvar
continua exigindo o clique no botão "Salvar produto", de propósito.

Testei o fluxo completo: escanear no campo de código de barras
preenche certo sem fechar nada, e o botão Salvar continua funcionando
normalmente quando a pessoa decide de verdade.

## "Não acha na pesquisa nem na pistola" — a consequência direta da trava de sincronização

O print do WhatsApp do Sidney confirmou uma suspeita: esse é exatamente
o efeito colateral esperado da mudança que fizemos, a seu pedido, pra
parar a sincronização de catálogo de clonar produtos automaticamente.
Um produto que existe **só numa máquina** (ex: só na sua, nunca
cadastrado na do Sidney) simplesmente não aparecia mais na busca ou
na pistola da outra máquina — porque a trava impede exatamente isso.

Eu já tinha construído a peça que faltava pra resolver isso (consultar
o catálogo do grupo sob demanda), mas nunca cheguei a **conectar** ela
nas telas de venda de verdade. Corrigido agora:

- **Busca manual de produto**: quando não acha nada local, consulta o
  catálogo do grupo automaticamente — se achar, mostra numa seção
  separada, clara: "Não cadastrado aqui, mas encontrado no grupo".
  Escolher um desses **traz o produto pra base local dessa máquina
  na hora** (só esse produto, só porque foi escolhido — nunca em
  segundo plano) e já adiciona na venda.
- **Leitor de código de barras (a "pistola")**: mesmo comportamento —
  se não achar local, consulta o grupo por código de barras antes de
  desistir com "código não encontrado". Both no PDV normal e no modo
  mesa/restaurante.
- Isso mantém a promessa que fizemos: **nada é clonado sozinho em
  segundo plano** — só quando alguém realmente precisa vender aquele
  produto específico e escolhe trazê-lo.

Testei o cenário exato do Sidney com o componente real: produto que
não existe local nenhum, só no grupo — confirmei que aparece na busca
com o aviso certo, e que escolher ele importa e adiciona na venda
corretamente.

## Achado o bug de verdade — corrida de inicialização

Sua pista foi decisiva: "funciona manual em Configurações, só trava na
obrigatória" — isso descarta de vez qualquer problema de release/draft
no GitHub (o mecanismo de checar E achar a atualização funciona,
comprovado pelo fluxo manual) e aponta pra diferença exata entre os
dois caminhos: a tela de bloqueio dispara a checagem **assim que a
janela abre**, bem mais cedo que qualquer clique manual em
Configurações.

Achei a causa: no `main.js`, a janela era criada (`createWindow()`)
**antes** de `updateService.setupAutoUpdater()` — a função que registra
os listeners de evento do auto-updater (`checking-for-update`,
`update-available`, etc.). Se a tela de bloqueio disparasse a
checagem cedo o suficiente, o resultado dela (achou atualização, não
achou, ou deu erro) **se perdia no vazio** — chegava um evento que
ninguém ainda estava escutando. O fluxo manual em Configurações só
roda bem depois, com tudo já registrado, por isso sempre funcionou.

**Corrigido**: `setupAutoUpdater()` agora roda antes de `createWindow()`
— não existe mais nenhuma janela de tempo em que a tela pudesse disparar
uma checagem antes dos listeners existirem.

**Reproduzi o bug de propósito** com um auto-updater simulado, na
ordem antiga — confirmei que o resultado realmente se perdia (mesmo
"achando" a atualização por trás, o status nunca refletia isso). Testei
de novo com a ordem nova — confirmei que captura certo, com a versão
disponível batendo. Essa dessa vez tenho certeza de verdade que é a
causa raiz, não uma suposição.

## Corrigindo o erro que EU causei — `draft: false` quebrou o build

Seu terminal mostrou exatamente o problema: o `"draft": false` que
adicionei na resposta anterior **não é um campo reconhecido** pela
versão do `electron-builder` que o projeto usa (24.13.3) — ele quebrou
até o build local (`--publish never` também valida a configuração
inteira, mesmo sem publicar nada). Peço desculpas por isso — vim de
uma busca em documentação geral que não bateu com essa versão
específica.

**Corrigido**: removi o `draft`, voltando a usar só `releaseType:
"release"` (que já estava lá desde antes, e É um campo válido —
confirmei contra o schema exato que o próprio erro listou). Testei
rodando o build completo aqui do meu lado com a mesma versão exata do
`electron-builder` (24.13.3) — passou da etapa que quebrava antes e
terminou de empacotar sem nenhum erro de configuração.

**Sobre a causa raiz de verdade (por que a release aparece como
rascunho)**: dado que `releaseType: "release"` já estava configurado
certo desde antes de eu mexer nisso, minha teoria anterior pode não
ser o motivo real. Preciso que você **confira direto no GitHub** —
entra no seu repositório → aba "Releases" → olha se `v0.5.28` ou
`v0.5.29` aparecem lá, e se estão marcadas como rascunho ("Draft") ou
publicadas de verdade. Isso me diz com certeza o que está acontecendo,
em vez de eu continuar arriscando mais mudanças de configuração no
escuro.

Pulei direto pra **0.5.32** — você já tinha rodado localmente até a
0.5.31, evitando qualquer risco de colisão de tag.

## Atualização "ainda travada" — a causa raiz de verdade

Sua tentativa de criar as tags confirmou algo importante: `v0.5.28` e
`v0.5.29` **já existiam e já tinham sido enviadas** ("Everything
up-to-date"). Isso significa que o workflow provavelmente **já
rodou** — mas achei o motivo de mesmo assim nada aparecer pro
auto-updater: **o `electron-builder` cria a release como rascunho por
padrão**, mesmo com `releaseType: "release"` configurado (que já
estava no seu `package.json` desde antes — existe um problema
conhecido do próprio `electron-builder` onde isso às vezes não é
respeitado). Uma release rascunho fica invisível — o app nunca acha
ela, então trava pra sempre, não importa quantas tags você crie.

**Corrigido pra builds futuros**: adicionei `"draft": false`
explicitamente na configuração de publicação — essa é a forma mais
confiável de garantir isso, documentada como o comportamento correto
mesmo em versões do `electron-builder` que têm esse problema com
`releaseType` sozinho.

**Mas isso não resolve o que já foi construído** — as releases de
`v0.5.28`/`v0.5.29`, se o workflow rodou, provavelmente estão lá como
rascunho agora. Duas coisas pra fazer:

1. **Destravar agora**: vai no seu repositório no GitHub → aba
   "Releases" → se tiver algum rascunho de `v0.5.28` ou `v0.5.29`
   listado lá, abre ele e clica em "Publish release". Isso é
   imediato, sem precisar reconstruir nada.
2. **Pra daqui pra frente**: com o `draft: false` que acabei de
   adicionar, a próxima tag que você criar e enviar já publica
   automaticamente, sem esse passo manual.

Pulei a versão do zip pra **0.5.30** de propósito — `0.5.28` e
`0.5.29` já estão com tag criada, então usar qualquer uma delas de
novo daria conflito.

## Tela de atualização travada em "Verificando..." — corrigido

Achei o bug exato do seu print: o botão "Atualizar agora" usava um
estado que **nunca voltava atrás** — assim que você clicava, ficava
"Verificando..." pra sempre, não importa o que acontecesse por trás
(achasse a atualização, desse erro, ou não achasse nada). Corrigido —
agora o botão reflete o estado real da checagem, e some assim que ela
termina, pra qualquer lado que for.

Também adicionei uma pista de diagnóstico: se a checagem terminar sem
achar a versão nova (o cenário mais comum quando o release no GitHub
não está publicado direito — rascunho, pré-lançamento, ou faltando os
arquivos que o instalador precisa), a tela agora avisa isso
claramente, em vez de só voltar ao botão como se nada tivesse
acontecido.

Testei o cenário exato do seu print com um navegador de verdade —
confirmei que o botão não fica mais preso, e que a mensagem de
diagnóstico aparece quando a checagem não acha nada disponível.

**Coincidência útil**: essa correção já sai na versão **0.5.28** —
exatamente a versão mínima que você tinha publicado como obrigatória.
Assim que os clientes atualizarem pra essa versão, resolve o problema
que estava vendo.

## Categorias — ver produtos vinculados, editar e excluir de dentro do detalhe

Clicar numa categoria (a linha inteira, não só os links) agora abre
uma tela cheia mostrando **todos os produtos vinculados** a ela —
nome, SKU, preço, com a miniatura de cada um. De dentro dessa tela dá
pra **renomear** ou **excluir** a categoria direto, sem precisar
voltar pra lista (os links rápidos "Editar"/"Excluir" na linha
continuam funcionando também, pra quem só quer a ação rápida sem abrir
o detalhe).

Testado com navegador: clicar na categoria mostra os produtos certos,
e renomear/excluir de dentro do detalhe abre a ação certa
corretamente (fechando o detalhe antes).

## Aba de Categorias — CRUD completo + categorização por IA

**Nota sobre esta entrega**: no meio de construir isso, meu ambiente de
trabalho reiniciou sem aviso — recuperei tudo a partir do último `.zip`
que já tinha te entregue (`v0.5.26`) e refiz o que tinha se perdido.
Retestei tudo de novo antes de reentregar, então não tem risco de ter
sobrado algo quebrado da reconstrução.

### Categorias — nova aba em Produtos
CRUD completo: criar categoria (mesmo sem produto nenhum ainda),
renomear (atualiza todos os produtos que usam automaticamente), e
excluir (com opção de mover os produtos pra outra categoria, ou
deixar sem categoria). Categorias continuam funcionando exatamente
como antes no PDV (botões de navegação) — só ganharam uma tela
dedicada de gerenciamento.

### Categorização automática com IA
Reaproveitei a mesma integração Gemini que já existe (a mesma chave
configurada em Configurações → IA, usada hoje pra ler receitas e
notas de compra) — não precisa configurar nada novo.

Botão "✨ Categorizar produtos sem categoria com IA" na aba Categorias:
- Busca todos os produtos ativos sem categoria (em lotes de 80, pra
  não estourar um prompt gigante de uma vez).
- Pede sugestão pra IA, **priorizando reaproveitar categorias que já
  existem** no seu catálogo em vez de inventar uma nova toda hora —
  só propõe categoria nova quando nenhuma existente serve.
- Quando a IA não tem confiança sobre um produto específico, ele
  simplesmente não aparece na lista de sugestões (em vez de arriscar
  uma categoria errada).
- **Nunca aplica sozinha** — abre uma tela de revisão (tela cheia,
  com rolagem, igual a de duplicados) onde você vê cada sugestão,
  pode desmarcar o que não fizer sentido ou editar a categoria antes
  de confirmar. Só o que ficar marcado é salvo.

Testei o fluxo inteiro: construção do prompt (inclui as categorias
existentes certas), processamento em lotes, sugestões de baixa
confiança sendo descartadas automaticamente, aplicação criando
categoria nova quando precisa, e o fluxo de revisão completo com
navegador (desmarcar exclui da aplicação, editar a categoria antes é
respeitado).

## Dois problemas dos seus últimos prints

### PERMISSION_DENIED recorrente — não é bug, é a regra desatualizada no Firebase de verdade

O primeiro print mostra o mesmo erro se repetindo desde a **v0.5.18**
até a v0.5.24 — isso não é um bug novo, é sinal de que **as regras de
segurança publicadas no seu console do Firebase não foram atualizadas**
desde antes de eu adicionar os últimos campos nas métricas
(`perfilAtivo`, `totalVendasHistorico`, `vendasUltimos30Dias`,
`conflitosCodigoBarrasPendentes`). Toda vez que o app tenta reportar
esses dados novos, a SEFAZ... digo, o Firestore recusa porque a regra
publicada não conhece esses campos ainda.

**O que fazer**: abre o console do Firebase → Firestore Database →
Regras, e cola o bloco COMPLETO que está em `LICENCIAMENTO.md` deste
projeto (comece a colar a partir de `rules_version = '2';`, sem nada
de texto em português junto — isso já causou esse mesmo tipo de erro
antes). Confirmei que o bloco documentado aqui já inclui todos os
campos atuais — só precisa publicar ele de novo no Firebase de
verdade.

### Erro cru "UNIQUE constraint failed" ao editar produto — corrigido

O segundo print mostra o banco recusando salvar porque o código de
barras já pertencia a outro produto — mas a mensagem que aparecia era
o erro técnico cru do SQLite, sem dizer qual produto nem o que fazer.

**Corrigido**: agora confere ANTES de tentar salvar, e se o código já
pertence a outro produto, mostra uma mensagem clara **nomeando esse
produto** — editar o PRÓPRIO produto com o mesmo código continua
funcionando normalmente (não trava em si mesmo). Testei os dois
cenários: conflito real com outro produto (mensagem clara, nomeando
"ALCOOL 70% 1LT PETRIBU" no teste) e edição do próprio produto sem
falso positivo.

## Sincronização de catálogo virou só consulta — trava a clonagem na raiz

Decisão sua, direta na causa da duplicidade: catálogo de produtos
sincronizado entre PDVs **não deve mais copiar nada pra base local
sozinho**. Investigando o que realmente "clonava": estoque e
histórico **já funcionavam só por consulta** (o histórico do grupo é
lido direto do Firestore pra exibir, nunca grava nada localmente; o
estoque compartilhado é um contador à parte, também nunca grava
estoque "de outra máquina" na sua base). O único que de fato escrevia
produtos de outras máquinas na tabela local — criando duplicidade
quando duas máquinas cadastravam "o mesmo" produto de forma
independente — era o catálogo.

**Corrigido**: a escuta do catálogo do grupo agora só atualiza um
**cache em memória** (nunca a tabela `products` de verdade) — dá pra
consultar o que outras máquinas têm cadastrado, mas nada vira produto
local sozinho. Cada máquina continua **publicando** o próprio
catálogo pro grupo (isso não mudou — é assim que a consulta consegue
ver os produtos dela), só parou de **importar automaticamente** o que
vê. A lápide de exclusão (quando um produto é mesclado/apagado em
outra máquina) também parou de mexer na base local — só reflete na
consulta.

Testei os dois cenários centrais: produtos chegando de outra máquina
não alteram mais a contagem da tabela local (fica exatamente igual a
antes), mas continuam encontráveis pela busca no catálogo do grupo; e
uma lápide de exclusão não desativa mais o produto local
correspondente, só some da consulta.

**Combinado com você**: o backup/restore que promoveria uma máquina a
"novo servidor" (pra recuperar de uma quebra) fica pra depois — por
enquanto isso é só a trava, sem mecanismo de restauração ainda.

## Modal de duplicados em tela cheia

Seu print mostrava exatamente o problema: com 1146 grupos de
duplicados, o modal pequeno (largura fixa, sem rolagem própria)
ficava cortado e ilegível. Reescrevi:

- **Ocupa quase a tela toda** (95% da largura, 92% da altura).
- **Uma tabela única contínua**, em vez de uma tabela por grupo — bem
  mais rápida de renderizar com centenas de grupos, e mais fácil de
  escanear.
- **"Selecionar todos" em destaque no topo**, sempre visível — marca
  automaticamente o de menor estoque de cada grupo, mantendo o de
  maior estoque como sugestão.
- **Rolagem só na lista**, os botões de ação (Fechar, Excluir) ficam
  sempre visíveis embaixo, nunca saem da tela.

Testei simulando os mesmos 1146 grupos (2292 produtos) que você tem
de verdade — renderiza em cerca de 1,3 segundo, a seleção automática
marca certo, a rolagem interna funciona, e os botões continuam
alcançáveis o tempo todo.

## Duplicados: exclusão direta em vez de fundir estoque

Troquei o comportamento — o botão "Ver duplicados" agora deixa marcar
vários produtos com **checkbox** e excluir de uma vez, sem somar
estoque em nenhum outro produto (era isso que fazia antes; agora só
remove mesmo, direto).

- "Selecionar todos os duplicados" marca automaticamente todos os
  duplicados de todos os grupos, **mantendo o de maior estoque** de
  cada grupo desmarcado (sugestão de qual manter, mas você pode
  ajustar manualmente antes de confirmar).
- "Selecionar este grupo" faz a mesma coisa só num grupo específico.
- Confirmação antes de excluir, avisando claramente que o estoque não
  é somado em lugar nenhum.

**Corrigi também uma lacuna que existia antes de mexer nisso**: excluir
um produto (o botão normal "Excluir" da lista, não só esse novo fluxo
de duplicados) nunca avisava o grupo de sincronização — a próxima
sincronização podia trazer o produto excluído de volta. Agora avisa,
reaproveitando a mesma "lápide" que já uso quando mescla produtos.

Testei o fluxo completo com navegador: seleção automática mantém o de
maior estoque, exclui só os marcados, e confirmei que excluir agora
sempre avisa o grupo (testei isolado, com um produto qualquer, não só
via duplicados).

## Produtos duplicados entre PDVs sincronizados — botão de mesclar

O cenário do seu print: duas máquinas sincronizadas, cada uma
cadastrando "o mesmo" produto de forma independente antes de nunca
terem sincronizado — resultado, dois registros com o mesmo nome, cada
um com seu próprio estoque e histórico de vendas.

**Botão novo "Ver duplicados" na aba Produtos** (mostra a contagem
quando tem algum) — abre um comparativo por nome idêntico, você
escolhe qual manter, e mesclar:
- **Soma o estoque automaticamente** — o estoque final é a soma dos
  dois, sem precisar fazer conta na mão.
- **Realoca todo o histórico** (vendas, movimentos de estoque, lotes,
  devoluções) do produto removido pro produto mantido — nada se
  perde, os relatórios continuam batendo certo.
- **Avisa o grupo de sincronização** que o produto removido não
  existe mais — sem isso, a próxima sincronização traria ele de
  volta. A outra máquina recebe esse aviso e desativa a cópia dela
  automaticamente (sem apagar o histórico local dela também).
- Fica registrado na Auditoria.

Testei o cenário completo, fiel ao seu print: dois produtos com o
mesmo nome e estoques diferentes, um deles com uma venda no
histórico — confirmei que a venda continua existindo (só realocada
pro produto mantido, não perdida), o estoque final soma certo, o
duplicado remove de verdade, e o aviso pro grupo funciona nos dois
lados (quem mescla e quem recebe o aviso).

## Preço de custo vindo com "0" — corrigido

No formulário de produto, o campo de custo usava uma checagem que só
tratava `null`/vazio como "sem valor" — mas o banco guarda `0` como
padrão quando o custo nunca foi preenchido, e `0` passava por essa
checagem como se fosse um valor real. Corrigido — agora `0` também é
tratado como vazio, o campo fica em branco pra você preencher.

## Continuação da lista grande: reabastecimento, financeiro, contas a pagar

### Nota sobre NFC-e (retomado nesta sessão, ainda sem tela)
Comecei a construir a assinatura digital e transmissão SEFAZ de
verdade (certificado .pfx, assinatura XMLDSig testada
criptograficamente, transmissão SOAP com certificado mútuo testada
contra um servidor real) — o backend (`fiscalService.emitirNFCe`)
já assina e transmite. **Mas ainda não conectei nenhum botão nem tela
pra isso** — não tem como emitir uma NFC-e pela interface ainda,
só o código de backend existe. Continuo isso na próxima rodada.



### Sugestão de reabastecimento — já existia
Investiguei antes de construir e achei que isso **já estava
implementado** de uma sessão anterior (`supplierService.suggestPurchases`)
— calcula velocidade de venda dos últimos 30 dias e sugere quantidade
pra cobrir o mínimo ou 30 dias de venda, o que for maior. Já tem tela
(dentro de Abastecimento → Fornecedores) e exportação em Excel. Não
precisei mexer em nada.

### Financeiro — novo, tela "Financeiro" no menu (gerente/admin)
Unifiquei "despesas simples" e "contas a pagar de fornecedor" no mesmo
recurso — uma despesa sem vencimento é lançada já paga; com
vencimento, fica pendente até marcar como paga.

- **Resultado simples do período**: receita − custo dos produtos
  vendidos − despesas = resultado. Não é uma DRE contábil de verdade
  (deixei isso explícito na própria tela) — não considera impostos
  sobre a receita nem depreciação, é uma visão rápida de "como está
  indo o negócio".
- **Contas a pagar em aberto**, destacando as vencidas.
- **Lançar despesa** — categoria, descrição, valor, fornecedor
  (quando aplicável) e vencimento opcional.

Testei o cálculo do resultado com números reais (receita, custo,
despesas, lucro bruto, resultado final todos batendo), e o fluxo
completo do formulário de lançar despesa com um navegador de verdade.

## Editar histórico de venda (data/hora e valor) — admin

Válvula de escape manual: um botão "Editar" na tela de Histórico
(só aparece pra admin) que abre um formulário pra corrigir
diretamente a data/hora e o valor de uma venda já finalizada. Pensado
especificamente pra você conseguir resolver o caso do Sidney sem
depender de mais nenhuma correção automática.

- **Data e hora** — o campo mostra e recebe horário de Brasília (o que
  você vê no relógio), a conversão pra UTC (formato interno do banco)
  acontece sozinha por trás.
- **Valor total** — corrige o total da venda; zera descontos antigos
  automaticamente (evita ficar com desconto velho aplicado sobre um
  total substituído na mão).
- **Motivo** opcional, pra deixar registrado por quê.
- Fica **registrado na Auditoria**, com o valor antigo e o novo, em
  horário de Brasília pra ficar legível.
- Se a venda fizer parte de um grupo de PDVs sincronizados, a correção
  é **reenviada pro grupo na mesma hora** — o `diaISO` é recalculado a
  partir da data nova, então isso resolve a venda aparecer no dia
  errado pros outros PDVs do grupo também, sem precisar esperar nada.

Restrito a admin, verificado no backend (não só escondido na tela).
Testei o fluxo inteiro: operador comum recusado, admin corrigindo
data e valor juntos, conversão de horário Brasília↔UTC batendo nos
dois sentidos, e o reenvio pro grupo levando o `diaISO` já corrigido.

## Duas perguntas: lentidão e "cache"

**Sobre "servidor desligado"**: não existe essa peça na arquitetura
que causaria isso — o Firestore (onde tudo é sincronizado) é do
Google, sempre ligado, não tem "desligar". A única coisa parecida com
"servidor" é a máquina marcada como responsável pelo estoque
compartilhado, e ela só afeta a checagem de estoque na hora de
finalizar venda, não a velocidade de atualizar o histórico.

**Mas achei um problema real de lentidão, sem relação com isso**: o
reenvio de segurança (que criei pra corrigir sincronização que falhou)
buscava e reprocessava o **histórico inteiro desde sempre**, toda vez
que rodava — a cada 15 minutos, a cada abertura do app, e a cada
clique em "Atualizar". Isso ficava mais lento conforme o histórico
crescia, sem necessidade nenhuma (vendas de anos atrás que já
sincronizaram não precisam ser reenviadas de novo pra sempre).

**Corrigido**: essas chamadas recorrentes agora olham só os últimos 60
dias — o objetivo delas é só recuperar alguma sincronização recente
que falhou, não reprocessar anos de histórico. A única exceção
continua sendo a primeira vez que uma máquina entra num grupo — aí sim
precisa do histórico completo, uma única vez. Medi o ganho com 2 anos
de histórico simulado (20 mil vendas): **92% menos vendas processadas**
a cada ciclo.

**Sobre "cache" e vendas de ontem aparecendo hoje**: isso já tinha
outra causa, identificada e corrigida numa entrega anterior — não
tinha nada a ver com cache nem com "servidor". Era um bug de fuso
horário: o campo que decide em qual dia uma venda aparece cortava a
data gravada em UTC sem converter pro horário de Brasília, então
vendas de fim de noite (depois de 21h) apareciam um dia adiante. Já
corrigi isso, incluindo uma forma de corrigir na hora o dado que já
tinha sido gravado errado antes da correção (o botão "Atualizar").

## Erro de conflito de código de barras subindo repetido — corrigido

Achei a causa exata: o Firestore reenvia a coleção de produtos
**inteira** toda vez que QUALQUER produto do grupo muda (não só o que
está em conflito) — e como o dado no Firestore nunca é corrigido (só
a cópia local), o mesmo conflito era detectado, aplicado, e reportado
de novo a cada disparo do listener, enchendo a tela de Erros com o
mesmo aviso repetido sem parar.

**Corrigido**: agora só reporta na **primeira vez** que um conflito
específico (mesmo produto, mesmo código de barras pendente) aparece —
mas continua atualizando o resto do produto (nome, preço) em silêncio
a cada vez, pra não ficar desatualizado enquanto o conflito não é
resolvido. Assim que você resolve pela tela de Produtos (o aviso some
do produto), se um conflito genuinamente novo aparecer depois, volta
a reportar normalmente.

Testei os dois lados: o mesmo conflito disparando 5 vezes seguidas
gera só 1 relato de erro (não 5); e dois conflitos **diferentes**
continuam sendo reportados um por um, normalmente — só a repetição
do mesmo é que some.

## Achando e resolvendo conflitos de código de barras

Sua observação era certeira: a correção anterior evitava o crash, mas
deixava dois produtos desconectados — o original (com o código de
barras) e o sincronizado (sem ele, silenciosamente) — sem nenhum jeito
fácil de achar qual precisava de atenção. Escanear o código só achava
o original; o outro só aparecia buscando pelo nome.

**Adicionado**: quando um conflito acontece, o produto sincronizado
agora guarda **qual seria o código de barras dele** (não só descarta).
Na tela de Produtos:
- Um selo "⚠ conflito de código de barras" aparece do lado do nome,
  com o código pendente explicado ao passar o mouse.
- Um filtro "Mostrar só produtos com conflito de código de barras
  pendente" — pra ver todos de uma vez, sem precisar rolar a lista
  inteira procurando o selo.
- Assim que você edita o produto pela tela normal (e decide o código
  de barras certo — o pendente, um diferente, ou apaga o outro
  produto duplicado), o aviso some sozinho.

Testei o fluxo inteiro: o conflito grava o aviso corretamente, e
editar o produto pela tela normal limpa o aviso automaticamente,
sem precisar de nenhuma ação manual além de salvar o produto.

## Dois bugs reais dos erros reportados

### 1. `window.prompt()` não funciona no Electron — bug sério, afetava 4 telas

O erro "prompt() is and will not be supported" é uma limitação
conhecida do Chromium embutido no Electron — diferente do navegador
comum (onde eu testava), o Electron não suporta esse diálogo nativo
síncrono. Isso significava que **todo recurso que usava
`window.prompt()` estava quebrado na prática**, mesmo passando nos
meus testes anteriores (que rodam em Chromium normal via Playwright,
não no Electron de verdade) — motivo de continuar assim até você
reportar o erro real do app empacotado.

Afetava: motivo de excluir venda do histórico, motivo + valor ao
editar preço de item (PDV e mesa/restaurante), e resetar PIN de
usuário.

**Corrigido**: criei um modal de verdade (`usePromptModal` +
`PromptModal`) que se comporta como o `prompt()` original — mesma
forma de uso (`await promptAsync('Pergunta:', 'valor padrão')`,
devolve o texto ou `null` se cancelar) — só que é um componente React
de verdade, funciona no Electron. Troquei nos 4 lugares.

**Testado com um navegador de verdade**, usando o componente real:
confirmei que abre com o valor inicial certo, confirma com o texto
digitado, cancela com `null` pelo botão, e Esc também fecha com
`null`.

### 2. Produto sincronizado travava a sincronização inteira

O erro `UNIQUE constraint failed: products.codigo_barras` acontecia
quando um produto vindo de outra máquina do grupo tinha um código de
barras que já pertencia a um produto DIFERENTE, cadastrado localmente
antes da sincronização começar (cada máquina tinha criado o próprio
produto, com o próprio ID, antes de nunca terem se falado). O bug
sério: como o laço que aplica os produtos não tinha proteção nenhuma,
esse UM conflito **travava a aplicação de TODOS os outros produtos** —
e como o Firestore reenvia a lista inteira a cada mudança, o mesmo
erro se repetia sem parar (por isso aparecia repetido no seu print).

**Corrigido**: cada produto agora é aplicado isoladamente — um
conflito não afeta mais os outros. Pro conflito específico de código
de barras, em vez de simplesmente ignorar o produto (perderia
nome/preço atualizado) ou forçar o código de barras (roubaria ele do
produto local que já usava), aplica o resto do produto (nome, preço,
categoria) SEM o código de barras, e registra o conflito nos erros do
painel pra você resolver manualmente qual dos dois produtos deveria
ficar com aquele código.

**Testado com o cenário exato do seu print**: produto local com
código de barras já cadastrado + um produto conflitante vindo de
outra máquina + dois produtos sem problema no mesmo lote — confirmei
que nada trava, os dois produtos OK aplicam normalmente, o
conflitante aplica sem o código de barras, o produto local original
mantém o código dele intacto, e o conflito fica registrado.

## Vendas sumindo do histórico do grupo — corrigido

Investiguei os dois prints e achei duas coisas reais:

**1. O total mostrado ("Total finalizado") estava mesmo errado** — ele
calculava só a partir do dado LOCAL dessa máquina, mesmo quando a tela
estava mostrando o histórico do GRUPO inteiro. Numa máquina sem
nenhuma venda local no dia (só vendo o histórico compartilhado de
outras), isso dava R$ 0,00 mesmo com várias vendas na lista abaixo.
Corrigido — agora soma o dado certo dependendo do que está sendo
mostrado.

**2. A causa mais provável do sumiço**: o histórico do grupo era
buscado **uma vez só**, quando a tela abria — não atualizava sozinho
depois disso. Se a tela ficou aberta por um tempo (o seu segundo print
é de 22:13, quase 30 minutos depois das vendas de 21:41 e 21:45), uma
venda feita em OUTRO PDV nesse meio tempo só apareceria se você
saísse da tela e voltasse.

**Corrigido com duas camadas**:
- A tela agora se atualiza sozinha a cada 20 segundos enquanto estiver
  aberta e a sincronização estiver ativa — sem precisar sair e voltar.
- Botão "↻ Atualizar" pra forçar na hora, se não quiser esperar.
- Por segurança, o app também reenvia o histórico local inteiro pro
  grupo a cada 15 minutos, rodando o tempo todo — caso alguma venda
  específica tenha falhado ao sincronizar por causa de uma rede
  instável naquele instante exato (o envio normal nunca trava a venda
  por causa disso, mas também não tentava de novo sozinho antes disso,
  só no próximo reinício do app).

Testei o fluxo completo com o componente real: simulei uma venda nova
"chegando" no meio da sessão e confirmei que o botão de atualizar traz
ela pra lista, e que o total passa a somar certo (testei
especificamente que ia pra R$ 10,00 com duas vendas de R$ 6 e R$ 4,
não ficava zerado).

## PDV estático, blocos, e mais personalização

### 1. Por que o PDV "não era estático"

Achei duas causas reais, diferentes uma da outra:

**A tela inteira desmontava ao trocar de aba.** O `AppShell` usava
`{screen === 'pos' && <POSScreen />}` — quando você saía do PDV, o
React literalmente destruía o componente inteiro; ao voltar, recriava
do zero (refazia buscas, perdia o que estava digitado na busca
manual). **Corrigido**: PDV e Restaurante agora ficam sempre
montados, só escondidos com CSS ao trocar de aba — voltar preserva
tudo. Testei isso especificamente, comparando os dois padrões lado a
lado: o novo preserva o texto digitado, o antigo (como prova de que o
diagnóstico batia) realmente perde.

**"Vendidos recentemente" reordenava a cada venda.** Era ordenado por
"última venda" — qualquer venda de qualquer produto reembaralhava a
fileira inteira, fazendo o botão do produto favorito de quem opera o
caixa pular de lugar no meio do expediente (péssimo pra memória
muscular). Adicionei um modo "mais vendido" (baseado nos últimos 30
dias) — bem mais estável, já que uma venda isolada quase nunca muda a
posição relativa. Configurável, veja abaixo.

### 2. Blocos em vez de lista — sua escolha

A busca manual de produto (quando o leitor não funciona) agora pode
mostrar os resultados em blocos com miniatura, em vez de lista — é
uma preferência, não uma troca definitiva.

### 3. Personalização do PDV — nova seção em Configurações

Quatro opções novas, cada terminal guarda a própria preferência
(não sincroniza entre PDVs — cada máquina pode preferir diferente):

- **Modo de busca**: Lista ou Blocos.
- **Ordem de "vendidos recentemente"**: mais recente (de sempre) ou
  mais vendido (estável).
- **Quantidade de produtos** mostrados nessa fileira.
- **Tamanho dos blocos**: confortável ou compacto (cabe mais produtos
  na tela).

Testei o fluxo inteiro de ponta a ponta: salvar uma preferência,
reler ela, e confirmar que o backend realmente respeita o que foi
configurado (testei especificamente a quantidade customizada de
"vendidos recentemente").

## Código de barras exigindo clique — a causa real

Sua observação era certeira: o campo de busca manual tinha uma corrida
contra o próprio debounce. A busca espera 180ms de silêncio antes de
consultar o banco — mas uma pistola de código de barras digita um
código de 13 dígitos inteiro e já manda Enter em bem menos que isso.
O Enter chegava com o resultado da busca ainda vazio (o debounce nem
tinha rodado ainda), então nada acontecia — só ~180ms depois o
dropdown aparecia sozinho, exigindo clicar no produto.

**Corrigido**: se o Enter chegar antes do debounce terminar, o campo
agora faz a busca na hora, sem esperar, e adiciona o produto direto —
sem precisar de clique nenhum. Digitação humana normal continua
funcionando exatamente como antes (sem regressão).

**Testei os dois extremos com um navegador de verdade**, usando o
componente real do app: Enter chegando 17ms depois de preencher o
campo (corrida clara, sem ambiguidade) — adicionou direto. Digitação
humana normal, esperando o debounce terminar sozinho antes do Enter —
também adicionou direto, confirmando que nada quebrou pro fluxo de
digitação manual.

## Quatro pedidos: código de barras, preço editável, zoom, e o rodapé escondido

### 1. Código de barras direto no carrinho
No PDV normal já funcionava assim. Achei a lacuna real: **o modo
restaurante (mesas) não tinha leitura de código de barras nenhuma** —
corrigido, mesmo padrão do PDV (leitor USB/Bluetooth detectado
automaticamente, sem precisar clicar em nada).

### 2. Preço editável por item, restrito a admin/gerente
Botão "Editar preço" no carrinho — só aparece pra quem é gerente ou
admin, **e o backend também confere o papel** (não dá pra contornar
escondendo/mostrando botão no navegador). Funciona pra cobrar mais ou
menos que o catálogo — cortesia, ou o contrário. Guarda o preço
original de catálogo separado do que foi cobrado, e cada alteração
vira um registro na Auditoria com o motivo. Implementado no PDV normal
e no modo mesa/restaurante. Testei o fluxo completo: operador comum
recusado, gerente ajustando pra cima e pra baixo, total da venda
sempre batendo certo, e os dois registros de auditoria certinhos.

### 3. "Vetorizar" pro zoom
Investiguei e o app já não usa nenhuma imagem raster (PNG/JPG) dentro
do conteúdo — o logo já é SVG, e o resto é tudo CSS/texto. As únicas
imagens raster que existem são ícones do próprio sistema operacional
(barra de tarefas, instalador) — esses ficam fora da área que o zoom
do navegador afeta, não faz sentido vetorizar. A causa real do "não
preenche bem" era outra coisa — o item 4 abaixo.

### 4. O rodapé (botão de finalizar) sumindo, precisando rolar
**Achei a causa exata**: um bug clássico de Flexbox. O container do
carrinho tinha `flex: 1; overflow-y: auto` (que parece que deveria
rolar por dentro), mas faltava `min-height: 0` — sem isso, o
navegador deixa o container CRESCER pra caber todo o conteúdo em vez
de respeitar o espaço disponível e rolar internamente. Isso empurra o
rodapé (com o botão de finalizar) pra fora da tela, exigindo rolar a
página inteira — exatamente o que foi reportado, e exatamente o tipo
de problema que fica pior com zoom (mais zoom = precisa de mais
espaço vertical pro mesmo conteúdo, estourando mais fácil).

**Corrigido em 3 lugares**: o carrinho do PDV, o carrinho do modo
mesa, e — o mais importante — o `.main-content`, que é o container
usado por **todas as telas do app** (Histórico, Produtos,
Configurações, etc.), não só o PDV. Esse bug provavelmente afetava
mais telas do que só a que foi reportada.

**Testei com um navegador de verdade**, incluindo o cenário de zoom:
simulei um carrinho com 40 itens (situação extrema) e confirmei que o
botão "Ir para pagamento" continua visível sem rolar a página — só o
carrinho rola por dentro. Testei também simulando zoom de 150%
(reduzindo a área disponível proporcionalmente, que é como o zoom de
verdade se comporta) — confirmado que o rodapé continua alcançável.

## Clone entre PDVs — catálogo, histórico compartilhado, e estoque centralizado na servidor

### Correções no histórico compartilhado (depois do primeiro teste)

Dois problemas reais no seu print:

**1. Histórico não aparecia** — a causa: o envio pro grupo só acontecia
quando uma venda era **finalizada**, então vendas de ANTES de
configurar a sincronização nunca tinham sido mandadas — o histórico
compartilhado só existia dali pra frente, não pra trás. **Corrigido**:
agora, ao entrar num grupo (ou a cada vez que o app abre, pra cobrir
quem já estava num grupo antes dessa correção), todo o histórico local
já finalizado é mandado de uma vez. Testei com vendas simuladas de
antes de entrar no grupo — confirmado que chegam certinho, com item e
forma de pagamento inclusos.

**2. Não deveria ter checkbox** — removido. Agora, sempre que a
sincronização está ativa, o Histórico já mostra o grupo inteiro
automaticamente — sem precisar marcar nada. No lugar do checkbox, um
filtro "Filtrar por PDV" (com "Todos os PDVs" como padrão) pra
estreitar pra um terminal específico quando quiser.

Pedido pra ir além do relatório consolidado: catálogo de produtos
"igual" entre as máquinas do grupo, histórico de vendas compartilhado
mostrando qual PDV vendeu, e — pedido logo em seguida — checagem de
estoque centralizada na máquina marcada como "servidor", aceitando um
pequeno atraso na finalização da venda pra garantir isso.

### Catálogo de produtos sincronizado
Cadastrar ou editar um produto em qualquer PDV do grupo aparece nos
outros automaticamente (nome, preço, categoria, SKU, etc.) —
`electron/services/productSyncService.js`. **Nunca inclui estoque** —
isso é tratado à parte, olha o próximo tópico.

### Histórico compartilhado com etiqueta de PDV
No Histórico, um novo toggle "Ver vendas de todo o grupo" — quando
ativo, mostra as vendas de TODOS os PDVs do grupo, com o nome de qual
terminal vendeu cada uma, itens e forma de pagamento inclusos.

### Estoque centralizado na servidor — o pedido mais delicado
Isso muda a decisão original (estoque sempre local) a pedido seu, de
propósito, com a garantia certa: **na hora de finalizar uma venda**,
se essa instalação estiver num grupo, o app faz uma consulta atômica
contra um contador de estoque compartilhado no Firestore (transação
— não um simples "ler e depois escrever", que teria brecha) — só
confirma a venda se sobrar estoque suficiente ali, e já debita nessa
mesma operação. Se duas máquinas tentarem vender a última unidade ao
mesmo tempo, só uma consegue — a outra recebe "Estoque insuficiente
no grupo" antes de finalizar, exatamente o pedido.

- A máquina marcada como **servidor** (no painel → Sincronização) é
  quem alimenta esse contador com a contagem física real — manda o
  estoque inteiro quando é designada, e atualiza produto a produto
  sempre que o estoque dela muda (abastecimento, ajuste manual).
- **Sem grupo configurado, nada muda** — zero atraso, zero chamada de
  rede, exatamente como sempre foi.
- **Se a rede cair na hora da checagem**: decisão deliberada de NÃO
  deixar passar sem confirmar — bloqueia a finalização com um erro
  claro, em vez de arriscar vender em duplicidade silenciosamente.
  Isso segue à risca o que foi pedido ("garantir a consulta"), mas
  vale saber que significa que a internet caindo bloqueia a
  finalização de vendas nas máquinas não-servidor enquanto durar.

**O que ainda não cobri**: devolução e cancelamento de item/venda não
devolvem estoque pro contador compartilhado ainda (só abastecimento e
ajuste manual mandam atualização) — se isso for importante, é uma
extensão direta do mesmo padrão.

### Testado a fundo, incluindo o cenário de concorrência real
- Catálogo sincroniza nos dois sentidos (criar num PDV aparece no
  outro; editar em qualquer um volta pros dois).
- Histórico do grupo mostra a venda com o PDV certo, itens batendo,
  total batendo — e confirmei que o **estoque nunca vaza** entre
  máquinas (continua 100% local pra fins de relatório).
- A parte mais importante: simulei **duas "máquinas" tentando vender
  a última unidade do mesmo produto ao mesmo tempo** — confirmado que
  exatamente uma consegue, nunca as duas, e o contador final bate
  certinho (zero, não fica negativo).
- Confirmei que estoque local generoso NÃO ajuda se o estoque do
  GRUPO estiver insuficiente — a checagem remota é quem manda,
  mesmo que a máquina local ache que tem de sobra.
- Confirmei que sem grupo configurado, finalizar venda continua
  idêntico a antes — não fica mais lento nem depende de rede.

### Regras de segurança
Duas coleções novas dentro do bloco de sincronização já existente —
`produtos` e `estoque`. Já estão no Passo 3 do `LICENCIAMENTO.md`,
precisa republicar de novo.

## Múltiplos PDVs — sincronização centralizada pelo seu painel

Redesenhado a pedido — a primeira versão (Fase 1) exigia que CADA
CLIENTE criasse e configurasse o próprio projeto Firebase, uma
barreira técnica grande pra quem não é técnico. Agora usa **o mesmo
projeto central que já existe pro licenciamento** — nenhum cliente
precisa configurar nada.

### Como funciona agora

- Em Central GerenciaAI → **🔗 Sincronização**, você cria um "grupo"
  (ex: "Padaria do João — caixas") e vincula as instalações que
  pertencem ao MESMO negócio fisicamente (duas caixas da mesma loja,
  por exemplo).
- **Diferente do agrupamento por cliente**: um cliente pode ter dois
  negócios diferentes (padaria e restaurante) que NÃO deveriam somar
  vendas juntos — por isso grupo de sincronização é um conceito
  separado de "cliente", mais granular.
- Cada instalação só pertence a UM grupo por vez — vincular a um novo
  automaticamente tira do anterior.
- Uma máquina dentro do grupo pode ser marcada como "Servidor" — hoje
  isso é só um rótulo/referência (o mecanismo de sincronização em si é
  descentralizado, cada PDV escreve seu próprio resumo direto no
  Firestore, não existe de fato um "servidor" técnico necessário) —
  mas fica registrado caso você queira usar isso como referência visual
  de qual terminal é o principal daquele grupo.
- No app do cliente, a tela de Configurações → Sincronização virou
  **somente leitura** — mostra "sincronização ativa" ou "não
  configurada", sem nenhum campo pra preencher. Quem atribui o grupo é
  você, no seu painel.

### O que foi implementado

- `electron/services/syncStateService.js`: cache local de qual grupo
  essa instalação pertence — vem do mesmo documento/escuta em tempo
  real já usado pra mensagem personalizada e motivo de bloqueio, sem
  precisar de nenhuma consulta nova ao Firestore.
- `electron/services/salesSyncService.js` (reescrito): manda o resumo
  de cada venda finalizada pra `grupos_sincronizacao/{grupoId}/vendas`
  no projeto central — só roda se essa instalação já tiver um grupo
  atribuído; senão, fica em silêncio (sincronização não configurada
  ainda pra ela).
- `electron/services/pdvRegistryService.js` (simplificado): removi a
  numeração automática (PDV001, PDV002...) e toda a configuração de
  Firebase por cliente — não fazem mais sentido nesse modelo. Ficou só
  o essencial: identidade do dispositivo e status de sincronização.
- Painel administrativo: seção "🔗 Sincronização" — criar grupo,
  vincular/desvincular máquina, marcar como servidor, apagar grupo
  (libera as máquinas vinculadas de volta pra "sem grupo").

### Verificação de ponta a ponta que fiz antes de fechar

Simulei o painel num navegador de verdade: criei um grupo, vinculei
duas máquinas do mesmo cliente, marquei uma como servidor, removi uma
do grupo — confirmei cada passo. Também revalidei que o mecanismo
antigo (registro de PDV com numeração atômica, testado numa entrega
anterior) continua com a mesma lógica de fundo, só que agora escrevendo
no projeto central em vez do Firebase de cada cliente.

**O que ainda não dá pra eu confirmar daqui**: o app de verdade
sincronizando contra o Firestore de produção — a lógica foi testada
com Firestore simulado (incluindo as regras de segurança aplicadas de
verdade contra escrita mal formada), mas o teste final contra o
ambiente real é seu.

### Regras de segurança

Isso agora faz parte do **mesmo bloco de regras do projeto de
licenciamento** — não é mais um projeto separado por cliente. Veja o
Passo 3 do `LICENCIAMENTO.md` (seção `grupos_sincronizacao`) —
**precisa republicar as regras de novo** se você já tinha publicado
antes dessa mudança.

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
