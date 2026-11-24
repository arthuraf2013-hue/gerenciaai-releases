const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/database');

/**
 * Fotos dos produtos nas vitrines (nov/2026).
 *
 * Vitrine online: a página pública não tem acesso ao computador, então as
 * fotos vão para o Firestore como miniaturas quadradas (240 px, JPEG ~10 KB)
 * em documentos installations/{id}/vitrine/fotos_0..fotos_11 (cada um com
 * até ~850 KB: { fotos: { <chave>: 'data:image/jpeg;base64,...' } }). O item
 * do catálogo leva só a chave (`foto`); a página baixa esses documentos
 * depois de mostrar a lista. Só reenvia o documento que mudou.
 *
 * QR da mesa (rede da loja / túnel): /api/foto/<produto> devolve a mesma
 * miniatura -- abre rápido no 4G, em vez da foto original de vários MB.
 *
 * Produto sem foto (ou que não coube) aparece com a ilustração de
 * vitrineVisual.js (emoji da categoria).
 */

const LADO = 240;
const QUALIDADE = 72;
const LIMITE_DOC = 850 * 1024; // documento do Firestore aceita até 1 MiB
const MAX_DOCS = 12;
const WEBP_MAX = 60 * 1024; // WEBP o Electron não abre: vai como está se for pequeno

let geradorDeTeste = null; // (arquivo) => { bytes, tipo } | null
function _definirGeradorParaTeste(fn) { geradorDeTeste = fn || null; cache.clear(); }

const cache = new Map(); // arquivo -> { marca, miniatura }

/** Fundo branco onde a foto é transparente (PNG): em JPEG viraria preto. */
function achatarNoBranco(img) {
  const { nativeImage } = require('electron');
  const { width, height } = img.getSize();
  const bgra = Buffer.from(img.toBitmap());
  // O Chromium costuma entregar o alfa pré-multiplicado (cor <= alfa); se
  // aparecer cor maior que o alfa, é alfa "reto" e a conta muda.
  let premultiplicado = true;
  let transparente = false;
  for (let i = 3; i < bgra.length; i += 4) {
    if (bgra[i] === 255) continue;
    transparente = true;
    if (bgra[i - 3] > bgra[i] || bgra[i - 2] > bgra[i] || bgra[i - 1] > bgra[i]) { premultiplicado = false; break; }
  }
  if (!transparente) return img;
  for (let i = 3; i < bgra.length; i += 4) {
    const f = bgra[i] / 255;
    if (f === 1) continue;
    for (let c = i - 3; c < i; c++) {
      const cor = premultiplicado ? bgra[c] : bgra[c] * f;
      bgra[c] = Math.min(255, Math.round(cor + 255 * (1 - f)));
    }
    bgra[i] = 255;
  }
  return nativeImage.createFromBitmap(bgra, { width, height });
}

