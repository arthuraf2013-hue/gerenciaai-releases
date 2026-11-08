const fs = require('fs');
const path = require('path');
const secrets = require('./secretsService');

/**
 * Cópia da conexão do caixa com o Vértice, guardada pelo processo principal.
 *
 * A integração com o Vértice roda no renderer (src/integrations/vertice) e a identidade do
 * caixa é um login anônimo do Firebase guardado no armazenamento da janela. Se esse
 * armazenamento some, ou se o app abre por outra origem (instalado = app://app, pelo
 * código-fonte = http://localhost:5173), o login é outro e o caixa "esquece" que estava
 * conectado: o GerenciaAI volta a pedir código. Com esta cópia a janela restaura o mesmo
 * login e o mesmo pareamento ao abrir (verticeClient.js).
 *
 * Fica em userData/vertice-conexao.json. O login (que tem o token de renovação) vai cifrado
 * pelo cofre do sistema (secretsService). `historico` guarda os últimos eventos (sem token)
 * para o suporte entender uma desconexão.
 */

const MAX_HISTORICO = 20;
const UID = /^[A-Za-z0-9_-]{6,128}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function caminho() {
  // Mesmo truque do updateService: fora do Electron (node --test) cai na pasta dos testes.
  const { app } = require('electron');
  const base = app ? app.getPath('userData') : (process.env.GERENCIAAI_VERTICE_DIR || path.join(__dirname, '../../.data'));
  return path.join(base, 'vertice-conexao.json');
}

function lerArquivo() {
  try {
    return JSON.parse(fs.readFileSync(caminho(), 'utf-8'));
  } catch {
    return null;
  }
}

function gravarArquivo(dados) {
  const destino = caminho();
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  // Grava num temporário e troca: queda de energia no meio não estraga o arquivo bom.
  const tmp = `${destino}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(dados));
  fs.renameSync(tmp, destino);
}

/** Confere e limpa o que a janela mandou. Devolve { ok, dados } ou { ok: false, error }. */
function validar(entrada) {
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  if (typeof e.uid !== 'string' || !UID.test(e.uid)) return { ok: false, error: 'Conexão do Vértice inválida.' };
  if (typeof e.sessao !== 'string' || e.sessao.length > 20000) return { ok: false, error: 'Login do Vértice inválido.' };
  let sessao;
  try {
    sessao = JSON.parse(e.sessao);
  } catch {
    return { ok: false, error: 'Login do Vértice inválido.' };
  }
  if (sessao?.uid !== e.uid || typeof sessao?.stsTokenManager?.refreshToken !== 'string') {
    return { ok: false, error: 'Login do Vértice inválido.' };
  }
  let dispositivo = null;
  if (e.dispositivo) {
    const { companyId, unitId } = e.dispositivo;
    if (typeof companyId !== 'string' || !ID.test(companyId)) return { ok: false, error: 'Pareamento do Vértice inválido.' };
    if (unitId != null && (typeof unitId !== 'string' || !ID.test(unitId))) return { ok: false, error: 'Pareamento do Vértice inválido.' };
    dispositivo = { companyId, unitId: unitId ?? null };
  }
  return {
    ok: true,
    dados: {
      uid: e.uid,
      sessao: e.sessao,
      dispositivo,
      empresa: typeof e.empresa === 'string' ? e.empresa.slice(0, 120) : '',
      motivo: typeof e.motivo === 'string' ? e.motivo.slice(0, 40) : '',
    },
  };
}

function ler() {
  const a = lerArquivo();
  if (!a?.uid || !a.sessao) return { ok: true, conexao: null };
  const sessao = secrets.decrypt(a.sessao);
  if (!sessao) return { ok: true, conexao: null };
  return { ok: true, conexao: { uid: a.uid, sessao, dispositivo: a.dispositivo || null, empresa: a.empresa || '' } };
}

function gravar(entrada) {
  const v = validar(entrada);
  if (!v.ok) return v;
  const { uid, sessao, dispositivo, empresa, motivo } = v.dados;
  const atual = lerArquivo() || {};
  const historico = [...(Array.isArray(atual.historico) ? atual.historico : []),
    { em: new Date().toISOString(), motivo, uid, pareado: !!dispositivo, empresa: dispositivo ? dispositivo.companyId : null }]
    .slice(-MAX_HISTORICO);
  gravarArquivo({ uid, sessao: secrets.encrypt(sessao), dispositivo, empresa, atualizadoEm: new Date().toISOString(), historico });
  return { ok: true };
}

module.exports = { ler, gravar, validar, caminho };
