# GerenciaAI ERP: o que existe × o que falta (Etapa 1)

Estado: 01/11/2026 (atualizado depois das Etapas 2 a 5 — ver ERP-CHANGELOG). Compara o prompt "ERP completo para micro e pequenas empresas" com o código atual.
Decisões tomadas antes: **evoluir o GerenciaAI** (sem reescrever), **manter as convenções atuais**
(JavaScript, reais com arredondamento, uma instalação por CNPJ) e **aprovar cada etapa** antes do código,
com mockup antes de cada tela nova.

Legenda: ✅ pronto e testado · 🟡 parcial · ⬜ falta · ⛔ depende de algo externo · ✖ não vamos fazer (motivo ao lado)

## Fundação
| Pedido | Situação |
|---|---|
| Electron + Vite + React | ✅ |
| TypeScript | ✖ decisão: JS; camada fiscal nova com JSDoc tipado |
| SQLite offline + Firebase (sync/backup) | ✅ |
| Core + módulos ativáveis por empresa | ✅ módulos pagos pela Central |
| Multiempresa | ✖ no mesmo banco; ✅ uma instalação por CNPJ + grupo de filiais |
| Multiusuário, perfis e permissões | 🟡 5 papéis + permissões finas do ERP; ⬜ perfis customizáveis por ação |
| Regras fiscais/contábeis separadas e testáveis | ✅ serviços puros com testes (motor, assistente, contábil) |
| Centavos inteiros | ✖ decisão: reais arredondados |
| Migrações versionadas | ✅ `schema_migrations` com up/down (`electron/db/migracoes.js`) |
| Auditoria de todas as alterações | 🟡 eventos sensíveis, imutável, antes/depois nas alterações novas; ⬜ antes/depois nas telas antigas |

## Linguagem simples
| Pedido | Situação |
|---|---|
| Explicação em toda tela | 🟡 telas do ERP têm; ⬜ padronizar nas antigas |
| Glossário (CFOP, NCM, CST...) e tooltips | ✅ Fiscal → Glossário e `<Termo>` nas telas novas |
| Padrões inteligentes (CFOP/CST/alíquota pela operação) | ✅ motor + cadastro automático + natureza da operação |
| Erros que dizem o que fazer | ✅ inclusive rejeições da SEFAZ (`rejeicoesSefaz.js`) |
| Assistente de primeira configuração (empresa → regime → certificado → série → nota de teste) | ⬜ |

