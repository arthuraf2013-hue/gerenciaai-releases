/**
 * Regras tributárias que o próprio app semeia (origem 'sistema', ids fixos:
 * INSERT OR IGNORE, então desativar/versionar na loja não é desfeito na
 * próxima abertura). Só entra aqui o que vale para todo mundo e tem base
 * legal clara; alíquota de ICMS por UF/NCM NÃO é semeada (varia por estado e
 * produto) -- a loja/contador cadastra. Regra nova do sistema = id novo.
 * Sem dependência de database.js (é chamado por ele).
 */

const ICMS_SN = 'LC 123/2006: no Simples Nacional o ICMS é recolhido no DAS. CSOSN 102 = tributada pelo Simples sem permissão de crédito.';
const ICMS_SN_ST = 'CSOSN 500: ICMS cobrado anteriormente por substituição tributária (revenda de produto que veio com ST, CFOP 5405).';
const PIS_SN = 'No Simples Nacional PIS/COFINS são recolhidos no DAS. CST 07 é o que o emissor de NFC-e do app usa hoje; muitos contadores usam 49 ou 99: confirme e, se for o caso, cadastre uma regra da loja (ela vence a do sistema).';
const IBS_CBS_2026 = 'LC 214/2025, arts. 343, 346 e 348: alíquota de teste em 2026 (CBS 0,9% e IBS 0,1%), só informativa; recolhimento dispensado para quem cumpre as obrigações acessórias (art. 348, §1º). Simples e MEI fora (art. 348, III, c). CST e cClassTrib conforme a NT 2025.002-RTC: preencha com o contador.';

function base(id, campos) {
  return {
    id, grupo_id: id, versao: 1, origem: 'sistema',
    regime: null, uf_origem: null, uf_destino: null, ncm_prefixo: null, cfop: null, cst_csosn_item: null,
    natureza: null, perfil_cliente: null, cst: null, cclass_trib: null, aliquota: 0, reducao_base: 0, mva: 0,
    aliquota_interna_destino: null, recolhido_no_das: 0, informativo: 0, vigencia_fim: null,
    ...campos,
  };
}

const REGRAS_PADRAO = [];
for (const regime of ['simples_nacional', 'mei']) {
  const r = regime === 'mei' ? 'MEI' : 'Simples';
  REGRAS_PADRAO.push(
    base(`sis-icms-${regime}-102`, { nome: `ICMS ${r}: sem ST`, tributo: 'ICMS', regime, cst: '102', recolhido_no_das: 1, fundamento: ICMS_SN, vigencia_inicio: '2007-07-01' }),
    base(`sis-icms-${regime}-500`, { nome: `ICMS ${r}: revenda com ST`, tributo: 'ICMS', regime, cfop: '5405', cst: '500', recolhido_no_das: 1, fundamento: ICMS_SN_ST, vigencia_inicio: '2007-07-01' }),
    base(`sis-pis-${regime}`, { nome: `PIS ${r}`, tributo: 'PIS', regime, cst: '07', recolhido_no_das: 1, fundamento: PIS_SN, vigencia_inicio: '2007-07-01' }),
    base(`sis-cofins-${regime}`, { nome: `COFINS ${r}`, tributo: 'COFINS', regime, cst: '07', recolhido_no_das: 1, fundamento: PIS_SN, vigencia_inicio: '2007-07-01' }),
  );
}
for (const regime of ['lucro_presumido', 'lucro_real']) {
  const r = regime === 'lucro_real' ? 'Lucro Real' : 'Lucro Presumido';
  REGRAS_PADRAO.push(
    base(`sis-cbs-teste-2026-${regime}`, { nome: `CBS 2026 (teste) — ${r}`, tributo: 'CBS', regime, aliquota: 0.9, informativo: 1, fundamento: IBS_CBS_2026, vigencia_inicio: '2026-01-01', vigencia_fim: '2026-12-31' }),
    base(`sis-ibs-teste-2026-${regime}`, { nome: `IBS 2026 (teste) — ${r}`, tributo: 'IBS', regime, aliquota: 0.1, informativo: 1, fundamento: IBS_CBS_2026, vigencia_inicio: '2026-01-01', vigencia_fim: '2026-12-31' }),
  );
}

const COLUNAS = Object.keys(REGRAS_PADRAO[0]).concat(['nome', 'tributo', 'fundamento', 'vigencia_inicio']).filter((c, i, a) => a.indexOf(c) === i);

function garantirRegrasTributariasPadrao(database) {
  const ins = database.prepare(`INSERT OR IGNORE INTO tax_rules (${COLUNAS.join(', ')}) VALUES (${COLUNAS.map((c) => `@${c}`).join(', ')})`);
  database.transaction(() => { for (const r of REGRAS_PADRAO) ins.run(r); })();
}

module.exports = { REGRAS_PADRAO, garantirRegrasTributariasPadrao };
