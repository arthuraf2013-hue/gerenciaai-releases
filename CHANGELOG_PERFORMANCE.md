# Atualização de performance — GerenciaAI

Resumo técnico de tudo que mudou nesta rodada de otimização geral. Nenhuma
tela nova, nenhum comportamento visível diferente — o foco foi só deixar o
que já existe mais rápido e mais leve, sem trocar nada que o usuário final
perceba (a única exceção é um bug real corrigido de passagem, sinalizado
abaixo).

## 1. Filtros de data que travavam o banco numa varredura completa

Praticamente toda tela que filtra por período (Histórico, Painel,
Auditoria, Devoluções, Despesas, Desperdício, relatório de compras por
cliente...) usava o mesmo padrão:

```sql
WHERE date(coluna, '-3 hours') BETWEEN date(?) AND date(?)
```

Isso dá o resultado certo (converte o horário UTC gravado no banco pro
dia local de Brasília antes de comparar), mas embrulhar a COLUNA numa
função impede o SQLite de usar qualquer índice nela — toda consulta virava
uma varredura da tabela inteira, mesmo pedindo só "hoje". Em tabelas que
só crescem (vendas, auditoria, movimentos de estoque, devoluções,
despesas), isso ia ficando mais lento a cada mês de uso.

**A troca:** em vez de converter a coluna, converte o INTERVALO pedido
(só duas datas, calculadas uma vez) pros limites UTC equivalentes —
`coluna >= inicioUtc AND coluna < fimUtcExclusivo`. Mesmo resultado,
sargable (usa índice normalmente). Nova função compartilhada
`timeService.localDateRangeToUtcBounds()`, com 7 testes cobrindo virada de
mês, virada de ano, ano bissexto e a equivalência byte-a-byte com o filtro
antigo.

Arquivos corrigidos: `saleService.js`, `dashboardService.js`,
`authService.js`, `fiscalService.js`, `reportService.js`,
`returnService.js`, `salesSyncService.js`, `expenseService.js`,
`metricsService.js`, `wasteService.js`.

Deixado de propósito fora do escopo: `cashService.js` já usa esse filtro
SEM o deslocamento de `-3 horas` (uma inconsistência que já existia antes
desta rodada) — mudar isso seria uma correção de comportamento, não uma
otimização, e não deveria acontecer escondida dentro de uma atualização
de performance. Criei a função irmã `utcDateRangeToBounds()` já pronta
pra esse ajuste, caso você queira fazer essa correção depois, mas não
mexi no arquivo em si.

## 2. Índices novos no banco (`schema.sql`)

Suporte direto pros filtros sargable acima, e pras consultas mais comuns
de vendas/clientes:

- `sales(location_id, status, finalizada_em)`
- `sales(location_id, COALESCE(finalizada_em, criado_em))` — índice de
  expressão, cobre a "data efetiva" usada no Histórico
- `sales(finalizada_em)`
- `sales(customer_id, status, finalizada_em)`
- `customers(telefone)`, `customers(cpf)`, `customers(cnpj)`
- `stock_movements(location_id, tipo, criado_em)`
- `returns(location_id, criado_em)`
- `expenses(location_id, criado_em)`

Todos `CREATE INDEX IF NOT EXISTS` — aplicados automaticamente na próxima
vez que o app abrir, sem precisar de nenhuma migração manual.

## 3. Consulta N+1 na previsão de ruptura de estoque

`stockService.previsaoDeRuptura` fazia uma consulta de "quanto vendeu nos
últimos 30 dias" **por produto**, dentro de um loop — numa loja com
centenas de produtos em estoque, isso virava centenas de consultas extras
toda vez que a tela de Alertas abria (ou o alerta automático de estoque
baixo do WhatsApp rodava). Reescrito pra uma única consulta agregada
(`GROUP BY product_id`) antes do loop.

## 4. PRAGMAs do SQLite (`electron/db/database.js`)

- `synchronous = NORMAL` (em vez do padrão `FULL`) — com WAL já ativo,
  isso garante durabilidade contra o cenário real que importa (o processo
  travar), ao custo de escrita bem mais rápida em toda venda/movimento de
  estoque. Só uma queda de energia no meio exato de um checkpoint poderia
  perder as últimas transações.
- `cache_size = -20000` (~20MB) e `mmap_size = 268435456` (256MB) —
  ajudam consultas de relatório/dashboard que varrem tabelas grandes.

## 5. Migração que rodava pra sempre, sem necessidade