## Módulos
| # | Pedido | Situação |
|---|---|---|
| 1 | Empresa (CNPJ, IE, IM, regime) | 🟡 falta IM e CNAE |
| 1 | Clientes/fornecedores com validação CPF/CNPJ/IE e busca por CNPJ/CEP | ✅ CPF/CNPJ (inclusive alfanumérico) e IE PE/SP; ⬜ IE das demais UFs (só formato); ⛔ busca CNPJ/CEP (escolher provedor) |
| 1 | Produto: código, EAN, NCM, CEST, unidade, fotos | ✅ |
| 1 | Variações, kits/composição, preço por tabela | ⬜ (composição existe só para restaurante/serviço) |
| 1 | Serviços com LC 116 e CNAE | ⬜ |
| 1 | Transportadoras | ⬜ |
| 1 | Vendedores com comissão, plano de contas, centros de custo | ✅ |
| 2 | Orçamento → venda | ✅ (→ nota: depende da NF-e 55) |
| 2 | PDV com leitor, atalhos, impressão térmica 58/80 mm | ✅ |
| 2 | Pagamentos múltiplos, troco, desconto | ✅ |
| 2 | Crédito parcelado | ⬜ parcelas viram recebíveis |
| 2 | Limite de desconto por perfil | ✅ limite % do operador, acima com PIN de gerente |
| 2 | Devolução, troca, cancelamento com estorno | ✅ |
| 2 | Caixa: abertura, fechamento com conferência | ✅ inclusive conferência por forma de pagamento (Vendas → Caixa) |
| 2 | Sangria e suprimento, diferença por forma de pagamento | ✅ |
| 2 | Offline com fila | ✅ |
| 2 | Atacado/varejo | ⬜ (preço por tabela) |
| 2 | Fidelidade | ✅ |
| 3 | Pedido de compra, recebimento com conferência | ✅ |
| 3 | Cotação entre fornecedores | ⬜ |
| 3 | XML de entrada com vínculo pelo código do fornecedor | ✅ |
| 3 | Contas a pagar automáticas, custo médio | ✅ (última compra: ⬜ opção) |
| 4 | Movimentos: entrada, saída, ajuste, perda | ✅ |
| 4 | Depósitos, transferência, bonificação | ⬜ |
| 4 | Inventário com acerto | ✅ |
| 4 | Lote e validade (FEFO) | ✅ lote/validade; 🟡 FEFO na baixa |
| 4 | Número de série | ⬜ |
| 4 | Mínimo, sugestão de compra, ABC, Kardex, custo médio | ✅ |
| 5 | Pagar/receber, recorrentes, parcelado | ✅ |
| 5 | Juros, multa, desconto, baixa parcial | ✅ (saldo vira conta nova ligada por `parcial_de_id`) |
| 5 | Boleto/PIX/cartão por gateway | 🟡 Pix automático (Mercado Pago); ⬜ boleto/CNAB ⛔ banco/gateway |
| 5 | Conciliação OFX e CSV | ✅ OFX; ⬜ CSV |
| 5 | Contas múltiplas e transferências | ⬜ |
| 5 | Fluxo realizado/projetado, inadimplência | ✅ |
| 5 | Lembretes de vencimento | 🟡 alertas no painel; ⬜ lembrete ativo |
| 5 | DRE gerencial por centro de custo | ✅ |
| 6 | NFC-e | 🟡 implementada (CRT do MEI corrigido); ⛔ homologação |
| 6 | NF-e 55 (venda, devolução, transferência, conserto, remessa, entrada própria) | ⬜ ⛔ homologação |
| 6 | NFS-e | ⬜ ⛔ adesão do município / padrão nacional |
| 6 | Cancelamento, CC-e, inutilização | 🟡 NFC-e; ⬜ CC-e |
| 6 | ICMS, ST, DIFAL, IPI, PIS/COFINS | ✅ motor (cálculo); ⬜ ligado à emissão |
| 6 | ISS, IRPJ, CSLL | ⬜ |
| 6 | Simples: CSOSN, anexos, faixas, sublimite | ✅ anexos I a V, fator R e limites |
| 6 | Tabelas parametrizadas com vigência | ✅ `tax_rules` e naturezas; ⬜ NCM/CEST/CFOP de referência |
| 6 | IBS/CBS com transição | 🟡 regras com vigência + teste 2026; ⬜ grupos no XML |
| 6 | Manifestação do destinatário | ⬜ ⛔ certificado |
| 6 | XML por 5 anos, DANFE em PDF, backup | 🟡 XML salvo e no pacote do contador; ⬜ retenção/DANFE PDF da NF-e |
| 6 | Apuração e guias (DARF, DAS, GNRE) | 🟡 DAS estimado; ⬜ resto |
| 6 | SPED Fiscal e EFD-Contribuições | ⬜ |
| 6 | Validações em tempo real | 🟡 formatos; ⬜ IE e tabelas |
| 6 | Certificado A1 com senha cifrada; A3 opcional | ✅ A1 com aviso de vencimento (30 dias); ⬜ A3 |
| 6 | Biblioteca/provedor homologado, protocolo, logs, idempotência | 🟡 emissor próprio; ⬜ log de transmissão e idempotência formais |
| 7 | Plano referencial (ECD), lançamentos automáticos | 🟡 de-para + lançamentos gerenciais na hora |
| 7 | Lançamento manual, diário, razão, balanço, DRE contábil, fechamento | ✅ manual, diário (lançamentos), razão, DRE contábil e fechamento com trava; ⬜ balanço acumulado |
| 7 | ECD e arquivos para o contador | 🟡 xlsx; ⬜ ECD |
| 8 | Folha (INSS, IRRF, FGTS, eSocial) | ⬜ fase 2 opcional; hoje: equipe e férias |
| 9 | Painel, lucratividade por produto/cliente, comissões, estoque | ✅ |
| 9 | Exportar PDF/Excel | 🟡 Excel em vários; ⬜ PDF genérico |
| 9 | Envio agendado por e-mail | ⬜ ⛔ provedor de e-mail |
| 9 | Backup e restauração, importação/exportação | ✅ |
| 9 | Dados de exemplo, temas claro/escuro | 🟡 |
| 10 | Marketplaces (Mercado Livre, Shopify, Nuvemshop) | ⬜ ⛔ contas de API |
| 10 | Correios, DANFE e cobrança por WhatsApp/e-mail | 🟡 WhatsApp por link; ⬜ Correios, e-mail |
| 10 | CNAB 240/400 | ⬜ ⛔ layout do banco escolhido |

## Plano das próximas etapas (ordem do prompt, ajustada ao que já existe)

| Etapa | Entrega | Tamanho |
|---|---|---|
| 2 — Núcleo e PDV | correção do CRT do MEI; `schema_migrations` com down; auditoria antes/depois; perfis customizáveis por ação (limite de desconto %); sangria/suprimento e fechamento por forma de pagamento; crédito parcelado; variações, kits e preço por tabela (atacado/varejo); clientes/fornecedores com IE, CEP e validação CNPJ/IE; transportadoras; assistente de primeira configuração; glossário | grande |
| 3 — Financeiro e compras | `settlements` (baixa parcial, juros, multa, desconto) e fim da exclusão física; contas múltiplas e transferências; conciliação CSV; cotação de compra; depósitos, transferência, bonificação e número de série | grande |
| 4 — Fiscal em homologação | naturezas de operação; `fiscal_documents`/`fiscal_events`/`fiscal_series` com idempotência e log; motor ligado à NFC-e; NF-e 55 e CC-e; tabelas de referência (NCM/CEST/CFOP); aviso de vencimento do certificado; rejeições em português; anexos II–V e fator R | muito grande · ⛔ certificado e credenciamento |
| 5 — Contabilidade e SPED | lançamentos gravados, manuais, diário, razão, balanço, fechamento de período; ECD; EFD ICMS/IPI e EFD-Contribuições (validar no PVA) | muito grande |
| 6 — Relatórios e integrações | PDF/agendamento por e-mail; manifestação do destinatário; boleto/CNAB; marketplaces; Correios | grande · ⛔ contas de API |
| 7 — Folha (opcional) | pró-labore, INSS, IRRF, FGTS com tabelas e vigência; referência eSocial | grande |

## O que preciso de você para as etapas com ⛔
- Certificado A1 de teste (ou da loja piloto) e credenciamento da loja na SEFAZ-PE para NF-e/NFC-e; CSC de homologação.
- Escolha de provedor para consulta CNPJ/CEP (há APIs gratuitas com limite) e para e-mail.
- Banco/gateway para boleto (CNAB 240 ou 400) e contas de marketplace, quando chegar a Etapa 6.
- Um contador para validar `ERP-FISCAL-RULES.md` e a exportação contábil.
