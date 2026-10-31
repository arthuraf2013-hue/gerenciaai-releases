# GerenciaAI ERP: roadmap

Legenda: ✅ pronto e testado · 🟡 parcial · ⬜ a fazer · ⛔ bloqueado por fator externo.
"Pronto" = implementado, ligado à tela, com validação, permissão, tratamento de erro e
teste automatizado (critério do pedido original). Nada aqui foi testado com dado real de loja.

## Fase 1: auditoria e arquitetura ✅
- Diagnóstico e decisões em `ERP-ARCHITECTURE.md`.
- Já existia: custo médio, pedido de compra, entrada por XML da NF-e (commit `aeab4f7`).

## Fase 2: fundação 🟡
- ✅ Permissões finas por usuário nas áreas do ERP (`permissaoService`, Usuários → Permissões do ERP).
- ✅ Módulos pagos por área (Central).
- ✅ Auditoria de toda mudança de regra, permissão, inventário e configuração.
- ⬜ Multiempresa no mesmo banco: **não será feito** (decisão D1). Filiais = instalações no grupo.
- ⬜ Tela de consolidação entre unidades: depende do BI (Fase 7).

## Fase 3: financeiro, compras, estoque e comercial 🟡
- ✅ Contas a pagar (já existiam) e a receber, cartão a cair com taxa e prazo, fiado.
- ✅ Contas recorrentes e parceladas, fluxo de caixa realizado e previsto, DRE gerencial mensal.
- ✅ Inventário (cego, leitor, categoria), kardex, histórico de custo.
- ⬜ 3b: plano de contas gerencial e centros de custo (hoje: categorias fixas de despesa).
- ⬜ 3b: conciliação bancária por OFX (arquivo do banco, sem credencial).
- ⬜ 3b: inadimplência (aging do fiado e das contas a receber) e alerta.
- ⬜ 3c: comissão por vendedor, metas, política de desconto por papel.
- ⬜ 3c: transferência entre unidades (precisa do grupo multi-PDV) e curva ABC.

## Cadastro automático (produto e imposto) ✅
- Produtos novos direto da NF-e de compra: nome limpo, EAN da unidade, conversão da caixa, custo,
  preço pela margem com arredondamento, categoria e fiscal aprendidos da loja/fornecedor.
- Reajuste de preço sugerido depois da entrada (quem ficou abaixo da margem padrão).
- Confirmação da nota completa NCM, CEST, CFOP e CSOSN vazios.
- Formulário de produto: NCM digitado preenche CFOP/CSOSN/CEST/categoria pelo que a loja usa.
- Assistente: correção em massa também pelo "mesmo NCM na loja"; NCM pela IA com conferência.
- Motor × cadastro: aplica o CST/CSOSN das regras sem atropelar escolha válida da loja.

## Fase 4: motor fiscal e documentos 🟡
- ✅ Motor tributário versionado (`motorTributarioService`), simulador e conferência do cadastro.
- ✅ Regras do sistema: Simples/MEI (CSOSN 102/500, PIS/COFINS no DAS) e IBS/CBS de teste em 2026.
- ✅ Assistente fiscal: limites, DAS, calendário, correção do cadastro, relatório do MEI, pacote do contador.
- ✅ Já existia: NFC-e 65 (emissão, contingência, cancelamento, inutilização) e XML de entrada.
- ⛔ Ligar o motor à emissão da NFC-e: exige homologação com certificado e CSC reais.
- ⬜ Grupos IBS/CBS no XML (NT 2025.002-RTC): Simples obrigatório a partir de 2027 (confirmar data no Portal da NF-e).
- ⛔ NF-e 55 de saída, manifestação do destinatário, NFS-e (padrão nacional): certificado e homologação.
- ⬜ DIFAL e FCP interestadual no motor.
- CT-e e MDF-e: fora do público atual (pequeno comércio sem frota própria emitindo CT-e).

## Fase 5: contabilidade e obrigações ⬜
- Exportação contábil (lançamentos em partidas dobradas a partir de vendas, compras e despesas,
  em layout que o escritório importa). Escrituração oficial continua com o contador.
- SPED Fiscal / EFD-Contribuições: só para regime normal; depende da emissão estar homologada.

## Fase 6: RH e operação ⬜
- Cadastro de colaboradores, cargos, documentos e férias (sem cálculo trabalhista; folha por integração).
- Ordem de serviço genérica e checklist (hoje há agenda, ótica e materiais por serviço).

## Fase 7: BI, automação e IA 🟡
- Existe: dashboard, relatório de lucro por produto, resumo de vendas por IA, tutor.
- ⬜ Painel executivo único (faturamento, margem, caixa, estoque parado, clientes rentáveis).
- ⬜ Alertas: despesa fora do padrão, inadimplência, inconsistência fiscal (base já existe no assistente).
- ⬜ Perguntas em linguagem natural respondidas por serviços autorizados (respeitando permissão).

## Fase 8: testes integrados e homologação 🟡
- ✅ Testes por serviço e pela política de IPC (ver `ERP-TESTS.md`).
- ⛔ Homologação SEFAZ, teste com dados reais de loja piloto.
