# GerenciaAI ERP: arquitetura

Estado: 31/10/2026. Documento curto e vivo: o que existe, para onde vai e por quê.
Detalhe de cada módulo em `ERP-FISCAL.md`, `ERP-INTEGRATIONS.md` e `ERP-TESTS.md`.
Fases e status estão em `ERP-ROADMAP.md`.

## 1. Diagnóstico (auditoria do código)

| Item | Hoje |
|---|---|
| Stack | Electron + Vite + React; SQLite local (better-sqlite3 v13, N-API); Firebase só para licença, celular e sincronização |
| Tamanho | 101 arquivos em `electron/services`, 97 tabelas, ~410 canais IPC, 81 arquivos de teste (`node --test`) |
| Camadas | renderer → `preload.js` (contextBridge) → `ipc/handlers.js` (`safeHandle` + política de acesso) → serviço → SQLite |
| Acesso | sessão real por janela (`sessionService`), papel por canal (`PAPEL_POR_CANAL`), operador sempre trocado pelo da sessão, Auditoria (`audit_log`) |
| Licença | módulos pagos por cliente na Central (`modulosPagosService`), offline-first |
| Unidades | uma instalação = um CNPJ/loja; várias máquinas da mesma loja = grupo multi-PDV (estoque por variações, vendas espelhadas) |
| Estoque | livro (`stock_movements`), lotes/validade, custo médio, inventário com foto do estoque |
| Fiscal | NFC-e 65 com assinatura A1, contingência offline, cancelamento, inutilização; entrada de NF-e 55 por XML |
| Celular | PWA (garçom, consulta, PDV móvel) e app Android autônomo |

**O que reaproveitar (e foi reaproveitado):** ledger de estoque, `expenses` como contas a pagar,
`customer_credit_movements` (fiado) como contas a receber de cliente, `audit_log`,
`safeHandle`, módulos pagos, `xlsxHelpers`, `nfeXmlParser`, a janela de impressão sem JavaScript.

**Gargalos e riscos encontrados**

1. *Tributação dentro do gerador de XML.* `nfceXmlService` decide CSOSN/CST e PIS/COFINS
   (CST 07 fixo; CST 00 sem base, com comentário "REVISAR"). Serve para Simples/MEI;
   **não serve para regime normal nem para IBS/CBS**. Solução: motor tributário central
   (feito, ver `ERP-FISCAL.md`). A ligação com a emissão fica para depois da homologação.
2. *`locationId` vem do renderer.* Com uma empresa por banco, não vaza dado de outra empresa.
   Vira risco se um dia o mesmo SQLite tiver vários CNPJs. Regra do plano: nessa hora o
   processo principal deriva a unidade da sessão e ignora o payload, como já faz com `operadorId`.
3. *Duas formas de checar papel* (`PAPEL_POR_CANAL` e `guardRole` dentro do handler).
   Funciona, mas canal novo deve preferir a lista (tem teste que confere).
4. *DRE e fluxo de caixa calculados na hora* sobre vendas e pagamentos. Os índices existem
   (`sales(location_id, status, finalizada_em)`, `expenses(data_*)`). Para loja grande, a
   próxima etapa é um resumo diário materializado.
5. *Emissão fiscal nunca homologada com certificado real.* Mesmo aviso já está na tela de
   Configurações. Nada do ERP muda isso: emissão real só depois de testes em homologação.

## 2. Arquitetura proposta

Monólito modular no mesmo processo, sem microsserviços. Cada módulo do ERP é um conjunto de
serviços com **API interna** (funções exportadas), canais IPC com prefixo próprio, tabelas
próprias e um módulo pago. A integração entre módulos é por **leitura das tabelas de origem**
(venda, pagamento, movimento) ou por **chamada de serviço dentro da mesma transação**, nunca
por cópia de dados que possa divergir.

```
renderer (React)
   │ window.pdv.<area>.<ação>()
preload.js ── só expõe canais
   │
ipc/handlers.js ── safeHandle → sessão → papel → permissão fina → módulo pago
   │
serviços de domínio ─────────────────────────────────────────────────────────
  núcleo: venda, caixa, produto, estoque, cliente, fornecedor, usuários
  ERP:    compras · financeiro · inventário · motor tributário · assistente fiscal
  fiscal: nfce* (emissão), nfeEntrada (XML de compra)
   │
SQLite (schema.sql + migrateColumnsIfNeeded + garantirGatilhosErp)
```

