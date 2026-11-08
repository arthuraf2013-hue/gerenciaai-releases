import { VERTICE_FIREBASE_CONFIG, verticeConfigurado } from './verticeConfig';

// Instância única do módulo do Vértice, carregada só quando o projeto do
// Vértice está configurado (o SDK de Auth do Firebase só entra aqui).
// O nome do caixa vai para o Vértice (aparece em Empresa › Integrações).

let instancia = null;
let carregando = null;
let pararPonte = null;
let pararProdutos = null;

export function verticeDisponivel() {
  return verticeConfigurado(VERTICE_FIREBASE_CONFIG);
}

export async function obterVertice() {
  if (!verticeDisponivel()) return null;
  if (instancia) return instancia;
  if (!carregando) {
    carregando = (async () => {
      const [{ createVerticeSync, precisaRestaurar, restaurarConexaoSalva }, { iniciarPonteSenhas }, { iniciarPonteProdutos }] = await Promise.all([import('./verticeSync'), import('./ponteSenhas'), import('./ponteProdutos')]);
      // Conexão guardada pelo processo principal (sobrevive a armazenamento apagado e vale tanto
      // no instalado quanto rodando pelo código-fonte): se esta janela não tem, devolve.
      const salva = await lerConexaoSalva();
      try {
        const local = JSON.parse(localStorage.getItem('vertice:device') || 'null');
        if (precisaRestaurar(local, salva)) await restaurarConexaoSalva({ firebaseConfig: VERTICE_FIREBASE_CONFIG, salva });
      } catch (err) {
        console.warn('[vertice] não restaurei a conexão salva', err?.message || err);
      }
      let terminal = 'Caixa';
      try {
        const s = await window.pdv.settings.get();
        terminal = String(s?.location?.nome || 'Caixa').slice(0, 40);
      } catch { /* nome padrão */ }
      const vx = createVerticeSync({
        firebaseConfig: VERTICE_FIREBASE_CONFIG,
        terminal,
        appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '',
        onConexao: guardarConexao,
      });
      vx.start();
      pararPonte = iniciarPonteSenhas(vx);
      // Price: catálogo de produtos para as tabelas de preço das TVs.
      pararProdutos = iniciarPonteProdutos(vx);
      instancia = vx;
      return vx;
    })().catch((err) => {
      console.warn('[vertice] não iniciou', err?.message || err);
      carregando = null;
      return null;
    });
  }
  return carregando;
}

async function lerConexaoSalva() {
  try {
    const r = await window.pdv.vertice?.lerConexao?.();
    return r?.ok ? r.conexao : null;
  } catch {
    return null;
  }
}

/** Cópia da conexão no processo principal (login cifrado). Só grava o que mudou. */
let ultimaGravada = '';
function guardarConexao({ uid, sessao, dispositivo, empresa, motivo }) {
  const dados = { uid, sessao, dispositivo, empresa };
  const chave = JSON.stringify(dados);
  if (chave === ultimaGravada || !uid) return;
  ultimaGravada = chave;
  window.pdv.vertice?.gravarConexao?.({ ...dados, motivo })?.catch?.(() => {});
}

/**
 * Ao abrir o app: só liga se este caixa já foi conectado antes (não cria conta à toa).
 * Vale o pareamento desta janela ou o guardado pelo processo principal.
 */
export async function iniciarVerticeSePareado() {
  try {
    if (!verticeDisponivel()) return;
    if (localStorage.getItem('vertice:device') || (await lerConexaoSalva())?.dispositivo) obterVertice();
  } catch { /* sem armazenamento */ }
}

export function _pararParaTeste() { pararPonte?.(); pararProdutos?.(); }