Uma `UPDATE products SET codigo_barras = NULL, sku = NULL WHERE ativo = 0
AND (...)` — uma correção pontual de dados antigos — rodava (varrendo a
tabela `products` inteira) TODA VEZ que o app abria, pra sempre, mesmo
depois de não sobrar mais nenhum produto pra corrigir. Agora é marcada
como aplicada via `PRAGMA user_version` (bit 1) e só roda uma vez de
verdade, na próxima abertura do app.

## 6. Reconquista automática do WhatsApp recalculava a lista a cada 10 min

`whatsappAutomationService.executarReconquistaAutomatica` recalculava a
lista de "clientes que sumiram" (uma consulta que varre clientes/vendas)
do zero a cada 10 minutos, o dia inteiro — mesmo já tendo um cooldown por
cliente que impedia mandar mensagem duplicada. Adicionada a mesma guarda
diária que as automações irmãs (alerta de estoque, resumo diário) já
usavam: agora roda no máximo uma vez por dia. Cliente que sumiu há
semanas não perde nada relevante esperando até 24h a mais pelo aviso.

## 7. Três jobs periódicos sem proteção contra sobreposição (`main.js`)

Os pollers de lembrete de reserva (5 min), automações de WhatsApp
(10 min) e reenvio de NFC-e pendente/contingência (5 min) podiam se
sobrepor numa máquina lenta ou com internet ruim (uma passada ainda
rodando quando a próxima do `setInterval` disparava) — risco de mandar a
mesma mensagem duas vezes ou reenviar a mesma NFC-e em paralelo.
Adicionada uma guarda simples (`executarSeNaoEstiverRodando`): se a
execução anterior de um job ainda não terminou, a nova chamada é pulada.

## 8. Cópia de arquivos do backup travava a interface

`backupService.js` usava `fs.rmSync`/`fs.cpSync` (síncronos) pra espelhar
fotos de produto, anexos e XMLs de NFC-e a cada backup — travava a thread
principal (e com ela toda a UI do Electron) pelo tempo inteiro da cópia,
em instalações com bastante desses arquivos. Trocado por
`fs.promises.rm`/`fs.promises.cp`. Isso tornou `restoreBackup` (e a rotina
interna que devolve os arquivos do espelho na restauração) assíncrona —
o handler IPC (`backup:restore`) e os testes correspondentes foram
ajustados para `await` o resultado.

## 9. Lançar pedido de mesa fazia um commit por item

`botOrderService.lancarPedidoNaMesa` chamava `saleService.addItem` uma
vez por item do pedido, cada chamada com sua própria transação — um
pedido com vários itens virava vários commits separados no WAL.
Agrupado numa única transação externa (o better-sqlite3 já suporta
transação aninhada via SAVEPOINT automático), sem mudar o comportamento
de item sem estoque (só loga o erro, não interrompe os demais).

## 10. Dependências pesadas carregadas no boot do app, mesmo sem uso

`exceljs` (import/export de planilha), `node-forge` e `xml-crypto`
(certificado e assinatura de NFC-e) eram importadas no topo do arquivo —
pagando o custo de carregar essas bibliotecas em TODO boot do app, mesmo
em instalações que nunca usam import de planilha ou nunca emitem NFC-e.
Movidas pra dentro das funções que realmente as usam (mesma convenção já
usada no projeto para `firebase` e `@whiskeysockets/baileys`).

## 11. Frontend: telas carregadas sob demanda (`React.lazy`)

`AppShell.jsx` importava estaticamente as ~19 telas do menu — todo mundo
baixava e interpretava o código de Painel, Configurações, Financeiro,
Cozinha, NFC-e etc. só para abrir o PDV, a tela que 100% dos usuários veem
primeiro. As ~16 telas que só entram na árvore quando o usuário navega
até elas agora usam `React.lazy()` + `<Suspense>`, cada uma virando um
chunk separado do Vite. PDV e Restaurante ficaram de propósito com import
estático — já ficam sempre montados desde o primeiro render (por design,
pra preservar carrinho/estado ao trocar de aba), então adiar o carregamento
deles não pouparia nada.

Duas bibliotecas específicas também passaram a carregar sob demanda, só
no clique que realmente precisa delas:

- `jsbarcode` (`ProductForm.jsx`) — só no clique de "Imprimir etiqueta".
- `qrcode` (`PaymentPanel.jsx`) — só ao gerar QR code de Pix.

## 12. Frontend: cálculos repetidos em todo re-render

Três telas recalculavam filtro/ordenação/soma em TODO re-render do
componente, mesmo sem os dados de entrada terem mudado (ex: cada tecla
digitada num campo do modal, ou abrir/fechar qualquer outro popup):

- `CustomerList.jsx` — filtro+ordenação de "só quem deve".
- `ProductProfitReport.jsx` — soma de receita/lucro e ordenação da tabela
  de produtos.
