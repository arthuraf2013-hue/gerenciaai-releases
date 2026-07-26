const pdvRegistryService = require('./pdvRegistryService');

/**
 * Envia um RESUMO da venda pro Firestore (não os itens individuais, não
 * dados de cliente) — só o suficiente pra um relatório consolidado entre
 * PDVs. Isso é puramente aditivo: nunca sincroniza estoque nem impede
 * uma venda de acontecer se a rede cair ou a sincronização não estiver
 * configurada. Deliberadamente não implementa sincronização de estoque
 * entre PDVs — isso exigiria um banco compartilhado de verdade ou
 * resolução de conflitos, um projeto bem mais arriscado que decidimos
 * não fazer agora.
 */
async function pushSale({ saleId, total, totalItens, finalizadaEm, operadorNome, locationNome }) {
  try {
    const cnpjLimpo = pdvRegistryService.getCnpjLimpo();
    if (!cnpjLimpo) return; // sem CNPJ configurado, sem sincronização — silencioso, é opcional

    const connection = await pdvRegistryService.getFirestoreConnection();
    const status = pdvRegistryService.getStatus();
    const { doc, setDoc } = require('firebase/firestore');

    const diaISO = (finalizadaEm || '').slice(0, 10);
    const ref = doc(connection.db, 'cnpjs', cnpjLimpo, 'vendas', saleId);
    await setDoc(ref, {
      numeroPdv: status.numeroPdv || 'sem-numero',
      total, totalItens, operadorNome, locationNome,
      finalizadaEm, diaISO,
    });
  } catch (err) {
    // Best-effort de propósito — a venda já está gravada localmente, isso
    // é só um espelho pro relatório consolidado. Nunca deixa o erro subir.
    console.error('[salesSyncService] falha ao sincronizar venda (não afeta a venda local):', err.message);
  }
}

/**
 * Consolidado de vendas de TODOS os PDVs do mesmo CNPJ, num período —
 * vem do Firebase, não do banco local (que só tem as vendas deste PDV).
 */
async function getConsolidated({ dataInicio, dataFim }) {
  const cnpjLimpo = pdvRegistryService.getCnpjLimpo();
  if (!cnpjLimpo) return { ok: false, error: 'Configure o CNPJ em Configurações → Fiscal antes de consolidar.' };

  let connection;
  try {
    connection = await pdvRegistryService.getFirestoreConnection();
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const { collection, query, where, getDocs } = require('firebase/firestore');
  const vendasRef = collection(connection.db, 'cnpjs', cnpjLimpo, 'vendas');
  const q = query(vendasRef, where('diaISO', '>=', dataInicio), where('diaISO', '<=', dataFim));

  let snapshot;
  try {
    snapshot = await getDocs(q);
  } catch (err) {
    return { ok: false, error: `Falha ao consultar o Firebase: ${err.message}` };
  }

  const vendas = snapshot.docs.map((d) => d.data());
  const porPdv = {};
  let totalGeral = 0;
  for (const v of vendas) {
    totalGeral += v.total || 0;
    if (!porPdv[v.numeroPdv]) porPdv[v.numeroPdv] = { numeroPdv: v.numeroPdv, totalVendas: 0, totalFaturado: 0 };
    porPdv[v.numeroPdv].totalVendas += 1;
    porPdv[v.numeroPdv].totalFaturado += v.total || 0;
  }

  return {
    ok: true,
    totalVendas: vendas.length,
    totalFaturado: totalGeral,
    porPdv: Object.values(porPdv).sort((a, b) => a.numeroPdv.localeCompare(b.numeroPdv)),
  };
}

module.exports = { pushSale, getConsolidated };
