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
