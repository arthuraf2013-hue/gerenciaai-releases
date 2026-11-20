// "Procurar e sincronizar" (Configurações -> Sincronização -> Rede local da loja,
// no caixa): acha o servidor na rede -- anúncio na nuvem, pergunta por UDP e,
// sem resposta, varredura de cada endereço da rede (lanClienteService.varrerRede)
// -- e, com o caixa já ligado, reconecta e puxa/manda tudo de novo.

const cliente = () => require('./lanClienteService');
const transporte = () => require('./grupoTransporteService');

async function passo(nome, fn) {
  try {
    const r = await fn();
    return { passo: nome, ok: r?.ok !== false, detalhe: r?.error || null };
  } catch (err) {
    return { passo: nome, ok: false, detalhe: err?.message || String(err) };
  }
}

/** Reavalia o modo e sincroniza tudo pelo transporte que ficou valendo. */
async function sincronizarAgora() {
  await transporte().reavaliar();
  const passos = [
    await passo('Cadastros (produtos, clientes, fiado)', () => require('./grupoReplicaService').sincronizarTudo()),
    await passo('Usuários', () => require('./userSyncService').sincronizarTudo()),
    await passo('Vendas para o relatório do grupo', async () => ({ ok: await require('./salesSyncService').pushTodoOHistorico({ apenasPendentes: true }) !== false })),
    await passo('Estoque', () => require('./stockSyncService').enviarVariacoesPendentes()),
  ];
  try { require('./estoqueServidorService').invalidar(); } catch { /* sem cache */ }
  try { require('./mesaCompartilhadaService').processarFila?.(); } catch { /* sem fila */ }
  const grupoId = require('./syncStateService').getGrupoSincronizacaoId();
  if (grupoId) passos.push(await passo('Fotos', () => require('./grupoReplicaService').trabalharFotos(grupoId)));
  return { modo: transporte().modoAtual(), passos };
}

async function procurarESincronizar() {
  const sync = require('./syncStateService');
  const grupoId = sync.getGrupoSincronizacaoId();
  if (!grupoId) return { ok: false, error: 'Este computador não está em um grupo de sincronização.' };
  if (sync.ehServidorDoGrupo()) return { ok: false, error: 'Este computador é o servidor: os caixas é que procuram por ele.' };
  const cfg = cliente().config();

  if (!cfg) {
    // Ainda não ligado: só mostra onde está o servidor (ligar exige o código dele).
    const achados = await cliente().procurarServidor(grupoId, { varrer: 'sempre' });
    return achados.length
      ? { ok: true, ligado: false, achados }
      : { ok: false, ligado: false, achados: [], error: 'Não achei o servidor em nenhum endereço da rede. Confira se ele está ligado, com o GerenciaAI aberto, na mesma rede, e se o Windows liberou o GerenciaAI no firewall (rede privada).' };
  }

  await cliente().reencontrar({ forcar: true });
  const r = await sincronizarAgora();
  const atual = cliente().config();
  if (r.modo !== 'lan') {
    return { ok: false, ligado: true, enderecos: atual?.enderecos || [], ...r, error: `O servidor ${atual?.hubNome || ''} não respondeu pela rede. Os dados seguem pela internet até ele voltar.` };
  }
  return { ok: r.passos.every((p) => p.ok), ligado: true, servidor: atual?.hubNome || null, enderecos: atual?.enderecos || [], ...r };
}

module.exports = { procurarESincronizar, sincronizarAgora };
