# GerenciaAI ERP: documento de regras fiscais (Etapa 1)

Estado: 01/11/2026. **Antes de uso real, cada regra aqui precisa ser conferida pelo contador e a
emissão testada em homologação da SEFAZ/Receita.** Valores e tabelas mudam: no sistema eles moram
em tabelas com vigência e fonte (`tax_rules`, `natureza_operacao`, tabelas de referência), nunca no código.

Legenda de status: ✅ implementado e testado · 🟡 estrutura pronta, falta dado/integração · ⬜ a fazer.

## 1. Regime tributário → como a nota é preenchida

| Regime | CRT na NF-e | ICMS no item | PIS/COFINS no item | Onde o imposto é pago |
|---|---|---|---|---|
| MEI | 4 (NT 2024.001, obrigatório desde abril/2025) | CSOSN (102, 500...) | CST 49/99 ou 07 (decisão do contador) | DAS-MEI fixo mensal |
| Simples Nacional | 1 (2 = excesso de sublimite) | CSOSN | CST 49/99 ou 07 | DAS (PGDAS-D), pela receita |
| Lucro Presumido | 3 | CST + alíquota da UF | CST 01 (cumulativo 0,65% / 3%) | guias próprias (DARF, ICMS estadual) |
| Lucro Real | 3 | CST + alíquota da UF | CST 01 (não cumulativo 1,65% / 7,6%, com créditos) | idem |

Status: ✅ regras de MEI/Simples semeadas no motor; ⬜ alíquotas de Presumido/Real são cadastradas pela loja (o motor avisa quando falta).

**Erro corrigido (01/11/2026):** o emissor (`nfceXmlService.crtDoRegime`) mandava CRT 1 também para MEI, rejeitado pela SEFAZ desde abril/2025. Agora MEI sai com CRT 4 (teste em `rejeicoesSefaz.test.js`).

## 2. Natureza da operação → CFOP

Primeiro dígito: 1 = entrada no estado, 2 = entrada de outro estado, 5 = saída no estado, 6 = saída para outro estado, 7 = exterior.
A tabela `natureza_operacao` (✅) guarda o par dentro/fora do estado; o sistema troca automaticamente pela UF do destinatário.

| Operação | Sem ST (dentro / fora) | Mercadoria com ST já retida (dentro / fora) |
|---|---|---|
| Venda de mercadoria comprada de terceiros | 5102 / 6102 | 5405 / 6404 |
| Venda de produção própria | 5101 / 6101 | 5401 / 6401 |
| Venda a consumidor final não contribuinte (outra UF) | — / 6108 | — |
| Devolução de compra (sai para o fornecedor) | 5202 / 6202 | 5411 / 6411 |
| Devolução de venda (entra do cliente) | 1202 / 2202 | 1411 / 2411 |
| Transferência entre filiais | 5152 / 6152 | 5409 / 6409 |
| Remessa para conserto | 5915 / 6915 | — |
| Retorno de conserto (entra) | 1916 / 2916 | — |
| Bonificação, doação ou brinde | 5910 / 6910 | — |
| Compra para revenda (entrada) | 1102 / 2102 | 1403 / 2403 |
| Outra saída não especificada | 5949 / 6949 | — |

Fonte: tabela CFOP (Convênio s/nº de 1970 e Ajustes SINIEF). Conferir cada operação com o contador.
Status: ✅ CFOP de compra com ST → revenda 5405/CSOSN 500 (assistente e cadastro automático); ✅ tabela `natureza_operacao` (migração 1) e `naturezaOperacaoService.cfopPara` (Fiscal → Regras tributárias).

## 3. CSOSN (Simples Nacional e MEI)

| CSOSN | Quando usar |
|---|---|
| 101 | Tributada com permissão de crédito (venda a contribuinte que aproveita crédito) |
| 102 | Tributada sem permissão de crédito (o mais comum no varejo) |
| 103 | Isenção do ICMS no Simples para faixa de receita |
| 201 / 202 / 203 | Com cobrança de ICMS por ST (quem retém é a loja) |
| 300 | Imune |
| 400 | Não tributada |
| 500 | ICMS cobrado anteriormente por ST (revenda de produto com ST já retida) |
| 900 | Outros |

## 4. CST do ICMS (regime normal)

00 tributada integralmente · 10 tributada com ST · 20 com redução de base · 30 isenta/não tributada com ST ·
40 isenta · 41 não tributada · 50 suspensão · 51 diferimento · 60 cobrado anteriormente por ST ·
70 redução de base com ST · 90 outros. (Combustíveis monofásicos: 02, 15, 53, 61.)
O primeiro dígito do CST completo é a **origem** da mercadoria (0 nacional, 1 e 2 estrangeira...), que já está no cadastro do produto.

