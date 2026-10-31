# GerenciaAI ERP: changelog

## 31/10/2026: cadastro automático de produtos e impostos
- `cadastroAutomaticoService`: produtos da nota (prévia + cadastro, vincula por EAN em vez de
  duplicar), sugestão pelo NCM no formulário, NCM pela IA (Gemini, só sugestão validada),
  reajuste de preço pela margem depois da entrada.
- `assistenteFiscalService.fiscalDaLoja`: CFOP/CSOSN/CEST mais usados pela loja para o NCM;
  nunca passa por cima de CFOP válido diferente (não perde ST).
- `nfeEntradaService.confirmar` também completa CFOP/CSOSN quando os dois estão vazios.
- `motorTributarioService.conferirCadastro`: cadastro × regras, com aplicar.
- `erp_config.margem_padrao` e `arredondamento_preco` (colunas novas, migradas).

## 31/10/2026: fundação e motor tributário
- Permissões finas: admin retira áreas do ERP (compras, financeiro, inventário, fiscal,
  configurações) de um gerente. Tabela `user_permission_overrides`, `permissaoService`,
  checagem em `politicaDeAcesso`, tela Usuários → Permissões do ERP, telas mostram
  "sem acesso" em vez de "módulo inativo".
- Motor tributário: tabela `tax_rules` (versionada), `motorTributarioService`,
  `regrasTributariasPadrao` (Simples/MEI e IBS/CBS de teste 2026), aba Fiscal → Regras
  tributárias com simulador por produto. Mudanças na Auditoria.
- Documentação `docs/ERP-*.md`. Rótulos novos na Auditoria para os eventos do ERP.

## 31/10/2026: Fases 2 a 4 (financeiro, inventário, assistente fiscal)
- Ver README, entrada "ERP, Fases 2 a 4". Módulos pagos `erpFinanceiro`, `erpEstoque`, `erpFiscal`.

## 30/10/2026: Fase 1 (compras), commit `aeab4f7`
- Custo médio, pedido de compra, entrada pelo XML da NF-e. Módulo pago `erpCompras`.
