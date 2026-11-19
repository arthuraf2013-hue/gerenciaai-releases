/**
 * Escrita no Firestore pela API REST (documents:commit), sem o SDK.
 *
 * É o segundo caminho até a nuvem (redundância do ping de presença):
 *   - nunca fica presa: sem internet ou sem cota, a resposta (ou o erro)
 *     chega na hora -- o SDK, nesses casos, guarda a escrita numa fila em
 *     memória e a promessa só termina quando a rede/cota voltar;
 *   - não acumula: o que não foi, não vai depois (um ping velho não serve);
 *   - usa outra pilha de rede: no app, `net.fetch` do Electron (a do Chromium,
 *     que respeita o proxy do Windows); o SDK usa gRPC do Node.
 *
 * Mesmas regras do Firestore que o SDK sem login (request.auth == null).
 * `mesclar` tem a mesma semântica de setDoc(ref, dados, { merge: true }):
 * só os campos enviados mudam, mapas são mesclados campo a campo.
 */

const AGORA_NO_SERVIDOR = Object.freeze({ __agoraNoServidor: true });
const PRAZO_MS = 15 * 1000;

function ehAgora(v) {
  return v === AGORA_NO_SERVIDOR;
}

function ehMapaSimples(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !ehAgora(v);
}

function segmento(chave) {
  return /^[A-Za-z_][A-Za-z_0-9]*$/.test(chave) ? chave : '`' + String(chave).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}

/** Valor JS -> valor da API REST. AGORA_NO_SERVIDOR só é aceito como campo de mapa (vira transformação). */
function paraValor(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { nullValue: null };
    return Number.isSafeInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => paraValor(ehAgora(x) ? null : x)) } };
  if (ehAgora(v)) throw new Error('AGORA_NO_SERVIDOR só pode ser valor de um campo, não de uma lista');
  const fields = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined && !ehAgora(x)) fields[k] = paraValor(x);
  return { mapValue: { fields } };
}

/**
 * Monta a escrita de um merge: fields (sem os AGORA), máscara com os caminhos
 * folha (igual ao SDK com merge: true) e as transformações de hora do servidor.
 */
function montarEscritaMesclada(nomeDoc, dados) {
  const mascara = [];
  const transformacoes = [];
  const fields = {};
  function andar(obj, prefixo, destino) {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const caminho = prefixo ? `${prefixo}.${segmento(k)}` : segmento(k);
      if (ehAgora(v)) {
        transformacoes.push({ fieldPath: caminho, setToServerValue: 'REQUEST_TIME' });
      } else if (ehMapaSimples(v) && Object.keys(v).length > 0) {
        const sub = {};
        andar(v, caminho, sub);
        destino[k] = { mapValue: { fields: sub } };
      } else {
        mascara.push(caminho);
        destino[k] = paraValor(v);
      }
    }
  }
  andar(dados, '', fields);
  const escrita = { update: { name: nomeDoc, fields }, updateMask: { fieldPaths: mascara } };
  if (transformacoes.length) escrita.updateTransforms = transformacoes;
  return escrita;
}

function buscador() {
  try {
    const { net, app } = require('electron');
    if (net && typeof net.fetch === 'function' && app && app.isReady && app.isReady()) return net.fetch.bind(net);
  } catch { /* fora do Electron (testes) */ }
  return globalThis.fetch;
}

/**
 * setDoc(merge) pela REST. Resolve { ok: true } ou { ok: false, motivo, status, mensagem }.
 * motivo: 'sem-cota' | 'sem-documento' | 'sem-permissao' | 'pedido-invalido' | 'servidor' | 'sem-rede'
 * Nunca lança.
 *
 * @param {{ projeto, apiKey, caminho, dados, exigirExistente?, fetch?, prazoMs?, base? }} p
 *   caminho: 'installations/abc'. base: só para testes com o emulador.
 */
async function mesclar({ projeto, apiKey, caminho, dados, exigirExistente = false, fetch = null, prazoMs = PRAZO_MS, base = null }) {
  const raiz = `projects/${projeto}/databases/(default)/documents`;
  const escrita = montarEscritaMesclada(`${raiz}/${caminho}`, dados);
  if (exigirExistente) escrita.currentDocument = { exists: true };
  const url = `${base || 'https://firestore.googleapis.com'}/v1/${raiz}:commit?key=${encodeURIComponent(apiKey)}`;
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), prazoMs);
  relogio.unref?.();
  try {
    const resposta = await (fetch || buscador())(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes: [escrita] }),
      signal: controle.signal,
    });
    if (resposta.ok) return { ok: true };
    let corpo = null;
    try { corpo = await resposta.json(); } catch { /* corpo vazio */ }
    const status = corpo?.error?.status || '';
    const mensagem = String(corpo?.error?.message || '').slice(0, 300);
    let motivo = 'servidor';
    if (resposta.status === 429 || status === 'RESOURCE_EXHAUSTED') motivo = 'sem-cota';
    else if (resposta.status === 404 || status === 'NOT_FOUND' || status === 'FAILED_PRECONDITION') motivo = 'sem-documento';
    else if (resposta.status === 403 || status === 'PERMISSION_DENIED') motivo = 'sem-permissao';
    else if (resposta.status === 400 || status === 'INVALID_ARGUMENT') motivo = 'pedido-invalido';
    return { ok: false, motivo, status: resposta.status, mensagem };
  } catch (err) {
    return { ok: false, motivo: 'sem-rede', mensagem: String(err?.message || err).slice(0, 300) };
  } finally {
    clearTimeout(relogio);
  }
}

module.exports = { AGORA_NO_SERVIDOR, mesclar, montarEscritaMesclada, paraValor };