## 5. Cálculos

| Tributo | Fórmula | Status |
|---|---|---|
| ICMS próprio | base = valor − desconto + frete/outras; base × (1 − redução); × alíquota | ✅ motor |
| ICMS-ST | base ST = (valor + IPI) × (1 + MVA) × (1 − redução); ST = base ST × alíquota interna destino − ICMS próprio | ✅ motor |
| MVA ajustada (interestadual) | [(1 + MVA original) × (1 − alíq. interestadual) / (1 − alíq. interna)] − 1 | ⬜ (hoje a MVA é informada já ajustada) |
| FCP | base × % FCP da UF | ✅ (base única) |
| DIFAL (não contribuinte, regime normal) | única: V × (interna − interestadual); dupla: BC = (V − ICMS origem)/(1 − interna), DIFAL = BC × interna − ICMS origem | ✅ motor |
| IPI | base × alíquota TIPI (quando a loja é industrial/equiparada) | 🟡 motor aceita a regra |
| PIS/COFINS cumulativo (Presumido) | receita × 0,65% / 3% | 🟡 regra cadastrável |
| PIS/COFINS não cumulativo (Real) | receita × 1,65% / 7,6% − créditos | ⬜ créditos não implementados |
| ISS (serviços) | serviço × alíquota do município (2% a 5%), código LC 116 | ⬜ |
| IRPJ/CSLL (Presumido, comércio) | presunção 8% (IRPJ) e 12% (CSLL) da receita; IRPJ 15% + adicional 10% sobre o que passar de R$ 20 mil/mês; CSLL 9% | ⬜ apuração |
| Simples Nacional | alíquota efetiva = (RBT12 × nominal − dedução) / RBT12 | ✅ anexos I a V e fator R (V → III com folha ≥ 28%), em Fiscal → Ajustes |

Simples Nacional, anexos (LC 123/2006 com redação da LC 155/2016; **conferir antes de usar**):

| Faixa (RBT12 até) | Anexo I comércio | Anexo II indústria | Anexo III serviços | Anexo IV serviços | Anexo V serviços |
|---|---|---|---|---|---|
| 180 mil | 4% / 0 | 4,5% / 0 | 6% / 0 | 4,5% / 0 | 15,5% / 0 |
| 360 mil | 7,3% / 5.940 | 7,8% / 5.940 | 11,2% / 9.360 | 9% / 8.100 | 18% / 4.500 |
| 720 mil | 9,5% / 13.860 | 10% / 13.860 | 13,5% / 17.640 | 10,2% / 12.420 | 19,5% / 9.900 |
| 1,8 mi | 10,7% / 22.500 | 11,2% / 22.500 | 16% / 35.640 | 14% / 39.780 | 20,5% / 17.100 |
| 3,6 mi | 14,3% / 87.300 | 14,7% / 85.500 | 21% / 125.640 | 22% / 183.780 | 23% / 62.100 |
| 4,8 mi | 19% / 378.000 | 30% / 720.000 | 33% / 648.000 | 33% / 828.000 | 30,5% / 540.000 |

Fator R: folha dos 12 meses ÷ RBT12 ≥ 28% leva atividades do Anexo V para o Anexo III.
Limites: MEI R$ 81 mil/ano (proporcional no ano de abertura); Simples R$ 4,8 mi; sublimite de ICMS/ISS R$ 3,6 mi.

## 6. Reforma tributária (IBS, CBS e Imposto Seletivo — EC 132/2023 e LC 214/2025)

| Ano | O que muda | No sistema |
|---|---|---|
| 2026 | teste: CBS 0,9% e IBS 0,1% destacados, só informativos no regime regular; Simples fora | ✅ regra semeada (informativa) |
| 2027 | CBS cheia; PIS/COFINS extintos; IPI zerado (exceto ZFM); Imposto Seletivo começa; IBS ainda simbólico | 🟡 nova versão das regras quando as alíquotas forem publicadas |
| 2029 a 2032 | ICMS e ISS caem gradualmente; IBS sobe na mesma proporção | 🟡 regras por vigência já suportam |
| 2033 | só IBS/CBS/IS | 🟡 |

O motor guarda CST e cClassTrib (6 dígitos) por regra; os grupos IBS/CBS no XML seguem a NT 2025.002-RTC
(obrigatórios no regime regular desde 03/08/2026; para Simples/MEI a data divulgada é 04/01/2027 — **confirmar no Portal Nacional da NF-e**).

