# GerenciaAI ERP: changelog

## 01/11/2026: Etapas 2 a 5 (terceira leva)
- **Migrações versionadas** (`electron/db/migracoes.js`, tabela `schema_migrations`): cada mudança de
  banco é uma migração numerada com `up`/`down`, transacional e idempotente. A migração 1 traz tudo
  abaixo; o `schema.sql` não repete o que está nela. Teste de ida, volta e ida em base populada.
- **Auditoria imutável**: gatilhos impedem UPDATE/DELETE em `audit_log`; colunas `entidade`,
  `entidade_id`, `dados_antes`, `dados_depois` nas alterações novas (fiado, despesas, contabilidade,
  segurança, caixa).
- **Caixa** (tela nova em Vendas → Caixa): abertura, sangria (com motivo, nunca acima do que está na
  gaveta), suprimento, fechamento com conferência por forma de pagamento (`cash_movements`,
  `cash_sessions.conferencia_json`). O fechamento do PDV continua igual e já desconta sangrias.
- **Limite de desconto do operador** (`security_config.limite_desconto_operador`): até X% sem PIN,
  acima só com gerente; vale com a chave geral ligada ou desligada. Tela Usuários.
- **Fiado**: limite e bloqueio por cliente (`customers.limite_fiado`, `fiado_bloqueado`), conferidos
  no pagamento e na finalização (balcão e celular). Financeiro → Contas a receber.
- **Baixa com juros, multa, desconto e parcial** em contas a pagar e a receber: o saldo vira uma
  conta nova (`parcial_de_id`); encargos vão para receitas/despesas financeiras na contabilidade.
- **Contabilidade gravada**: lançamento manual em partidas dobradas (`journal_entries`, só inclusão,
  correção por estorno), fechamento do mês com foto (`accounting_periods`) que trava despesas,
  recebimentos e lançamentos com data no mês; reabrir só admin/suporte com motivo; livro razão e
  DRE contábil. Contas novas no plano: imobilizado, empréstimos, impostos a recolher, capital,
  receitas e despesas financeiras.
- **Fiscal**: CRT 4 para MEI (antes saía 1, rejeitado desde abr/2025); rejeições da SEFAZ explicadas
  em português (`rejeicoesSefaz.js`); cStat 150 aceito como autorizado e 155 no cancelamento;
  Simples anexos II a V e fator R (`tabelasFiscais.aliquotaEfetivaSimples`, Ajustes do assistente);
  aviso de vencimento do certificado A1 (30 dias) no painel fiscal e no painel executivo;
  natureza da operação → CFOP (`natureza_operacao`, `naturezaOperacaoService`, Fiscal → Regras).
- **Validação de documentos** (`validadores.js`): CPF, CNPJ numérico e alfanumérico (IN RFB
  2.229/2024), IE de PE e SP; aplicada em clientes, fornecedores e configuração fiscal quando o
  documento muda.
- **Glossário** (Fiscal → Glossário) e `<Termo>` com explicação ao passar o mouse.
- `financeiroService.salvarConfig` agora valida tudo antes de gravar (tudo ou nada).

## 31/10/2026: gestão completa (segunda leva)
- Centros de custo (`centroCustoService`, `cost_centers`, `expenses.centro_custo_id` migrada).
- Inadimplência (`cobrancaService`): fiado FIFO, prazo configurável, faixas, mensagem de cobrança.
- Conciliação bancária OFX (`conciliacaoService`, `bank_statement_lines` com UNIQUE(conta, fitid)).
- Comissões e metas (`comissaoService`, `commission_rules`, `sales_goals`).
- Exportação contábil (`contabilService`, `accounting_map`), também no pacote do contador.
- Equipe (`rhService`, `employees`, `employee_vacations`).
- Painel executivo (`biService`).
- DIFAL no motor (`tax_rules.difal_base` migrada).
- Permissões novas: `erp.comercial`, `erp.bi`, `erp.rh` (tudo no módulo pago `erpFinanceiro`).

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
