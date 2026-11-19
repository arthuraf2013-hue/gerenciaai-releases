// Foto do produto igual em todos os caixas do grupo.
//
// A foto não vai dentro do documento do produto: o app relê o grupo inteiro
// ao abrir (grupoReplicaService.sincronizarTudo) e baixaria todas as fotos de
// novo toda vez. Ela vai em grupos_sincronizacao/{g}/fotos/{docDoProduto}
// ({ hash, tipo, dados(base64), versaoMs, origem }) e o produto leva só o
// `fotoHash`. Cada caixa baixa uma foto só quando o fotoHash muda.
//
//   produto.fotoHash = 'abc…'  a foto do grupo é esta
//   produto.fotoHash = null    o produto ficou sem foto
//   sem o campo                caixa de versão antiga, ou a foto daqui ainda
//                              não subiu: não mexe na foto de ninguém
//
// Filas (migração 16): grupo_replica_foto_enviar (foto trocada aqui, falta
// subir -- enche pelo gatilho do foto_path), grupo_replica_foto_baixar (o
// grupo tem foto nova, falta baixar) e grupo_replica_foto (foto daqui que o
// grupo já conhece: hash do arquivo daqui -> hash no grupo).
//
// Subir/baixar foto é separado do cadastro: se a nuvem recusar a foto (regra
// do Firestore ainda não publicada, sem cota, sem internet), produto, preço e
// estoque continuam sincronizando normalmente e a foto tenta de novo depois.

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { getDb } = require('../db/database');

const MAX_BYTES = 450 * 1024; // depois de comprimida (no grupo ~600 KB em base64; o Firestore aceita 1 MB por documento)
const LARGURAS = [800, 600, 400];
const TIPOS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const ENVIO_POR_VEZ = 4;
const DOWNLOAD_POR_VEZ = 6;
const ESPERA_ENVIO_FALHOU_MS = 5 * 60 * 1000;
const ESPERA_MAX_DOWNLOAD_MS = 30 * 60 * 1000;

const hashDe = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 32);

let pastaDeTeste = null;
function pastaDeFotos() {
  return pastaDeTeste || require('./productService').fotosDir();
}

/** Caminho só se estiver dentro da pasta de fotos do app (o caminho mora no banco). */
function arquivoSeguro(caminho) {
  if (!caminho) return null;
  const base = path.resolve(pastaDeFotos());
  const alvo = path.resolve(String(caminho));
  return alvo.startsWith(base + path.sep) && fs.existsSync(alvo) ? alvo : null;
}

function hashDoArquivo(caminho) {
  const seguro = arquivoSeguro(caminho);
  if (!seguro) return null;
  try { return hashDe(fs.readFileSync(seguro)); } catch { return null; }
}

