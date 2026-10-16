const { getDb } = require('../db/database');
const pdvMobileConfigService = require('./pdvMobileConfigService');

/**
 * Consultas sob demanda do PDV móvel -- o celular não tem acesso ao
 * SQLite, então o que NÃO dá pra publicar inteiro num documento só
 * (catálogo maior que o limite do status ao vivo, cadastro de clientes
 * -- dado pessoal que não deveria ficar copiado no Firestore à toa,
 * QR do Pix, etiqueta de balança) vira um pedido/resposta:
 *
 *   celular cria  installations/{installId}/consultas_pdv/{id}
 *                 { dispositivoUid, tipo, termo|codigo|valor, status: 'novo' }
 *   desktop responde no mesmo doc { status: 'respondida', resultado } ou
 *                 { status: 'erro', erro }
 *
 * Só leitura (nenhuma consulta muda nada no banco). Clientes vão com
 * telefone/documento MASCARADOS (só os 4 últimos dígitos) -- o suficiente
 * pro operador confirmar "é esse mesmo", sem espalhar CPF inteiro.
 */

const LIMITE_PRODUTOS = 20;
const LIMITE_CLIENTES = 15;

function locationIdAtual() {
  const location = getDb().prepare('SELECT id FROM locations LIMIT 1').get();
  return location?.id || null;
}

/** Mesmo formato do catálogo publicado em status_ao_vivo (ver
 * liveStatusSyncService.getCatalogoProdutos), pra o celular tratar igual
 * um produto achado localmente ou pelo servidor. */
function produtoParaCelular(p, estoque) {
  const { precoEfetivo } = require('./productService');
  const ehServico = p.tipo === 'servico';
  const material = ehServico ? require('./serviceMaterialService').custoMaterialPorUnidade(p.id) : 0;
  return {
    id: p.id, nome: p.nome, categoria: p.categoria || null, preco: precoEfetivo(p) + material,
    codigoBarras: p.codigo_barras || null, unidade: p.unidade || 'un', tipo: p.tipo || 'produto',
    estoque: ehServico ? null : (estoque ?? p.estoque_atual ?? null),
  };
}

function buscarProdutos(termo) {
  const t = String(termo || '').trim().slice(0, 60);
  if (t.length < 1) return [];
  const productService = require('./productService');
  return productService.list({ query: t, limit: LIMITE_PRODUTOS, locationId: locationIdAtual() })
    .map((p) => produtoParaCelular(p));
}

/** Código lido pela câmera/leitor do celular -- mesma ordem do PDV de
 * balcão (POSScreen.handleScan): etiqueta de balança primeiro (peso ou
 * preço embutido), depois código de barras, depois SKU. */
function resolverCodigo(codigo) {
  const c = String(codigo || '').trim().slice(0, 60);
  if (!c) return null;
  const productService = require('./productService');
  const { getCurrentStock } = require('./stockService');
  const locationId = locationIdAtual();
  const comEstoque = (p) => produtoParaCelular(p, p.tipo === 'servico' || !locationId ? null : getCurrentStock(p.id, locationId));

  const etiqueta = require('./weightBarcodeService').parseWeightBarcode(c);
  if (etiqueta) {
    const produto = productService.findByBalancaCode(etiqueta.codigoBalanca);
    if (!produto) return { naoEncontrado: true, mensagem: `Etiqueta de balança lida, mas nenhum produto tem o código de balança ${etiqueta.codigoBalanca}.` };
    const preco = productService.precoEfetivo(produto);
    const quantidade = etiqueta.pesoKg !== null ? etiqueta.pesoKg : (preco > 0 ? etiqueta.precoTotal / preco : null);
    // Peso com 3 casas (gramas) -- mesmo arredondamento implícito da
    // etiqueta; evita 0.30000000000000004 kg no carrinho do celular.
    return { produto: comEstoque(produto), quantidade: quantidade != null ? Math.round(quantidade * 1000) / 1000 : null };
  }

  const produto = productService.findByBarcode(c) || productService.findBySku(c);
  if (!produto) return { naoEncontrado: true, mensagem: `Código não encontrado: ${c}` };
  return { produto: comEstoque(produto), quantidade: null };
}

function mascarar(valor) {
  const digitos = String(valor || '').replace(/\D/g, '');
  return digitos.length >= 4 ? `•••${digitos.slice(-4)}` : null;
}

function buscarClientes(termo) {
  const t = String(termo || '').trim().slice(0, 60);
  if (t.length < 2) return [];
  const customerService = require('./customerService');
  return customerService.list({ query: t }).slice(0, LIMITE_CLIENTES).map((c) => ({
    id: c.id,
    nome: c.nome,
    telefoneFinal: mascarar(c.telefone),
    documentoFinal: mascarar(c.cpf || c.cnpj),
    pontos: c.pontos || 0,
    saldoFiado: customerService.getSaldoFiado(c.id),
  }));
}

