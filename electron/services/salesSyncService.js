const pdvRegistryService = require('./pdvRegistryService');
const syncStateService = require('./syncStateService');

/**
 * Envia um RESUMO da venda pro Firestore central do Arthur (não os
 * itens individuais, não dado de cliente) — só o suficiente pra um
 * relatório consolidado entre PDVs do mesmo grupo. Puramente aditivo:
 * nunca sincroniza estoque nem impede uma venda de acontecer se a
 * rede cair ou o grupo ainda não tiver sido configurado pelo painel.
 *
 * Diferente da primeira versão desse serviço, não precisa mais de
 * nenhuma configuração de Firebase por parte do cliente — usa a MESMA
 * conexão já usada pra licenciamento, e o grupo é atribuído
 * centralmente pelo Arthur em Central GerenciaAI → Sincronização.
 */
async function pushSale({ saleId, total, totalItens, finalizadaEm, operadorNome, locationNome }) {
  try {
    const grupoId = syncStateService.getGrupoSincronizacaoId();
    if (!grupoId) return; // essa instalação ainda não foi colocada em nenhum grupo — sem sincronização, silencioso

    const licenseService = require('./licenseService');
    const firestore = licenseService.getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();
    const { doc, setDoc } = require('firebase/firestore');

    const diaISO = (finalizadaEm || '').slice(0, 10);
    const ref = doc(firestore, 'grupos_sincronizacao', grupoId, 'vendas', saleId);
    await setDoc(ref, {
      installId, total, totalItens, operadorNome, locationNome, finalizadaEm, diaISO,
    });
  } catch (err) {
    // Best-effort de propósito — a venda já está gravada localmente, isso
    // é só um espelho pro relatório consolidado. Nunca deixa o erro subir.
    console.error('[salesSyncService] falha ao sincronizar venda (não afeta a venda local):', err.message);
  }
}

/**
 * Consolidado de vendas de todas as instalações do MESMO grupo de
 * sincronização, num período — vem do Firestore central, não do banco
 * local (que só tem as vendas desta instalação).
 */
async function getConsolidated({ dataInicio, dataFim }) {
  const grupoId = syncStateService.getGrupoSincronizacaoId();
  if (!grupoId) {
    return { ok: false, error: 'Esta instalação ainda não foi colocada em nenhum grupo de sincronização. Fale com o suporte.' };
  }

  const licenseService = require('./licenseService');
  const firestore = licenseService.getLicenseFirestore();
  const { collection, query, where, getDocs } = require('firebase/firestore');

  const vendasRef = collection(firestore, 'grupos_sincronizacao', grupoId, 'vendas');
  const q = query(vendasRef, where('diaISO', '>=', dataInicio), where('diaISO', '<=', dataFim));

  let snapshot;
  try {
    snapshot = await getDocs(q);
  } catch (err) {
    return { ok: false, error: `Falha ao consultar o servidor: ${err.message}` };
  }

  const vendas = snapshot.docs.map((d) => d.data());
  const porInstalacao = {};
  let totalGeral = 0;
  for (const v of vendas) {
    totalGeral += v.total || 0;
    const chave = v.locationNome || v.installId;
    if (!porInstalacao[chave]) porInstalacao[chave] = { nome: chave, totalVendas: 0, totalFaturado: 0 };
    porInstalacao[chave].totalVendas += 1;
    porInstalacao[chave].totalFaturado += v.total || 0;
  }

  return {
    ok: true,
    totalVendas: vendas.length,
    totalFaturado: totalGeral,
    porInstalacao: Object.values(porInstalacao).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
  };
}

module.exports = { pushSale, getConsolidated };