- `SalesHistory.jsx` — filtro por cliente, lista de PDVs disponíveis, e o
  total do dia.

Todos agora usam `useMemo`, recalculando só quando os dados relevantes
realmente mudam.

---

## Bug corrigido de passagem (não é otimização)

`reportService.getCustomerPurchaseReport` usava `getDb()` sem nunca
importar essa função — um `ReferenceError` real, que quebrava esse
relatório toda vez que alguém tentava vê-lo. Corrigido junto porque a
mesma função já estava sendo editada por causa do filtro de data.

---

## O que ficou de fora desta rodada (oportunidades futuras)

- `cashService.js`: mesmo filtro de data do item 1, mas sem o
  deslocamento de `-3 horas` — correção de comportamento, não de
  performance (ver item 1).
- `fiscalService.livroDeControlados`: usa
  `json_extract(p.custom_fields, '$.controlado') = 1`, que também não
  usa índice — precisaria de uma coluna real indexada pra resolver
  de verdade.
- Paginação no backend para `ReturnFlow`/`QuotesScreen`/`AgendaScreen` —
  não mexido nesta rodada por exigir verificação visual do app rodando,
  que não foi possível fazer neste ambiente.
- `SettingsScreen.jsx`: poderia carregar cada aba sob demanda também
  (hoje é uma tela só, sempre carregada inteira quando alguém abre
  Configurações).


---

# v1.0 — rodada de desempenho para máquina fraca (Celeron, 4 GB de RAM)

Objetivo: o app inteiro rodar bem num Celeron/Pentium/Atom com 4 GB de
RAM **sem perder nenhuma funcionalidade**. Toda troca abaixo devolve
exatamente o mesmo resultado que antes — `tests/desempenho.test.js` (10
testes) reproduz a lógica antiga e compara com a nova.

## Números medidos

Banco sintético de "loja grande com 1 ano de uso" (8.000 produtos,
65.880 vendas, 197 mil itens, 3.000 clientes, 232 MB), **rodando em 1
núcleo só** (`taskset -c 0`) pra se aproximar de um Celeron. Média de
várias execuções, mesma máquina, mesmo banco (`bench/medir.js`).

| Operação | v0.5.99 | v1.0 |
|---|---:|---:|
| Busca do PDV "ca" (381 resultados) | 36 ms | 14 ms |
| Busca do PDV "cafe pilao" | 20 ms | 1,2 ms |
| Busca do PDV "biscoito" | 25 ms | 5 ms |
| Busca por código de barras (Enter) | 18 ms | 1,1 ms |
| Atalhos "vendidos recentemente" do PDV | **660 ms** | **5 ms** |
| Catálogo do celular com estoque (800 itens, a cada ~25 s) | 241 ms | 10 ms |
| Tela Estoque (8.000 produtos) | 247 ms | 44 ms |
| Lista de produtos, 1ª página | 6 ms | 2,4 ms |
| Venda completa, painel, histórico, fechamento de caixa | = | = (sem regressão) |
| Abertura do banco (a partir da 2ª vez) | 9 ms | 5–10 ms |
| **Primeira** abertura depois de atualizar (cria os índices novos) | — | ~0,9 s, uma vez só |

Fora o tempo de CPU, o que mais pesa numa máquina de 4 GB é o que roda
em segundo plano. Isso caiu bastante:

- **Escritas no Firestore**: o status ao vivo, o status de usuários e o
  histórico remoto não rodam nada se não houver celular pareado. Quando
  há, só reenviam o documento inteiro se algo mudou; se não mudou,
  mandam só um "ainda estou vivo" (um campo) e republicam completo no
  máximo a cada 10 min (status) / 30 min (usuários).
- **Vendas do grupo**: em vez de reenviar os últimos 60 dias inteiros a
  cada 15 min, envia só as vendas novas ou alteradas (tabela
  `group_sync_sales`, invalidada por gatilho em `sales`, `sale_items` e
  `payments`). A repassada completa de 60 dias continua existindo como
  rede de segurança, mas uma vez por dia.
- **Catálogo do grupo**: o listener aplica só as mudanças
  (`docChanges()`) em vez de reconstruir o mapa inteiro a cada evento.

## O que mudou, por área

### Banco (`schema.sql`, `database.js`)

- Índice cobrindo `stock_movements(product_id, location_id, quantidade)`,
  que substitui o antigo `idx_stock_mov_product_loc` (removido pela
  migração por ser redundante). O saldo de estoque passa a ser lido só
  do índice, sem tocar na tabela.
- Índice `sale_items(criado_em)` para os atalhos de "vendidos
  recentemente".