/** Pix "copia e cola" + a matriz do QR já calculada (string de 0/1,
 * linha por linha) -- o celular só desenha num <canvas>, sem precisar de
 * biblioteca de QR nenhuma, e sem nunca renderizar SVG/HTML vindo do
 * Firestore (que é gravável sem autenticação pelo lado desktop -- ver
 * firestore.rules). Mesma função de payload do PDV de balcão
 * (pixService.buildPixPayload). */
function gerarPix({ valor, txid }) {
  const v = Number(valor);
  if (!Number.isFinite(v) || v <= 0 || v > 1000000) return { erro: 'Valor do Pix inválido.' };
  const r = require('./pixService').buildPixPayload({ valor: Math.round(v * 100) / 100, txid: String(txid || '') });
  if (!r.ok) return { erro: r.error };
  const QRCode = require('qrcode');
  const { modules } = QRCode.create(r.payload, { errorCorrectionLevel: 'M' });
  return { payload: r.payload, valor: r.valor, qr: { size: modules.size, bits: Array.from(modules.data).join('') } };
}

/** Executa uma consulta já validada quanto ao dispositivo. Exportada pra
 * teste -- não toca rede. */
function executarConsulta(dados) {
  const config = pdvMobileConfigService.getConfig();
  switch (dados?.tipo) {
    case 'produtos':
      return { resultado: buscarProdutos(dados.termo) };
    case 'codigo':
      return { resultado: resolverCodigo(dados.codigo) };
    case 'clientes':
      if (!config.permitirCliente) return { erro: 'Vincular cliente pelo celular não está liberado nesta loja.' };
      return { resultado: buscarClientes(dados.termo) };
    case 'pix': {
      if (!config.metodosPagamento.includes('pix')) return { erro: 'Pix não está liberado pro celular nesta loja.' };
      const r = gerarPix({ valor: dados.valor, txid: dados.txid });
      return r.erro ? { erro: r.erro } : { resultado: r };
    }
    default:
      return { erro: 'Tipo de consulta desconhecido.' };
  }
}

async function processarConsulta(docSnap, { firestore, installId }) {
  const dados = docSnap.data();
  if (dados.status !== 'novo') return;
  const { doc, updateDoc, serverTimestamp } = require('firebase/firestore');
  const ref = doc(firestore, 'installations', installId, 'consultas_pdv', docSnap.id);

  let resposta;
  if (!require('./pdvMobileSyncService').buscarDispositivoPdv(dados.dispositivoUid)) {
    resposta = { erro: 'Celular não reconhecido ou desconectado desta loja.' };
  } else {
    try {
      resposta = executarConsulta(dados);
    } catch (err) {
      console.error('[pdvMobileConsultaService] falha ao responder consulta:', err);
      resposta = { erro: 'Erro ao consultar o computador da loja.' };
    }
  }

  await updateDoc(ref, resposta.erro
    ? { status: 'erro', erro: resposta.erro, respondidoEm: serverTimestamp() }
    : { status: 'respondida', resultado: resposta.resultado ?? null, respondidoEm: serverTimestamp() }
  ).catch((err) => console.error('[pdvMobileConsultaService] não consegui responder a consulta:', err.message));
}

/** Consultas são descartáveis -- apaga as com mais de 1h pra coleção não
 * crescer pra sempre. Best-effort. */
async function limparConsultasAntigas({ firestore, installId }) {
  const { collection, query, where, getDocs, deleteDoc, limit, Timestamp } = require('firebase/firestore');
  const corte = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
  const snap = await getDocs(query(
    collection(firestore, 'installations', installId, 'consultas_pdv'), where('criadoEm', '<', corte), limit(200)
  ));
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref).catch(() => {})));
}

let pararEscuta = null;
let intervaloLimpeza = null;

function iniciarEscutaConsultas() {
  try {
    if (pararEscuta) { pararEscuta(); pararEscuta = null; }
    const licenseService = require('./licenseService');
    const pdvRegistryService = require('./pdvRegistryService');
    const { collection, query, where, onSnapshot } = require('firebase/firestore');
    const firestore = licenseService.getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();

    pararEscuta = onSnapshot(
      query(collection(firestore, 'installations', installId, 'consultas_pdv'), where('status', '==', 'novo')),
      (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === 'removed') return;
          processarConsulta(change.doc, { firestore, installId });
        });
      },
      (err) => console.error('[pdvMobileConsultaService] escuta de consultas falhou:', err)
    );

    if (intervaloLimpeza) clearInterval(intervaloLimpeza);
    intervaloLimpeza = setInterval(() => { limparConsultasAntigas({ firestore, installId }).catch(() => {}); }, 30 * 60 * 1000);
  } catch (err) {
    console.error('[pdvMobileConsultaService] não foi possível iniciar a escuta de consultas:', err);
  }
}

module.exports = { iniciarEscutaConsultas, executarConsulta, resolverCodigo, buscarClientes, buscarProdutos, gerarPix };