### Decisões

| # | Decisão | Por quê |
|---|---|---|
| D1 | Uma instalação = uma empresa (CNPJ). Filiais = instalações no mesmo grupo | Isola dados por banco, sem `WHERE empresa_id` espalhado nem risco de vazar por parâmetro. A consolidação entre unidades vai para o BI pela nuvem (vendas do grupo já sobem) |
| D2 | Permissão fina = retirar áreas do ERP de um gerente, por prefixo de canal | Compatível com tudo que existe: sem linha, nada muda. Admin/suporte nunca ficam restritos. Canal novo de uma área já nasce coberto |
| D3 | Motor tributário com regras versionadas por vigência, no banco | A reforma muda alíquota por ano. Regra nova não apaga a antiga (auditoria e reprocessamento) |
| D4 | Nenhuma alíquota de ICMS semeada | Varia por UF, NCM e benefício. Inventar é pior que deixar vazio e avisar |
| D5 | Valores em reais (REAL), arredondados no resultado | Mesmo padrão do banco inteiro; trocar para centavos agora quebraria tudo |
| D6 | Estimativa fiscal sempre rotulada | DAS, limite e motor ajudam o lojista e o contador, não substituem a apuração |

## 3. Módulos

| Módulo | Situação | Onde |
|---|---|---|
| Compras (pedido, NF-e por XML, custo médio) | pronto | `purchaseOrderService`, `nfeEntradaService`, `custoMedioService` |
| Financeiro (receber, recorrentes, fluxo, DRE) | pronto | `financeiroService` |
| Estoque avançado (inventário, kardex) | pronto | `inventarioService` |
| Assistente fiscal (limites, DAS, calendário, cadastro, pacote do contador) | pronto | `assistenteFiscalService`, `tabelasFiscais` |
| Motor tributário | pronto (simulação e conferência) | `motorTributarioService`, `regrasTributariasPadrao` |
| Permissões finas | pronto | `permissaoService` |
| Conciliação bancária (OFX), centros de custo, inadimplência | pronto | `conciliacaoService`, `centroCustoService`, `cobrancaService` |
| NF-e 55 de saída, NFS-e, SPED | a fazer, depende de homologação | Fases 4b e 5 |
| Contabilidade: lançamentos gerenciais, balancete, de-para | pronto (exportação) | `contabilService` |
| Comercial: comissões e metas | pronto; CRM, orçamento e fidelidade já existiam | `comissaoService` |
| Equipe (RH): cadastro, documentos, férias | pronto; folha só por integração | `rhService` |
| Painel executivo e alertas | pronto; IA em linguagem natural a fazer | `biService` |

## 4. Dependências entre módulos

```
produto/estoque ──► compras ──► financeiro (contas a pagar)
       │                │
       ▼                ▼
     venda ──► pagamento ──► financeiro (receber, fluxo, DRE)
       │
       ├──► motor tributário ──► (futuro) emissão NFC-e/NF-e ──► pacote do contador / SPED
       └──► sale_items.custo_unitario ──► DRE (CMV)
permissões ─ valem para todos ─ módulos pagos
```

## 5. Estratégia de integração e migração

* **Banco:** só `CREATE TABLE IF NOT EXISTS` para tabela nova; coluna nova em tabela antiga
  vai em `migrateColumnsIfNeeded` (regra do `CLAUDE.md`). Gatilhos e seeds idempotentes em
  `garantirGatilhosErp`, que roda a cada abertura e nos testes.
* **Dados antigos:** nada é reescrito. Venda antiga sem custo usa o custo atual e o DRE marca
  como estimado; instalação sem regra cadastrada recebe as regras do sistema.
* **Ativação:** por módulo pago na Central (`erpCompras`, `erpFinanceiro`, `erpEstoque`,
  `erpFiscal`). Máquina que nunca sincronizou continua com acesso (offline-first).
* **Rollback:** desligar o módulo na Central esconde as telas sem perder dado.