## 7. Documentos e eventos

| Documento / evento | Regra | Status |
|---|---|---|
| NFC-e (65) | consumidor final presencial; QR Code com CSC; contingência offline (tpEmis 9) e reenvio | 🟡 implementada, não homologada |
| NF-e (55) | venda a empresa, devolução, transferência, remessa; destinatário com IE/indicador | ⬜ |
| NFS-e | padrão nacional (ou do município), código LC 116 e CNAE | ⬜ |
| Cancelamento | só dentro do prazo da SEFAZ (configurável por UF/modelo), com justificativa ≥ 15 caracteres | 🟡 NFC-e |
| Carta de correção (CC-e) | só NF-e; não pode mudar valores, impostos, destinatário, data, quantidade; sequência por nota | ⬜ |
| Inutilização | faixa de números não usados, por série e ano, com justificativa | 🟡 NFC-e |
| Manifestação do destinatário | ciência (210210), confirmação (210200), desconhecimento (210220), operação não realizada (210240) | ⬜ |
| Guarda | XML autorizado + eventos por 5 anos, com backup | 🟡 XML salvo; ⬜ política de retenção/backup |
| Numeração | série + número reservados em transação; número pulado vira inutilização | ⬜ `fiscal_series` |
| Idempotência | cada envio grava uma chave antes; reenvio consulta a SEFAZ pela chave antes de transmitir de novo | ⬜ |

## 8. Apuração, guias e arquivos

| Obrigação | Quem | Status |
|---|---|---|
| DAS (PGDAS-D) | Simples | ✅ estimativa + calendário; transmissão é no portal do Simples |
| DAS-MEI e DASN-SIMEI | MEI | ✅ valor do ano, relatório mensal, calendário |
| DARF (PIS, COFINS, IRPJ, CSLL) | Presumido/Real | ⬜ apuração |
| GNRE / guia estadual | ST e DIFAL interestadual | ⬜ |
| EFD ICMS/IPI (SPED Fiscal) | regime normal (Simples em regra dispensado) | ⬜ |
| EFD-Contribuições | Presumido/Real | ⬜ |
| ECD (SPED Contábil) | quem tem escrituração obrigatória | ⬜ (precisa de lançamentos gravados e plano referencial) |

Os arquivos SPED precisam passar no validador oficial (PVA) antes de serem considerados prontos.

## 9. Validações em tempo real

| Campo | Regra | Status |
|---|---|---|
| CPF / CNPJ | dígitos verificadores | ✅ CPF (equipe); ⬜ CNPJ e uso geral nos cadastros |
| IE | algoritmo de cada UF + "ISENTO" | ⬜ (tabela por UF) |
| NCM | 8 dígitos e existente na tabela vigente | 🟡 formato; ⬜ tabela |
| CEST | 7 dígitos e compatível com o NCM (Convênio 142/2018) | 🟡 formato |
| CFOP | 4 dígitos; primeiro dígito compatível com entrada/saída e destino | ✅ motor e naturezas; ⬜ na emissão |
| CSOSN/CST | compatível com o regime e com o CFOP (5405 ↔ 500) | ✅ assistente |

## 10. Certificado digital

A1 (.pfx): importado pelo diálogo do processo principal, senha cifrada (`safeStorage`), validade conferida
(✅ aviso a partir de 30 dias antes no painel fiscal e no painel executivo). A3 (token/cartão): opcional, depende de driver PKCS#11 no Windows — ⬜.

## 11. O que o contador precisa fazer
1. Confirmar o regime, o CRT e o CST de PIS/COFINS usado no Simples (07, 49 ou 99).
2. Conferir/cadastrar as regras de ICMS por UF e NCM (alíquota, redução, ST, MVA, FCP, base do DIFAL).
3. Validar a tabela de naturezas de operação e CFOP.
4. Conferir o plano de contas (de-para) e os lançamentos gerenciais exportados.
5. Acompanhar a homologação: primeira nota de teste, cancelamento, inutilização e contingência.
6. Informar o anexo do Simples (e a folha de 12 meses, se Anexo V) em Fiscal → Ajustes.
7. Fechar os meses na contabilidade depois de conferidos (Financeiro → Contabilidade → Fechar mês) e lançar os ajustes manuais (capital, empréstimos, imobilizado).
6. A cada ano: tabelas do Simples/MEI, salário mínimo, alíquotas da reforma.