- Tabela `cache_versao` + gatilhos em `products`: qualquer
  inserção/alteração/exclusão de produto (por qualquer caminho, inclusive
  sync e importação) incrementa a versão, e o cache de busca em memória
  se invalida sozinho.
- PRAGMAs ajustados ao hardware: `cache_size` de 10 MB e `mmap_size` de
  128 MB no modo leve (20 MB e 256 MB nos demais); `temp_store = MEMORY`.
- `PRAGMA optimize` na abertura (com limite, pra não demorar) e a cada
  6 h. **Pegadinha encontrada na medição:** o better-sqlite3 é compilado
  com `SQLITE_ENABLE_STAT4`. Com amostras em `sqlite_stat4`, o SQLite
  **reprepara a statement toda vez que o valor do parâmetro muda** — em laço
  (itens de cada venda, estoque de cada produto) isso dobrava o custo
  (69 → 138 ms em 11 mil buscas). `otimizarBanco()` mantém o
  `sqlite_stat1` (que melhora os planos: a mesma busca ficou em 56 ms) e
  esvazia o `sqlite_stat4` logo depois. Teste dedicado.

### Busca do PDV (`productService.list`)

Índice em memória dos produtos ativos (nome normalizado, SKU, código),
cacheado pela versão de `cache_versao`. A busca não varre mais a
tabela nem normaliza 8.000 nomes a cada tecla. Relevância, ordenação,
limite e cursor idênticos. O frontend passou a pedir `limit: 8` na busca
digitada e `limit: 1` no Enter/leitor.

### Atalhos de "vendidos recentemente" (`saleService.listRecentlySold`)

Antes agrupava **todo** o histórico de itens vendidos. Agora lê só as
últimas linhas pelo índice de data e para assim que junta produtos
distintos suficientes, com fallback pro agrupamento completo se a
janela não bastar. Mesmo resultado (teste compara os dois).

### Inicialização (`main.js`)

A janela abre primeiro. Os serviços em segundo plano entram em três
etapas, depois que a janela está pronta:

1. 1,5 s: atualização, licença, mensagens, pareamento, pedidos do
   garçom, PDV móvel.
2. 15 s (40 s no modo leve): sync de produtos, status ao vivo, status de
   usuários, histórico remoto, WhatsApp.
3. 60 s (150 s no modo leve): backup e vendas do grupo.

`registerIpcHandlers` passou a ser carregado sob demanda e a janela usa
`v8CacheOptions: 'bypassHeatCheck'` (cache de código compilado desde a
primeira abertura).

### Frontend

- Mais telas e modais carregados sob demanda (`React.lazy`): montador de
  item personalizado, anexos da venda, cadastro por foto, fechamento de
  caixa, treinamento, cardápio do dia e cardápio digital. O bundle
  principal ficou ~23 KB menor.
- `AppShell` só re-renderiza os pedidos ativos quando eles mudam de
  verdade; o relógio compacto atualiza uma vez por minuto em vez de
  por segundo, com formatadores reaproveitados.

### Modo leve (novo, em Configurações → Geral → Desempenho)

`electron/services/hardwareService.js` detecta a máquina: liga o modo
leve sozinho com RAM ≤ 4,6 GB, 2 núcleos ou menos, ou CPU de entrada
(Celeron, Pentium, Atom, Athlon, Sempron, N4xxx/N5xxx/Jxxxx) com até
8 GB. O modo leve:

- desliga transições/animações de interface e rolagem suave (os
  indicadores de carregamento continuam girando);
- reduz o cache do SQLite;
- adia mais os serviços de segundo plano na abertura.

**Nenhuma funcionalidade é desligada.** A tela mostra CPU, núcleos e
RAM detectados e deixa forçar "Sempre ligado" ou "Desligado"
(preferência local da máquina, `localStorage`
`gerenciaai:modoLeve`).

## Correção: "no such column: pendente_estoque_grupo" ao abrir

A versão anterior travava a abertura em bancos antigos: o `schema.sql` (que
roda **antes** das migrações) criava um índice numa coluna que só a
migração adiciona. Corrigido em dois níveis:

1. Os índices dessas colunas (`idx_sales_pendente_estoque_grupo`,
   `idx_customers_cnpj`) foram para dentro de `migrateColumnsIfNeeded`,
   logo depois do `ALTER TABLE` correspondente.
2. Rede de segurança (`aplicarSchemaComRedeDeSeguranca`): se o
   `schema.sql` falhar com "no such column", roda a migração primeiro e
   aplica o schema de novo, em vez de impedir o app de abrir. Testado
   com um banco real de uma instalação antiga.