function gerarComElectron(arquivo) {
  if (/\.webp$/i.test(arquivo)) {
    const bytes = fs.readFileSync(arquivo);
    return bytes.length <= WEBP_MAX ? { bytes, tipo: 'image/webp' } : null;
  }
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromPath(arquivo);
  if (!img || img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const lado = Math.min(width, height);
  if (!(lado > 0)) return null;
  let quadrada = img.crop({ x: Math.floor((width - lado) / 2), y: Math.floor((height - lado) / 2), width: lado, height: lado });
  if (lado > LADO) quadrada = quadrada.resize({ width: LADO, height: LADO, quality: 'good' });
  return { bytes: achatarNoBranco(quadrada).toJPEG(QUALIDADE), tipo: 'image/jpeg' };
}

function caminhoSeguro(fotoPath) {
  if (!fotoPath) return null;
  let base;
  try { base = path.resolve(require('./productService').fotosDir()); } catch { return null; }
  const alvo = path.resolve(String(fotoPath));
  return alvo.startsWith(base + path.sep) && fs.existsSync(alvo) ? alvo : null;
}

/** Miniatura do arquivo: { bytes, tipo, chave } (guardada até o arquivo mudar), ou null. */
function miniaturaDoArquivo(arquivo) {
  let marca;
  try { const st = fs.statSync(arquivo); marca = `${st.size}:${st.mtimeMs}`; } catch { return null; }
  const guardada = cache.get(arquivo);
  if (guardada && guardada.marca === marca) return guardada.miniatura;
  let miniatura = null;
  try {
    const r = (geradorDeTeste || gerarComElectron)(arquivo);
    if (r && r.bytes && r.bytes.length) {
      miniatura = { ...r, chave: crypto.createHash('sha256').update(r.bytes).digest('hex').slice(0, 16) };
    }
  } catch (err) {
    console.error('[vitrineFoto] miniatura falhou:', arquivo, err?.message || err);
  }
  cache.set(arquivo, { marca, miniatura });
  return miniatura;
}

/** Miniatura da foto do produto (para o QR da mesa), ou null. */
function miniaturaDoProduto(productId) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(productId || ''))) return null;
  const p = getDb().prepare('SELECT foto_path FROM products WHERE id = ? AND ativo = 1').get(productId);
  const arquivo = caminhoSeguro(p?.foto_path);
  return arquivo ? miniaturaDoArquivo(arquivo) : null;
}

const dataUrl = (m) => `data:${m.tipo};base64,${m.bytes.toString('base64')}`;

/**
 * Põe a chave da foto nos itens do catálogo e separa as miniaturas em
 * documentos. Devolve { itens, docs: [{ id: 'fotos_0', fotos, hash }] }.
 * O que não couber em MAX_DOCS fica sem foto (aparece a ilustração).
 */
function prepararFotos(itens) {
  const db = getDb();
  const ids = itens.map((i) => i.id);
  const caminhos = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const lote = ids.slice(i, i + 500);
    const linhas = db.prepare(`SELECT id, foto_path FROM products WHERE id IN (${lote.map(() => '?').join(',')}) AND foto_path IS NOT NULL AND foto_path <> ''`).all(...lote);
    for (const l of linhas) caminhos.set(l.id, l.foto_path);
  }
  const porChave = new Map();
  const chaveDoItem = new Map();
  for (const item of itens) {
    const arquivo = caminhoSeguro(caminhos.get(item.id));
    const m = arquivo ? miniaturaDoArquivo(arquivo) : null;
    if (!m) continue;
    chaveDoItem.set(item.id, m.chave);
    if (!porChave.has(m.chave)) porChave.set(m.chave, dataUrl(m));
  }
  // Ordem estável (pela chave): a mesma foto cai sempre no mesmo documento.
  const docs = [];
  let atual = null;
  const cabe = new Set();
  for (const chave of [...porChave.keys()].sort()) {
    const url = porChave.get(chave);
    const tamanho = url.length + chave.length + 8;
    if (tamanho > LIMITE_DOC) continue;
    if (!atual || atual.tamanho + tamanho > LIMITE_DOC) {
      if (docs.length >= MAX_DOCS) break;
      atual = { id: `fotos_${docs.length}`, fotos: {}, tamanho: 0 };
      docs.push(atual);
    }
    atual.fotos[chave] = url;
    atual.tamanho += tamanho;
    cabe.add(chave);
  }
  return {
    itens: itens.map((i) => (cabe.has(chaveDoItem.get(i.id)) ? { ...i, foto: chaveDoItem.get(i.id) } : i)),
    docs: docs.map((d) => ({ id: d.id, fotos: d.fotos, hash: crypto.createHash('sha256').update(JSON.stringify(d.fotos)).digest('hex') })),
  };
}

module.exports = { prepararFotos, miniaturaDoProduto, miniaturaDoArquivo, _definirGeradorParaTeste, LADO, LIMITE_DOC, MAX_DOCS };
