// Contas do painel de senhas (painel.js) -- sem Firebase nem DOM, para
// tests/painelSenhas.test.js testar direto.

const TOKEN = /^[A-Za-z0-9]{32}$/;
const COR = /^#[0-9a-fA-F]{6}$/;

function tokenValido(t) {
  return typeof t === 'string' && TOKEN.test(t);
}

// Mesmo padrão de electron/services/chamadaService.js (MODELO_PADRAO).
const MODELO_PADRAO = Object.freeze({
  layout: 'duas_colunas', titulo: '', tituloPreparando: 'Preparando', tituloProntos: 'Prontos',
  tituloChamada: 'Pedido pronto', mensagemChamada: 'Retire no balcão', mensagem: 'Acompanhe sua senha aqui.',
  mostrarNome: true, corFundo: '#141a26', corTexto: '#f5f1e8', corDestaque: '#d9a441', corPreparando: '#94a3b8',
  falarSenha: true, som: true, tema: 'escuro',
});

const texto = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : null);

/** Documento paineis_chamada/{token} -> dados conferidos para desenhar. */
function lerPainel(d) {
  if (!d || typeof d !== 'object') return null;
  const m = { ...MODELO_PADRAO };
  const e = d.modelo && typeof d.modelo === 'object' ? d.modelo : {};
  if (['duas_colunas', 'so_prontos'].includes(e.layout)) m.layout = e.layout;
  for (const k of ['titulo', 'tituloPreparando', 'tituloProntos', 'tituloChamada', 'mensagemChamada']) if (typeof e[k] === 'string') m[k] = texto(e[k], 40);
  if (typeof e.mensagem === 'string') m.mensagem = texto(e.mensagem, 140);
  for (const k of ['corFundo', 'corTexto', 'corDestaque', 'corPreparando']) if (COR.test(String(e[k] || ''))) m[k] = String(e[k]);
  for (const k of ['mostrarNome', 'falarSenha', 'som']) if (typeof e[k] === 'boolean') m[k] = e[k];
  const senha = (s) => (s && Number.isInteger(s.n) && s.n > 0 && s.n < 100000 ? { n: s.n, nome: m.mostrarNome ? texto(s.nome, 20) : null } : null);
  const lista = (l, max) => (Array.isArray(l) ? l.map(senha).filter(Boolean).slice(0, max) : []);
  const u = d.ultimaChamada && typeof d.ultimaChamada === 'object' ? senha(d.ultimaChamada) : null;
  return {
    ativo: d.ativo !== false,
    nomeLoja: texto(d.nomeLoja, 80) || '',
    modelo: m,
    preparando: m.layout === 'so_prontos' ? [] : lista(d.preparando, 30),
    prontos: lista(d.prontos, 12),
    ultimaChamada: u ? { ...u, seq: texto(d.ultimaChamada.seq, 40) || String(u.n) } : null,
  };
}

const UNIDADES = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const DEZENAS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const CENTENAS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

/** Número por extenso (até 999), para a voz da TV não dizer "um zero dois". */
function porExtenso(n) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n) || n < 0 || n > 999) return String(n);
  if (n < 20) return UNIDADES[n];
  if (n === 100) return 'cem';
  if (n < 100) return DEZENAS[Math.floor(n / 10)] + (n % 10 ? ` e ${UNIDADES[n % 10]}` : '');
  const resto = n % 100;
  return CENTENAS[Math.floor(n / 100)] + (resto ? ` e ${porExtenso(resto)}` : '');
}

/** Frase falada na chamada. */
function fraseDaChamada(c) {
  if (!c) return '';
  return `Senha ${porExtenso(c.n)}${c.nome ? `, ${c.nome}` : ''}.`;
}

export { tokenValido, lerPainel, porExtenso, fraseDaChamada, MODELO_PADRAO };
