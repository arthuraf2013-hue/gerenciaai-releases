# GerenciaAI ERP: testes

## Como rodar

```
npm test                                   # suíte inteira (node --test)
node --test tests/motorTributario.test.js  # um arquivo
```

## Cobertura do ERP

| Arquivo | O que garante |
|---|---|
| `custoMedioService.test.js` | ponderação, estoque zerado/negativo, entrada sem custo |
| `nfeEntradaService.test.js` | leitura do XML, casamento de itens, confirmação, estorno, chave repetida |
| `purchaseOrderService.test.js` | estados do pedido, recebimento parcial, geração por sugestão |
| `erpFase1.test.js` | banco antigo abrindo com o schema novo, papel e módulo no IPC |
| `financeiroService.test.js` | cartão a cair, recorrência sem duplicar, parcelas, fluxo, DRE com CMV |
| `inventarioService.test.js` | contagem com vendas no meio, cega, zerar não contados, ajuste |
| `assistenteFiscalService.test.js` | RBT12, Anexo I, limite MEI proporcional, calendário, correção do cadastro, pacote |
| `erpFases2a4Ipc.test.js` | papel, módulo desligado, operador da sessão, arquivo só pelo diálogo |
| `motorTributario.test.js` | seeds idempotentes, especificidade, loja × sistema, vigência e versões, ST, validação, DIFAL avisado |
| `cadastroAutomatico.test.js` | nome/unidade/preço, produtos da nota (caixa→unidade, EAN repetido, EAN de produto inativo/ativo), confirmação completa fiscal, sugestão pelo NCM, maioria da loja sem perder ST, NCM pela IA (resposta inválida descartada), motor × cadastro, reajuste com conferência do preço anterior |
| `permissaoErp.test.js` | retirar/devolver área, admin/suporte nunca restritos, só admin muda, catálogo cobre canais reais, Auditoria |
| `ipcPoliticaAcesso.test.js` | toda política cita canal que existe |

Testes de mutação feitos à mão nesta fase (o teste precisa falhar quando a regra é removida):
gate de módulo no IPC, checagem de permissão na política de acesso, desempate loja × sistema
no motor; no cadastro automático: NCM válido sobrescrito, EAN repetido duplicado e regra
genérica atropelando CSOSN válido. Todos falharam como esperado e voltaram a passar com o
código restaurado.

## O que NÃO está coberto

- Emissão real na SEFAZ (sem certificado/CSC de homologação nesta máquina).
- Dados reais de loja (fluxo de caixa, DRE e pacote do contador conferidos só com dado sintético).
- Interface: verificada por captura de tela com os serviços reais (`.preview/`, fora do git),
  sem teste automatizado de componente.

## No ambiente de desenvolvimento em nuvem

Três testes dependem da pasta `pwa-mobile/` (vitrine e escape de HTML do app do celular) e só
passam na máquina com o repositório completo.
