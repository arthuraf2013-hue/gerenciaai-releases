# GerenciaAI ERP: integrações

## Fluxo da venda

| Etapa | Como acontece | Proteção contra duplicidade |
|---|---|---|
| Venda no PDV | `saleService` (balcão, mesa, bot, PDV móvel, terminal) | `mobile_sales`, `pdv_terminal_eventos` (idempotência por id do celular) |
| Baixa de estoque | movimento no livro `stock_movements` na finalização | livro só recebe lançamento novo; grupo multi-PDV por variação única |
| Custo da venda (CMV) | gatilho `trg_sale_items_custo` grava o custo médio no item | só quando `custo_unitario` é nulo |
| Financeiro | **lido** de `payments` + `card_fee_config` (não copiado): cartão a cair, fluxo, DRE | nada a duplicar; muda a venda, muda o relatório |
| Tributação | motor tributário resolve a regra por item (simulação e conferência) | regra versionada por vigência |
| Emissão fiscal | NFC-e por `fiscalService` (já existia; ainda usa o cadastro do produto) | `nfce_emitidas` por venda, contingência com a mesma numeração |
| Contador | pacote mensal (.zip) com vendas por CFOP/CSOSN/NCM, XMLs e financeiro | gerado sob demanda, não altera dados |
| Indicadores | dashboard e DRE calculados na hora | idem |

## Fluxo da compra

Pedido de compra → NF-e (XML) conferida → confirmação numa transação só: lote/movimento,
custo médio (antes do movimento), contas a pagar (`expenses.nfe_entrada_id`), NCM/CEST do
produto se vazios, abatimento do pedido. Estorno por lançamento novo, travado se alguma conta
já foi paga.

## Integrações externas

| Integração | Situação | Observação |
|---|---|---|
| SEFAZ (NFC-e 65) | implementada, não homologada com certificado real | URLs por UF em `nfceWebserviceUrls.js` |
| SEFAZ (NF-e 55 saída, manifestação) | não implementada | depende de certificado A1 e homologação |
| NFS-e (padrão nacional) | não implementada | prestadores de serviço; ambiente nacional e convênio do município |
| Firebase (licença, celular, grupo) | implementada | regras em `firestore.rules` |
| Mercado Pago (Pix automático) | implementada | token cifrado no processo principal |
| WhatsApp (bot e campanhas) | implementada | Baileys |
| IA (resumo, leitura de nota, tutor) | implementada | chave do usuário, `aiService` |
| Banco (conciliação) | a fazer | caminho previsto: importar OFX, sem credencial bancária |
| eSocial / folha | fora do escopo | só por integração com sistema especializado |

## Regras para nova integração

1. Credencial só no processo principal, cifrada (`secretsService`, `safeStorage`).
2. Caminho de arquivo só por diálogo do processo principal.
3. Toda resposta externa gravada com id próprio antes de aplicar (idempotência) e erro
   registrado sem expor segredo na Auditoria.
4. Não inventar endpoint nem leiaute: usar a documentação oficial (Portal da NF-e, SVRS,
   Receita) e deixar o ponto marcado como "não homologado" até testar.
