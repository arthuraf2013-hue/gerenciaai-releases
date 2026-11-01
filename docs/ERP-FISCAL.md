# GerenciaAI ERP: fiscal e tributário

> Nada aqui substitui o contador. Estimativa e simulação vêm sempre rotuladas.

## O que existe

| Recurso | Situação |
|---|---|
| NFC-e 65: emissão, assinatura A1, QR Code, contingência offline, cancelamento, inutilização, XML em disco | implementado, **não homologado com certificado real** |
| NF-e 55 de entrada: leitura do XML, conferência, lançamento | implementado e testado com XML montado |
| Assistente fiscal: limite MEI/Simples, DAS estimado, calendário, relatório do MEI, pacote do contador | implementado |
| Cadastro fiscal: diagnóstico e correção em massa a partir das notas de compra | implementado |
| Motor tributário | implementado (simulação e conferência); ainda não alimenta a emissão |

## Motor tributário (`motorTributarioService.js`)

**Regra** (`tax_rules`): critérios opcionais (regime, UF de origem e de destino, prefixo de NCM,
CFOP, CST/CSOSN do produto, natureza da operação, perfil do cliente) e resultado (CST/CSOSN,
cClassTrib, alíquota, redução de base, MVA, alíquota interna do destino, "recolhido no DAS",
"informativo"), com vigência de início e fim.

**Escolha da regra, por tributo:** vale a ativa e vigente na data cujos critérios batem.
Ganha a mais específica (pesos: regime 32, CFOP 16, CST/CSOSN 8, UF destino 4, UF origem 2,
natureza 2, perfil 2, NCM 2 por dígito). No empate: regra da loja antes da do sistema → vigência
mais recente → versão maior → id. A resposta traz a regra usada, a versão e se houve empate.

**Versionamento:** regra não é editada. "Nova versão" encerra a vigente na véspera do início da
nova; o histórico fica e cada data é calculada com a versão daquela data. Desativar não apaga.

**Cálculo:** base = quantidade × preço − desconto + outras; base reduzida pela redução;
valor = base × alíquota. ICMS-ST = (base + IPI) × (1 + MVA) × alíquota interna − ICMS próprio.
Regra "recolhido no DAS" zera o valor do item (o imposto sai na guia).

**DIFAL** (venda interestadual a consumidor não contribuinte, regime regular): usa a regra de ICMS
interestadual com a alíquota interna do destino. Base única: V × (interna − interestadual). Base
dupla: BC = (V − ICMS origem) / (1 − interna); DIFAL = BC × interna − ICMS origem. A base vem da regra
(`difal_base`); sem informar, calcula em base única e avisa. Simples/MEI não recolhem na venda
(cláusula nona do Conv. 93/2015 suspensa, ADI 5464).

**Ainda não calcula:** FCP sobre base dupla, IPI por pauta, benefícios específicos por UF.

### Regras semeadas pelo sistema (`regrasTributariasPadrao.js`)

| Regra | Base |
|---|---|
| Simples/MEI, ICMS CSOSN 102, no DAS | LC 123/2006 |
| Simples/MEI, CFOP 5405 → CSOSN 500 | ICMS cobrado anteriormente por ST |
| Simples/MEI, PIS/COFINS CST 07, no DAS | igual ao emissor atual. Muitos contadores usam 49/99: a loja pode sobrepor |
| Lucro Presumido/Real, CBS 0,9% e IBS 0,1%, só em 2026, informativos | LC 214/2025, arts. 343, 346 e 348 (recolhimento dispensado com obrigações acessórias cumpridas; Simples fora, art. 348, III, c) |

Nenhuma alíquota de ICMS por UF é semeada (decisão D4).

## Cadastro automático do imposto

Ordem de confiança usada em todo preenchimento automático (nunca troca valor válido):
1. **Nota de compra do produto**: NCM e CEST do fornecedor; no Simples/MEI, CFOP de compra com
   ST (5401/5403/5405/6401/6403/6404) vira revenda 5405 + CSOSN 500, senão 5102 + 102.
2. **A própria loja**: CFOP + CST/CSOSN (+ CEST) mais usados nos produtos com o mesmo NCM e
   cadastro sem problema. Não passa por cima de um CFOP válido diferente.
3. **Regras do motor**: corrigem CST/CSOSN vazio ou incoerente; regra da loja vale sempre.
4. **Padrão do Simples** (5102/102): só com confirmação explícita.
5. **IA** (Gemini, chave da loja): só sugere NCM, validado (8 dígitos) e conferido pela pessoa.

Onde acontece: cadastro dos produtos da nota, confirmação da nota, formulário de produto (ao
sair do campo NCM), Fiscal → Cadastro fiscal e Fiscal → Regras tributárias.

## Reforma tributária: o que o app já prevê

- IBS/CBS/IS são tributos do motor; cClassTrib tem campo próprio (6 dígitos).
- 2026: teste informativo no regime regular (regra do sistema).
- Grupos IBS/CBS no XML (NT 2025.002-RTC): obrigatórios no regime regular desde 03/08/2026;
  para Simples/MEI a data divulgada é 04/01/2027. **Confirmar no Portal Nacional da NF-e
  antes de implementar**; implementação depende da emissão homologada.
- Alíquotas de 2027 em diante: cadastrar como nova versão quando publicadas (o motor avisa
  "sem regra" para CBS/IBS no regime regular a partir de 2027).

## Bloqueios

| Bloqueio | O que destrava |
|---|---|
| Certificado A1 e CSC reais | testes em homologação da SEFAZ da UF da loja piloto |
| NFS-e | adesão do município ao padrão nacional + certificado |
| SPED / EFD-Contribuições | emissão homologada e cliente em regime normal |

## Fontes

- LC 214/2025 (IBS/CBS), arts. 343, 346, 348.
- LC 123/2006 (Simples Nacional), Anexo I e limites.
- Portal Nacional da NF-e: NT 2025.002-RTC.
- Tabela do Anexo I e DAS-MEI 2026: ver `tabelasFiscais.js` (fontes no README, entrada "ERP, Fases 2 a 4").