/** O conteúdo é mesmo uma imagem do tipo dito? (vem de outro caixa / da nuvem) */
function pareceImagem(bytes, tipo) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return false;
  if (tipo === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (tipo === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (tipo === 'image/webp') return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

function tipoPelaExtensao(caminho) {
  const ext = path.extname(caminho).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Foto pronta para o grupo: no máximo 800 px de largura e MAX_BYTES.
 * PNG continua PNG (fundo transparente virava preto em JPEG). WEBP o
 * Electron não redimensiona: vai como está, se couber.
 */
function comprimirComElectron(caminho) {
  const original = fs.readFileSync(caminho);
  const tipoOriginal = tipoPelaExtensao(caminho);
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromBuffer(original);
  if (!img || img.isEmpty()) {
    return original.length <= MAX_BYTES && pareceImagem(original, tipoOriginal) ? { bytes: original, tipo: tipoOriginal } : null;
  }
  const largura = img.getSize().width;
  if (original.length <= MAX_BYTES && largura <= LARGURAS[0] && pareceImagem(original, tipoOriginal)) {
    return { bytes: original, tipo: tipoOriginal };
  }
  const png = tipoOriginal === 'image/png';
  for (const alvo of LARGURAS) {
    const menor = largura > alvo ? img.resize({ width: alvo, quality: 'good' }) : img;
    const bytes = png ? menor.toPNG() : menor.toJPEG(80);
    if (bytes.length <= MAX_BYTES) return { bytes, tipo: png ? 'image/png' : 'image/jpeg' };
  }
  return null;
}
let comprimir = comprimirComElectron;

// ---------------------------------------------------------------- no documento do produto

/**
 * O que o documento do produto leva sobre a foto: { fotoHash } ou nada.
 * Sem foto: null. Foto que o grupo já tem (mesmo arquivo): o hash dela.
 * Foto nova que ainda não subiu: nada (o fotoHash vem quando ela subir).
 */
function campoDaFoto(db, grupoId, produto) {
  if (!produto.foto_path) return { fotoHash: null };
  const reg = db.prepare('SELECT hash_arquivo, hash_grupo FROM grupo_replica_foto WHERE grupo_id = ? AND local_id = ?').get(grupoId, produto.id);
  if (reg && hashDoArquivo(produto.foto_path) === reg.hash_arquivo) return { fotoHash: reg.hash_grupo };
  return {};
}

function enfileirarEnvio(db, localId) {
  db.prepare(`INSERT INTO grupo_replica_foto_enviar (local_id, marca) VALUES (?, abs(random()))
              ON CONFLICT(local_id) DO UPDATE SET marca = abs(random())`).run(localId);
}

function tirarFotoDaqui(db, localId, caminho) {
  const seguro = arquivoSeguro(caminho);
  if (seguro) { try { fs.unlinkSync(seguro); } catch { /* já foi */ } }
  db.prepare('UPDATE products SET foto_path = NULL WHERE id = ?').run(localId);
}

/**
 * Produto do grupo acabou de ser gravado aqui (grupoReplicaService.mesclar,
 * já dentro de comoDoGrupo). Agenda a foto nova ou tira a que saiu.
 */
function aoReceberProduto(db, grupoId, localId, docId, d) {
  if (!d || !Object.prototype.hasOwnProperty.call(d, 'fotoHash')) return; // caixa antigo: não mexe
  const produto = db.prepare('SELECT id, foto_path FROM products WHERE id = ?').get(localId);
  if (!produto) return;
  const reg = db.prepare('SELECT hash_arquivo, hash_grupo FROM grupo_replica_foto WHERE grupo_id = ? AND local_id = ?').get(grupoId, localId);
  const hashAqui = produto.foto_path ? hashDoArquivo(produto.foto_path) : null;
  const conhecidaNoGrupo = !!reg && hashAqui !== null && hashAqui === reg.hash_arquivo;
  // Foto trocada aqui que ainda não subiu: a daqui vale (sobe e acerta os outros).
  const esperandoSubir = !!db.prepare('SELECT 1 FROM grupo_replica_foto_enviar WHERE local_id = ?').get(localId);

  if (d.fotoHash === null) {
    db.prepare('DELETE FROM grupo_replica_foto_baixar WHERE grupo_id = ? AND local_id = ?').run(grupoId, localId);
    if (!produto.foto_path || !hashAqui) {
      db.prepare('DELETE FROM grupo_replica_foto WHERE grupo_id = ? AND local_id = ?').run(grupoId, localId);
      return;
    }
    if (conhecidaNoGrupo && !esperandoSubir) {
      // Tiraram a foto em outro caixa.
      tirarFotoDaqui(db, localId, produto.foto_path);
      db.prepare('DELETE FROM grupo_replica_foto WHERE grupo_id = ? AND local_id = ?').run(grupoId, localId);
    } else {
      enfileirarEnvio(db, localId); // foto só daqui: o grupo ainda não viu
    }
    return;
  }

  const hash = typeof d.fotoHash === 'string' && /^[a-f0-9]{16,64}$/.test(d.fotoHash) ? d.fotoHash : null;
  if (!hash || esperandoSubir) return;
  if (conhecidaNoGrupo && reg.hash_grupo === hash) return; // já é esta
  db.prepare(
    `INSERT INTO grupo_replica_foto_baixar (grupo_id, local_id, doc_id, hash, tentativas, proxima_em) VALUES (?, ?, ?, ?, 0, 0)
     ON CONFLICT(grupo_id, local_id) DO UPDATE SET doc_id = excluded.doc_id, hash = excluded.hash, tentativas = 0, proxima_em = 0`
  ).run(grupoId, localId, docId, hash);
}

// ---------------------------------------------------------------- subir

let envioSoDepoisDe = 0;

async function enviarFotos({ grupoId, backend, origem, agora = Date.now() }) {
  if (agora < envioSoDepoisDe) return { enviadas: 0, esperando: true };
  const db = getDb();
  // marca como texto: o inteiro de 64 bits perde precisão no JS (ver grupoReplicaService).
  const fila = db.prepare('SELECT local_id, CAST(marca AS TEXT) AS marca FROM grupo_replica_foto_enviar LIMIT 50').all();
  if (!fila.length) return { enviadas: 0 };
  const itens = [];
  const feitos = [];
  for (const { local_id: localId, marca } of fila) {
    if (itens.length >= ENVIO_POR_VEZ) break;
    const produto = db.prepare('SELECT id, foto_path FROM products WHERE id = ?').get(localId);
    const arquivo = produto && arquivoSeguro(produto.foto_path);
    if (!arquivo) { feitos.push({ localId, marca }); continue; } // sem foto (o produto vai com fotoHash null)
    // Produto ainda não está no grupo: espera ele ir primeiro (fica na fila).
    const docId = db.prepare(`SELECT doc_id FROM grupo_replica WHERE entidade = 'produtos' AND grupo_id = ? AND local_id = ?`).get(grupoId, localId)?.doc_id;
    if (!docId) continue;
    const hashArquivo = hashDoArquivo(arquivo);
    const reg = db.prepare('SELECT hash_arquivo FROM grupo_replica_foto WHERE grupo_id = ? AND local_id = ?').get(grupoId, localId);
    if (reg && reg.hash_arquivo === hashArquivo) { feitos.push({ localId, marca }); continue; } // o grupo já tem esta
    let pronta = null;
    try { pronta = comprimir(arquivo); } catch (err) { console.error('[grupoFoto] não consegui preparar a foto:', err.message); }
    if (!pronta) {
      console.error(`[grupoFoto] foto do produto ${localId} grande demais ou ilegível: fica só neste caixa.`);
      feitos.push({ localId, marca });
      continue;
    }
    const hashGrupo = hashDe(pronta.bytes);
    itens.push({
      localId, marca, hashArquivo, hashGrupo,
      item: { docId, dados: { hash: hashGrupo, tipo: pronta.tipo, dados: pronta.bytes.toString('base64'), versaoMs: agora, origem: origem || null } },
    });
  }
  if (itens.length) {
    try {
      await backend.gravarLote(grupoId, 'fotos', itens.map((i) => i.item));
    } catch (err) {
      envioSoDepoisDe = agora + ESPERA_ENVIO_FALHOU_MS;
      console.error('[grupoFoto] as fotos não subiram (tenta de novo em 5 min):', err?.message || err);
      return { enviadas: 0, erro: err?.message || String(err) };
    }
  }
  const tirar = db.prepare('DELETE FROM grupo_replica_foto_enviar WHERE local_id = ? AND CAST(marca AS TEXT) = ?');
  db.transaction(() => {
    for (const i of itens) {
      db.prepare(
        `INSERT INTO grupo_replica_foto (grupo_id, local_id, hash_arquivo, hash_grupo) VALUES (?, ?, ?, ?)
         ON CONFLICT(grupo_id, local_id) DO UPDATE SET hash_arquivo = excluded.hash_arquivo, hash_grupo = excluded.hash_grupo`
      ).run(grupoId, i.localId, i.hashArquivo, i.hashGrupo);
      tirar.run(i.localId, i.marca);
      // O produto vai de novo, agora com o fotoHash: é isso que avisa os outros caixas.
      db.prepare(`INSERT INTO grupo_replica_pendente (entidade, local_id, marca) VALUES ('produtos', ?, abs(random()))
                  ON CONFLICT(entidade, local_id) DO UPDATE SET marca = abs(random())`).run(i.localId);
    }
    for (const f of feitos) tirar.run(f.localId, f.marca);
  })();
  return { enviadas: itens.length };
}

// ---------------------------------------------------------------- baixar

function gravarFotoRecebida(db, grupoId, linha, foto) {
  const tipo = TIPOS[foto?.tipo] ? foto.tipo : null;
  if (!tipo || typeof foto.dados !== 'string' || foto.dados.length > Math.ceil(MAX_BYTES * 1.4) + 1024) return false;
  const bytes = Buffer.from(foto.dados, 'base64');
  if (hashDe(bytes) !== linha.hash || !pareceImagem(bytes, tipo)) return false;
  const produto = db.prepare('SELECT id, foto_path FROM products WHERE id = ?').get(linha.local_id);
  if (!produto) return true; // produto sumiu: nada a fazer
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(produto.id)) return true;
  const destino = path.join(pastaDeFotos(), `${produto.id}${TIPOS[tipo]}`);
  const tmp = `${destino}.baixando`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, destino);
  const anterior = arquivoSeguro(produto.foto_path);
  if (anterior && path.resolve(anterior) !== path.resolve(destino)) { try { fs.unlinkSync(anterior); } catch { /* já foi */ } }
  // Como vinda do grupo: não volta para a fila de envio nem reenvia o produto.
  db.prepare('INSERT OR IGNORE INTO grupo_replica_aplicando (id) VALUES (1)').run();
  try {
    db.prepare('UPDATE products SET foto_path = ? WHERE id = ?').run(destino, produto.id);
  } finally {
    db.prepare('DELETE FROM grupo_replica_aplicando').run();
  }
  db.prepare(
    `INSERT INTO grupo_replica_foto (grupo_id, local_id, hash_arquivo, hash_grupo) VALUES (?, ?, ?, ?)
     ON CONFLICT(grupo_id, local_id) DO UPDATE SET hash_arquivo = excluded.hash_arquivo, hash_grupo = excluded.hash_grupo`
  ).run(grupoId, produto.id, linha.hash, linha.hash);
  return true;
}

async function baixarFotos({ grupoId, backend, agora = Date.now() }) {
  if (typeof backend.lerAlguns !== 'function') return { baixadas: 0 };
  const db = getDb();
  const linhas = db.prepare(
    'SELECT * FROM grupo_replica_foto_baixar WHERE grupo_id = ? AND proxima_em <= ? ORDER BY tentativas, proxima_em LIMIT ?'
  ).all(grupoId, agora, DOWNLOAD_POR_VEZ);
  if (!linhas.length) return { baixadas: 0 };
  let docs;
  try {
    docs = await backend.lerAlguns(grupoId, 'fotos', [...new Set(linhas.map((l) => l.doc_id))]);
  } catch (err) {
    console.error('[grupoFoto] não consegui baixar fotos (tenta de novo):', err?.message || err);
    docs = new Map();
  }
  let baixadas = 0;
  for (const linha of linhas) {
    const foto = docs.get(linha.doc_id);
    let ok = false;
    // Foto de outra versão (o produto ainda vai chegar com o hash novo): espera.
    if (foto && foto.hash === linha.hash) {
      try { ok = gravarFotoRecebida(db, grupoId, linha, foto); } catch (err) { console.error('[grupoFoto]', err.message); }
    }
    if (ok) {
      db.prepare('DELETE FROM grupo_replica_foto_baixar WHERE grupo_id = ? AND local_id = ? AND hash = ?').run(grupoId, linha.local_id, linha.hash);
      baixadas++;
    } else {
      // A foto ainda não subiu (o caixa dela está sem internet, por exemplo): tenta mais tarde.
      const espera = Math.min(ESPERA_MAX_DOWNLOAD_MS, 15000 * 2 ** Math.min(linha.tentativas, 10));
      db.prepare('UPDATE grupo_replica_foto_baixar SET tentativas = tentativas + 1, proxima_em = ? WHERE grupo_id = ? AND local_id = ? AND hash = ?')
        .run(agora + espera, grupoId, linha.local_id, linha.hash);
    }
  }
  return { baixadas };
}

// ---------------------------------------------------------------- ciclo

let trabalhando = null;

/** Sobe e baixa um pouco por vez. Chamado pelo relógio do grupoReplicaService. */
function trabalhar(opcoes) {
  if (trabalhando) return trabalhando;
  trabalhando = (async () => {
    const enviadas = opcoes.semEnvio ? 0 : (await enviarFotos(opcoes)).enviadas || 0;
    const baixadas = (await baixarFotos(opcoes)).baixadas || 0;
    return { enviadas, baixadas };
  })().catch((err) => {
    console.error('[grupoFoto]', err?.message || err);
    return { enviadas: 0, baixadas: 0 };
  }).finally(() => { trabalhando = null; });
  return trabalhando;
}

function temTrabalho(grupoId, agora = Date.now()) {
  const db = getDb();
  return !!db.prepare('SELECT 1 FROM grupo_replica_foto_enviar LIMIT 1').get()
    || !!db.prepare('SELECT 1 FROM grupo_replica_foto_baixar WHERE grupo_id = ? AND proxima_em <= ? LIMIT 1').get(grupoId, agora);
}

function _definirCompressorParaTeste(fn) { comprimir = fn || comprimirComElectron; envioSoDepoisDe = 0; }
function _definirPastaParaTeste(dir) { pastaDeTeste = dir || null; }

module.exports = {
  campoDaFoto, aoReceberProduto, enviarFotos, baixarFotos, trabalhar, temTrabalho,
  hashDe, pareceImagem, MAX_BYTES, _definirCompressorParaTeste, _definirPastaParaTeste,
};
