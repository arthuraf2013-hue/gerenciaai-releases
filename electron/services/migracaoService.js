const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/**
 * "Migrar do sistema antigo": lê a exportação de QUALQUER sistema (planilha
 * .xlsx ou .csv, com o cabeçalho e as colunas que ele tiver), descobre qual
 * coluna é o quê (por nome de coluna e, se a IA estiver ligada, pedindo à
 * IA), mostra uma prévia e só então importa produtos ou clientes (com saldo
 * de fiado). Diferente de importExportService.importFromFile, que exige o
 * nosso modelo de planilha.
 *
 * Fluxo (canais migracao:* em ipc/handlers.js):
 *   abrir(caminho)          -> lê o arquivo e guarda em memória com um token
 *                              (o caminho nunca volta do renderer)
 *   sugerirComIA(token)     -> só cabeçalhos + 3 exemplos por coluna vão à
 *                              IA; em clientes, os exemplos vão MASCARADOS
 *                              (dígito vira 9, letra vira x): a IA vê o
 *                              formato de um CPF, nunca o CPF
 *   previa(token, ...)      -> converte tudo e conta novos/atualizados/erros
 *   importar(token, ...)    -> grava numa transação só
 *
 * Reimportar o mesmo arquivo não duplica: produto casa por código de barras,
 * depois código interno (SKU), depois nome igual; cliente por CPF/CNPJ,
 * depois telefone, depois nome igual. Estoque inicial e saldo de fiado só
 * entram em cadastro NOVO -- quem já existe só tem os campos vazios
 * completados (produto: nome/preço/custo atualizados, como na importação
 * de planilha).
 */

const MAX_LINHAS = 50000;
const MAX_COLUNAS = 80;
const VALIDADE_TOKEN_MS = 60 * 60 * 1000;
const TAMANHO_MAXIMO = 30 * 1024 * 1024;

const CAMPOS = {
  produtos: [
    { campo: 'nome', rotulo: 'Nome / descrição', obrigatorio: true, sinonimos: ['nome', 'descricao', 'produto', 'desc', 'descricao do produto', 'nome do produto', 'item', 'mercadoria', 'descricao produto', 'nome produto'] },
    { campo: 'preco', rotulo: 'Preço de venda', obrigatorio: true, sinonimos: ['preco', 'preco venda', 'preco de venda', 'pr venda', 'vlr venda', 'valor venda', 'valor de venda', 'venda', 'pv', 'preco varejo', 'vl venda', 'preco unitario', 'valor unitario', 'pc venda', 'preco final', 'valor'] },
    { campo: 'custo', rotulo: 'Custo', sinonimos: ['custo', 'preco custo', 'preco de custo', 'vlr custo', 'valor custo', 'pr custo', 'custo unitario', 'custo medio', 'ultimo custo', 'preco compra', 'valor compra', 'vl custo', 'custo real'] },
    { campo: 'codigoBarras', rotulo: 'Código de barras (EAN)', sinonimos: ['codigo de barras', 'cod barras', 'ean', 'gtin', 'ean13', 'codigo barras', 'barras', 'cod ean', 'codigo ean', 'cod de barras', 'ean 13'] },
    { campo: 'sku', rotulo: 'Código interno (SKU)', sinonimos: ['codigo', 'cod', 'sku', 'referencia', 'ref', 'codigo interno', 'cod interno', 'cod produto', 'codigo produto', 'codigo do produto', 'id', 'cod prod', 'cod item'] },
    { campo: 'estoque', rotulo: 'Estoque atual', sinonimos: ['estoque', 'qtd', 'quantidade', 'qtde', 'saldo', 'estoque atual', 'qtd estoque', 'saldo estoque', 'quant', 'saldo atual', 'qtd atual', 'disponivel'] },
    { campo: 'estoqueMinimo', rotulo: 'Estoque mínimo', sinonimos: ['estoque minimo', 'minimo', 'est minimo', 'qtd minima', 'estoque min', 'est min', 'qtd min'] },
    { campo: 'unidade', rotulo: 'Unidade', sinonimos: ['unidade', 'un', 'und', 'unid', 'medida', 'unidade medida', 'um', 'unidade de medida', 'unid medida'] },
    { campo: 'categoria', rotulo: 'Categoria / grupo', sinonimos: ['categoria', 'grupo', 'departamento', 'secao', 'familia', 'classe', 'subgrupo', 'depto', 'grupo produto'] },
    { campo: 'ncm', rotulo: 'NCM', sinonimos: ['ncm', 'cod ncm', 'codigo ncm'] },
    { campo: 'fornecedor', rotulo: 'Fornecedor', sinonimos: ['fornecedor', 'distribuidor', 'fornecedor principal'] },
  ],
  clientes: [
    { campo: 'nome', rotulo: 'Nome', obrigatorio: true, sinonimos: ['nome', 'cliente', 'razao social', 'nome cliente', 'nome completo', 'nome do cliente', 'nome razao social'] },
    { campo: 'telefone', rotulo: 'Telefone / WhatsApp', sinonimos: ['telefone', 'fone', 'celular', 'whatsapp', 'tel', 'contato', 'telefone 1', 'fone 1', 'cel', 'telefone celular'] },
    { campo: 'documento', rotulo: 'CPF / CNPJ', sinonimos: ['cpf', 'cnpj', 'cpf cnpj', 'documento', 'doc', 'cpf ou cnpj', 'cnpj cpf'] },
    { campo: 'dataNascimento', rotulo: 'Data de nascimento', sinonimos: ['nascimento', 'data nascimento', 'data de nascimento', 'aniversario', 'dt nasc', 'dt nascimento', 'data nasc'] },
    { campo: 'saldoFiado', rotulo: 'Saldo devedor (fiado)', sinonimos: ['saldo', 'debito', 'saldo devedor', 'divida', 'fiado', 'em aberto', 'valor em aberto', 'a receber', 'conta corrente', 'total em aberto', 'saldo fiado', 'deve'] },
  ],
};

const UNIDADES = {
  un: 'un', und: 'un', unid: 'un', unidade: 'un', u: 'un', pc: 'un', pca: 'un', peca: 'un', pcs: 'un',
  kg: 'kg', kilo: 'kg', quilo: 'kg', kgs: 'kg',
  g: 'g', gr: 'g', grama: 'g', gramas: 'g',
  l: 'l', lt: 'l', litro: 'l', litros: 'l',
  ml: 'ml',
  m: 'm', mt: 'm', metro: 'm', metros: 'm',
  cx: 'cx', caixa: 'cx',
  pct: 'pct', pacote: 'pct', pt: 'pct',
  dz: 'dz', duzia: 'dz',
  par: 'par', pr: 'par',
};

class ErroMigracao extends Error {}

// ---------------------------------------------------------------------
// Leitura do arquivo
// ---------------------------------------------------------------------

function normalizarTexto(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** UTF-8 quando o arquivo é UTF-8 válido; senão Windows-1252 (o "ANSI"
 * que a maioria dos sistemas brasileiros antigos exporta). */
function decodificar(buffer) {
  let b = buffer;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-1252').decode(b);
  }
}

/** CSV com detecção do separador (; , tab |) e aspas. */
function lerCsv(texto) {
  const primeira = texto.split(/\r?\n/).find((l) => l.trim()) || '';
  const candidatos = [';', ',', '\t', '|'];
  const contar = (sep) => primeira.split(sep).length - 1;
  const sep = candidatos.reduce((melhor, c) => (contar(c) > contar(melhor) ? c : melhor), ';');

  const linhas = [];
  let linha = [];
  let campo = '';
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (aspas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; } else aspas = false;
      } else campo += ch;
      continue;
    }
    if (ch === '"' && campo === '') { aspas = true; continue; }
    if (ch === sep) { linha.push(campo); campo = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && texto[i + 1] === '\n') i++;
      linha.push(campo);
      linhas.push(linha);
      linha = [];
      campo = '';
      if (linhas.length > MAX_LINHAS + 20) break;
      continue;
    }
    campo += ch;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

function valorDaCelula(valor) {
  if (valor === null || valor === undefined) return '';
  if (valor instanceof Date) {
    // Data de calendário vinda do Excel: meia-noite UTC -> usar os
    // campos UTC (não o fuso local) pra não voltar um dia.
    return `${valor.getUTCFullYear()}-${String(valor.getUTCMonth() + 1).padStart(2, '0')}-${String(valor.getUTCDate()).padStart(2, '0')}`;
  }
  if (typeof valor === 'object') {
    if (valor.result !== undefined) return valorDaCelula(valor.result);
    if (valor.text !== undefined) return String(valor.text);
    if (Array.isArray(valor.richText)) return valor.richText.map((r) => r.text).join('');
    return '';
  }
  return valor;
}

async function lerXlsx(caminho) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(caminho);
  // A primeira aba com dado de verdade (exportações às vezes começam com
  // uma aba de "parâmetros" vazia).
  const aba = workbook.worksheets.find((w) => w.actualRowCount > 1) || workbook.worksheets[0];
  if (!aba) return { linhas: [], aba: null, abas: [] };
  const linhas = [];
  aba.eachRow({ includeEmpty: false }, (row) => {
    if (linhas.length > MAX_LINHAS + 20) return;
    const valores = [];
    for (let c = 1; c <= Math.min(row.cellCount, MAX_COLUNAS); c++) valores.push(valorDaCelula(row.getCell(c).value));
    linhas.push(valores);
  });
  return { linhas, aba: aba.name, abas: workbook.worksheets.map((w) => w.name) };
}

/** Pontuação de uma linha como cabeçalho: quantas células batem com um
 * nome de coluna conhecido. */
function pontuarCabecalho(celulas) {
  const todos = [...CAMPOS.produtos, ...CAMPOS.clientes].flatMap((c) => c.sinonimos);
  return celulas.reduce((s, c) => {
    const n = normalizarTexto(c);
    return s + (n && todos.includes(n) ? 1 : 0);
  }, 0);
}

/** Exportações costumam ter título/data/filtro antes do cabeçalho -- pega,
 * entre as 15 primeiras linhas, a que mais parece cabeçalho. */
function separarCabecalho(linhas) {
  const naoVazias = linhas.filter((l) => l.some((c) => String(c ?? '').trim() !== ''));
  if (naoVazias.length === 0) throw new ErroMigracao('O arquivo está vazio.');
  let melhor = 0;
  let melhorPontos = -1;
  naoVazias.slice(0, 15).forEach((l, i) => {
    const textos = l.filter((c) => typeof c === 'string' && c.trim() && !/^[\d.,\s/-]+$/.test(c));
    const pontos = pontuarCabecalho(l) * 10 + (textos.length >= 2 ? textos.length : 0);
    if (pontos > melhorPontos) { melhorPontos = pontos; melhor = i; }
  });
  const usados = new Map();
  const colunas = naoVazias[melhor].slice(0, MAX_COLUNAS).map((c, i) => {
    let nome = String(c ?? '').trim().slice(0, 60) || `Coluna ${i + 1}`;
    const vezes = usados.get(nome) || 0;
    usados.set(nome, vezes + 1);
    if (vezes) nome = `${nome} (${vezes + 1})`;
    return nome;
  });
  const dados = naoVazias.slice(melhor + 1)
    .map((l) => colunas.map((_, i) => valorDaCelula(l[i])))
    .filter((l) => l.some((c) => String(c).trim() !== ''));
  return { colunas, dados, linhaCabecalho: melhor };
}

// ---------------------------------------------------------------------
// Mapeamento de colunas
// ---------------------------------------------------------------------

function pareceCodigoDeBarras(valores) {
  const preenchidos = valores.map((v) => String(v).trim()).filter(Boolean);
  if (preenchidos.length === 0) return false;
  const ean = preenchidos.filter((v) => /^\d{8}$|^\d{12,14}$/.test(v)).length;
  return ean / preenchidos.length >= 0.6;
}

/**
 * Mapeamento por nome de coluna. Devolve { campo: nomeDaColuna }. Cada
 * coluna serve a um campo só. "Código" sozinho vira código de barras se os
 * valores parecem EAN, senão SKU.
 */
function sugerirMapeamento(tipo, colunas, dados) {
  const campos = CAMPOS[tipo];
  const candidatos = [];
  colunas.forEach((col, i) => {
    const n = normalizarTexto(col);
    if (!n) return;
    for (const c of campos) {
      let pontos = 0;
      if (c.sinonimos.includes(n)) pontos = 3;
      else if (c.sinonimos.some((s) => s.length >= 3 && (` ${n} `).includes(` ${s} `))) pontos = 2;
      if (pontos) candidatos.push({ campo: c.campo, coluna: col, indice: i, pontos, ordem: c.sinonimos.indexOf(n) });
    }
  });
  // Exato antes de parcial; entre exatos, o sinônimo mais "forte" (mais
  // no começo da lista) ganha.
  candidatos.sort((a, b) => b.pontos - a.pontos || (a.ordem === -1 ? 99 : a.ordem) - (b.ordem === -1 ? 99 : b.ordem));
  const mapa = {};
  const usadas = new Set();
  for (const c of candidatos) {
    if (mapa[c.campo] || usadas.has(c.coluna)) continue;
    mapa[c.campo] = c.coluna;
    usadas.add(c.coluna);
  }

  if (tipo === 'produtos' && mapa.sku && !mapa.codigoBarras) {
    const i = colunas.indexOf(mapa.sku);
    if (pareceCodigoDeBarras(dados.slice(0, 200).map((l) => l[i]))) {
      mapa.codigoBarras = mapa.sku;
      delete mapa.sku;
    }
  }
  return mapa;
}

/** Só aceita campo conhecido -> coluna existente, sem repetir coluna. */
function validarMapeamento(tipo, mapeamento, colunas) {
  const campos = new Set(CAMPOS[tipo].map((c) => c.campo));
  const limpo = {};
  const usadas = new Set();
  for (const [campo, coluna] of Object.entries(mapeamento || {})) {
    if (!campos.has(campo) || typeof coluna !== 'string' || !colunas.includes(coluna) || usadas.has(coluna)) continue;
    limpo[campo] = coluna;
    usadas.add(coluna);
  }
  return limpo;
}

/** Exemplo de valor com a forma preservada e o conteúdo apagado. */
function mascarar(valor) {
  return String(valor ?? '').slice(0, 40).replace(/\d/g, '9').replace(/[A-Za-zÀ-ÿ]/g, 'x');
}

function amostrasPorColuna(colunas, dados, { mascarado }) {
  return colunas.map((col, i) => {
    const exemplos = [];
    for (const l of dados) {
      const v = String(l[i] ?? '').trim();
      if (v && !exemplos.includes(v)) exemplos.push(v);
      if (exemplos.length >= 3) break;
    }
    return { coluna: col, exemplos: exemplos.map((e) => (mascarado ? mascarar(e) : e.slice(0, 40))) };
  });
}

// ---------------------------------------------------------------------
// Conversão de valores
// ---------------------------------------------------------------------

/** Número em formato brasileiro ou americano: "1.234,56", "R$ 12,90",
 * "12.90", "1,5". Um ponto sozinho é decimal ("1.250" kg = 1,25). */
function lerNumero(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : NaN;
  let s = String(valor ?? '').trim().replace(/R\$|\s/gi, '');
  if (!s) return NaN;
  let negativo = false;
  if (/^\(.*\)$/.test(s)) { negativo = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { negativo = true; s = s.slice(0, -1); }
  const temVirgula = s.includes(',');
  const pontos = (s.match(/\./g) || []).length;
  if (temVirgula && pontos) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (temVirgula) {
    s = (s.match(/,/g) || []).length > 1 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (pontos > 1) {
    s = s.replace(/\./g, '');
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  const n = Number(s);
  return negativo ? -n : n;
}

function lerCodigo(valor) {
  if (valor === '' || valor === null || valor === undefined) return { valor: null };
  if (typeof valor === 'number') {
    if (!Number.isSafeInteger(valor)) return { erro: 'código numérico grande demais (o Excel arredondou)' };
    return { valor: String(valor) };
  }
  const s = String(valor).trim();
  if (/^\d+(\.\d+)?e\+\d+$/i.test(s.replace(',', '.'))) {
    return { erro: 'código em notação científica (ex: 7,89E+12) — no sistema antigo/Excel, formate a coluna como Texto antes de exportar' };
  }
  return { valor: s.replace(/\s/g, '').slice(0, 60) || null };
}

function lerUnidade(valor) {
  const n = normalizarTexto(valor).replace(/\s/g, '');
  return n ? (UNIDADES[n] || null) : null;
}

function lerData(valor) {
  const s = String(valor ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let a; let mes; let d;
  if (m) [, a, mes, d] = m;
  else {
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
    if (!m) return null;
    [, d, mes, a] = m;
    if (a.length === 2) a = Number(a) > 30 ? `19${a}` : `20${a}`;
  }
  const iso = `${a}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dt = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso || Number(a) < 1900) return null;
  return iso;
}

const digitos = (v) => String(v ?? '').replace(/\D/g, '');

// ---------------------------------------------------------------------
// Sessões em memória (o caminho do arquivo nunca vem do renderer)
// ---------------------------------------------------------------------

const sessoes = new Map();

function limparSessoesVelhas() {
  const agora = Date.now();
  for (const [k, s] of sessoes) if (agora - s.criadaEm > VALIDADE_TOKEN_MS) sessoes.delete(k);
}

function sessao(token) {
  limparSessoesVelhas();
  const s = sessoes.get(token);
  if (!s) throw new ErroMigracao('A leitura do arquivo expirou. Abra o arquivo de novo.');
  return s;
}

function sugerirTipo(colunas) {
  const n = colunas.map(normalizarTexto);
  const tem = (lista) => n.some((c) => lista.includes(c));
  const produtos = tem(CAMPOS.produtos.find((c) => c.campo === 'preco').sinonimos) || tem(['ean', 'codigo de barras', 'estoque', 'ncm']);
  const clientes = tem(['cpf', 'cnpj', 'cpf cnpj', 'telefone', 'celular', 'whatsapp']);
  return clientes && !produtos ? 'clientes' : 'produtos';
}

function resumoDaSessao(token, s) {
  return {
    token,
    arquivo: s.arquivo,
    aba: s.aba,
    abas: s.abas,
    colunas: s.colunas,
    totalLinhas: s.dados.length,
    tipoSugerido: s.tipoSugerido,
    campos: Object.fromEntries(Object.entries(CAMPOS).map(([t, lista]) => [t, lista.map(({ campo, rotulo, obrigatorio }) => ({ campo, rotulo, obrigatorio: !!obrigatorio }))])),
    mapeamentoSugerido: {
      produtos: sugerirMapeamento('produtos', s.colunas, s.dados),
      clientes: sugerirMapeamento('clientes', s.colunas, s.dados),
    },
    // Primeiras linhas como estão no arquivo, pra pessoa reconhecer.
    linhasOriginais: s.dados.slice(0, 5).map((l) => l.map((c) => String(c).slice(0, 60))),
  };
}

async function abrir(caminho) {
  try {
    const ext = path.extname(caminho).toLowerCase();
    if (ext === '.xls') throw new ErroMigracao('Arquivo .xls (Excel antigo) não é lido direto. Abra no Excel e use "Salvar como" → Pasta de Trabalho do Excel (.xlsx) ou CSV.');
    if (!['.xlsx', '.csv', '.txt'].includes(ext)) throw new ErroMigracao('Use um arquivo .xlsx, .csv ou .txt exportado do sistema antigo.');
    const tamanho = fs.statSync(caminho).size;
    if (tamanho > TAMANHO_MAXIMO) throw new ErroMigracao(`Arquivo grande demais (${Math.round(tamanho / 1048576)} MB). O limite é ${TAMANHO_MAXIMO / 1048576} MB.`);

    let linhas; let aba = null; let abas = [];
    if (ext === '.xlsx') ({ linhas, aba, abas } = await lerXlsx(caminho));
    else linhas = lerCsv(decodificar(fs.readFileSync(caminho)));

    const { colunas, dados } = separarCabecalho(linhas);
    if (dados.length === 0) throw new ErroMigracao('Achei o cabeçalho, mas nenhuma linha de dado embaixo dele.');
    if (dados.length > MAX_LINHAS) throw new ErroMigracao(`O arquivo tem mais de ${MAX_LINHAS} linhas. Divida em partes menores.`);

    limparSessoesVelhas();
    const token = randomUUID();
    const s = { arquivo: path.basename(caminho), aba, abas, colunas, dados, criadaEm: Date.now(), tipoSugerido: sugerirTipo(colunas) };
    sessoes.set(token, s);
    return { ok: true, ...resumoDaSessao(token, s) };
  } catch (err) {
    if (err instanceof ErroMigracao) return { ok: false, error: err.message };
    console.error('[migracaoService] falha ao ler arquivo:', err);
    return { ok: false, error: 'Não consegui ler este arquivo. Confira se ele abre no Excel e tente exportar de novo.' };
  }
}

async function sugerirComIA({ token, tipo }) {
  try {
    if (!CAMPOS[tipo]) return { ok: false, error: 'Tipo de migração inválido.' };
    const s = sessao(token);
    const r = await require('./aiService').sugerirMapeamentoColunas({
      tipo,
      campos: CAMPOS[tipo].map(({ campo, rotulo }) => ({ campo, rotulo })),
      colunas: amostrasPorColuna(s.colunas, s.dados, { mascarado: tipo === 'clientes' }),
    });
    if (!r.ok) return r;
    return { ok: true, mapeamento: validarMapeamento(tipo, r.mapeamento, s.colunas) };
  } catch (err) {
    if (err instanceof ErroMigracao) return { ok: false, error: err.message };
    throw err;
  }
}

// ---------------------------------------------------------------------
// Conversão linha a linha + prévia
// ---------------------------------------------------------------------

function converterProduto(l, idx) {
  const erros = [];
  const avisos = [];
  const nome = String(l.nome ?? '').trim().slice(0, 120);
  if (nome.length < 2) erros.push('sem nome');
  const preco = lerNumero(l.preco);
  if (!Number.isFinite(preco)) erros.push('preço vazio ou inválido');
  else if (preco < 0) erros.push('preço negativo');
  let custo = l.custo === undefined || String(l.custo).trim() === '' ? null : lerNumero(l.custo);
  if (custo != null && (!Number.isFinite(custo) || custo < 0)) { avisos.push('custo inválido ignorado'); custo = null; }
  const cb = lerCodigo(l.codigoBarras);
  if (cb.erro) erros.push(cb.erro);
  const sk = lerCodigo(l.sku);
  if (sk.erro) erros.push(sk.erro.replace('código', 'código interno'));
  let estoque = l.estoque === undefined || String(l.estoque).trim() === '' ? null : lerNumero(l.estoque);
  if (estoque != null && !Number.isFinite(estoque)) { avisos.push('estoque inválido ignorado'); estoque = null; }
  if (estoque != null && estoque < 0) { avisos.push('estoque negativo vira 0'); estoque = 0; }
  let minimo = l.estoqueMinimo === undefined || String(l.estoqueMinimo).trim() === '' ? null : lerNumero(l.estoqueMinimo);
  if (minimo != null && (!Number.isFinite(minimo) || minimo < 0)) { avisos.push('estoque mínimo inválido ignorado'); minimo = null; }
  let unidade = null;
  if (l.unidade !== undefined && String(l.unidade).trim()) {
    unidade = lerUnidade(l.unidade);
    if (!unidade) avisos.push(`unidade "${String(l.unidade).trim().slice(0, 10)}" desconhecida: ficou "un"`);
  }
  const ncm = digitos(l.ncm).slice(0, 8) || null;
  return {
    linha: idx,
    erros,
    avisos,
    dados: {
      nome, preco: Number.isFinite(preco) ? Math.round(preco * 100) / 100 : null,
      custo: custo == null ? null : Math.round(custo * 100) / 100,
      codigoBarras: cb.valor || null, sku: sk.valor || null,
      estoque: estoque == null ? null : Math.round(estoque * 1000) / 1000,
      estoqueMinimo: minimo, unidade: unidade || 'un',
      categoria: String(l.categoria ?? '').trim().slice(0, 60) || null,
      ncm: ncm && ncm.length === 8 ? ncm : null,
      fornecedor: String(l.fornecedor ?? '').trim().slice(0, 120) || null,
    },
  };
}

function converterCliente(l, idx) {
  const erros = [];
  const avisos = [];
  const nome = String(l.nome ?? '').trim().slice(0, 120);
  if (nome.length < 2) erros.push('sem nome');
  const doc = digitos(l.documento);
  let cpf = null; let cnpj = null;
  if (doc.length === 11) cpf = doc;
  else if (doc.length === 14) cnpj = doc;
  else if (doc) avisos.push('CPF/CNPJ com tamanho estranho: ignorado');
  const tel = digitos(l.telefone);
  let telefone = null;
  if (tel.length >= 8 && tel.length <= 13) telefone = tel;
  else if (tel) avisos.push('telefone estranho: ignorado');
  let dataNascimento = null;
  if (l.dataNascimento !== undefined && String(l.dataNascimento).trim()) {
    dataNascimento = lerData(l.dataNascimento);
    if (!dataNascimento) avisos.push('data de nascimento não reconhecida');
  }
  let saldo = l.saldoFiado === undefined || String(l.saldoFiado).trim() === '' ? 0 : lerNumero(l.saldoFiado);
  if (!Number.isFinite(saldo)) { avisos.push('saldo inválido ignorado'); saldo = 0; }
  if (saldo < 0) { avisos.push('saldo a favor do cliente (negativo) não é migrado'); saldo = 0; }
  return {
    linha: idx, erros, avisos,
    dados: { nome, cpf, cnpj, telefone, dataNascimento, saldoFiado: Math.round(saldo * 100) / 100 },
  };
}

function linhasMapeadas(s, mapeamento) {
  const indices = Object.entries(mapeamento).map(([campo, col]) => [campo, s.colunas.indexOf(col)]);
  return s.dados.map((linha) => Object.fromEntries(indices.map(([campo, i]) => [campo, linha[i]])));
}

function chaveNome(nome) {
  return normalizarTexto(nome);
}

/** Casa cada linha com o cadastro que já existe (ou com uma linha anterior
 * do próprio arquivo). Não grava nada.
 *
 * sku e codigo_barras são UNIQUE na tabela inteira, inclusive produto
 * excluído (ativo = 0). Por isso o casamento por código olha também os
 * excluídos: mesmo código = mesmo produto, que é reativado. Nome só casa
 * com produto ativo. */
function planejarProdutos(convertidos) {
  const db = getDb();
  const todos = db.prepare('SELECT * FROM products').all();
  const porCodigo = new Map(todos.filter((p) => p.codigo_barras).map((p) => [p.codigo_barras, p]));
  const porSku = new Map(todos.filter((p) => p.sku).map((p) => [p.sku, p]));
  const porNome = new Map(todos.filter((p) => p.ativo === 1).map((p) => [chaveNome(p.nome), p]));
  const vistos = { codigo: new Map(), sku: new Map(), nome: new Map() };
  const skusDoArquivo = new Map();

  return convertidos.map((c) => {
    if (c.erros.length) return { ...c, acao: 'erro' };
    const d = { ...c.dados };
    const avisos = [...c.avisos];
    const repetida = (d.codigoBarras && vistos.codigo.get(d.codigoBarras))
      || (!d.codigoBarras && d.sku && vistos.sku.get(d.sku))
      || (!d.codigoBarras && !d.sku && vistos.nome.get(chaveNome(d.nome)));
    if (repetida) return { ...c, acao: 'erro', erros: [`repetido no arquivo (mesmo produto da linha ${repetida})`] };
    if (d.codigoBarras) vistos.codigo.set(d.codigoBarras, c.linha);
    else if (d.sku) vistos.sku.set(d.sku, c.linha);
    else vistos.nome.set(chaveNome(d.nome), c.linha);

    const primeiraPalavra = (nome) => chaveNome(nome).split(' ')[0];
    let existente = (d.codigoBarras && porCodigo.get(d.codigoBarras)) || null;
    if (!existente && d.sku) {
      // Código interno de outro sistema pode coincidir com um daqui por
      // acaso: só é o mesmo produto se o nome também começa igual.
      const porCodigoInterno = porSku.get(d.sku);
      if (porCodigoInterno && primeiraPalavra(porCodigoInterno.nome) === primeiraPalavra(d.nome)) existente = porCodigoInterno;
    }
    if (!existente) existente = porNome.get(chaveNome(d.nome)) || null;
    // Casou por SKU/nome, mas os dois têm código de barras e são diferentes:
    // são produtos diferentes.
    if (existente && d.codigoBarras && existente.codigo_barras && existente.codigo_barras !== d.codigoBarras) existente = null;

    // Código interno: se já é de OUTRO produto (ou de outra linha do
    // arquivo), fica de fora -- é o código de barras que identifica.
    if (d.sku) {
      const dono = porSku.get(d.sku);
      const outraLinha = skusDoArquivo.get(d.sku);
      if ((dono && dono.id !== existente?.id) || (outraLinha && outraLinha !== c.linha)) {
        avisos.push(`código interno "${d.sku}" já é de ${dono ? `"${dono.nome}"` : `outra linha (${outraLinha})`}: ignorado`);
        d.sku = null;
      } else {
        skusDoArquivo.set(d.sku, c.linha);
      }
    }
    const base = { ...c, dados: d, avisos };
    if (!existente) return { ...base, acao: 'novo' };
    if (existente.ativo !== 1) avisos.push(`produto excluído "${existente.nome}" será reativado`);
    return { ...base, acao: 'atualizar', existenteId: existente.id, existenteNome: existente.nome, reativar: existente.ativo !== 1 };
  });
}

/** Telefone sem DDI 55 nem zero de operadora: "5581999991234",
 * "081999991234" e "81999991234" viram a mesma chave. */
function chaveTelefone(tel) {
  let t = digitos(tel);
  if (t.length >= 12 && t.startsWith('55')) t = t.slice(2);
  if (t.length >= 11 && t.startsWith('0')) t = t.slice(1);
  return t;
}

function planejarClientes(convertidos) {
  const db = getDb();
  const ativos = db.prepare('SELECT * FROM customers WHERE ativo = 1').all();
  const porDoc = new Map();
  const porTel = new Map();
  const porTelSemDdd = new Map();
  const porNome = new Map();
  for (const c of ativos) {
    const doc = digitos(c.cpf) || digitos(c.cnpj);
    if (doc) porDoc.set(doc, c);
    const tel = chaveTelefone(c.telefone);
    if (tel.length >= 8) {
      porTel.set(tel, c);
      porTelSemDdd.set(tel.slice(-8), c);
    }
    porNome.set(chaveNome(c.nome), c);
  }
  // Com DDD dos dois lados, só número igual casa (mesmo final em DDD
  // diferente é outra pessoa). Sem DDD em um dos lados, compara o final.
  const buscarTelefone = (tel) => {
    const t = chaveTelefone(tel);
    if (porTel.has(t)) return porTel.get(t);
    if (t.length <= 9) return porTelSemDdd.get(t.slice(-8)) || null;
    const semDdd = porTelSemDdd.get(t.slice(-8));
    return semDdd && chaveTelefone(semDdd.telefone).length <= 9 ? semDdd : null;
  };
  const vistos = new Map();
  return convertidos.map((c) => {
    if (c.erros.length) return { ...c, acao: 'erro' };
    const d = c.dados;
    const chave = d.cpf || d.cnpj || (d.telefone ? `tel:${chaveTelefone(d.telefone)}:${chaveNome(d.nome).split(' ')[0]}` : `nome:${chaveNome(d.nome)}`);
    if (vistos.has(chave)) return { ...c, acao: 'erro', erros: [`repetido no arquivo (mesmo cliente da linha ${vistos.get(chave)})`] };
    vistos.set(chave, c.linha);
    const doc = d.cpf || d.cnpj;
    const semDoc = (cli) => cli && !digitos(cli.cpf) && !digitos(cli.cnpj);
    let existente = (doc && porDoc.get(doc)) || null;
    // Documento novo aqui, mas o telefone é de um cliente cadastrado SEM
    // documento: é ele (com documento diferente, seria outra pessoa).
    if (!existente && d.telefone) {
      const porTelefone = buscarTelefone(d.telefone);
      // Telefone de casa é dividido pela família: só é a mesma pessoa se o
      // primeiro nome também bate.
      const primeiroNome = (n) => chaveNome(n).split(' ')[0];
      if (porTelefone && (!doc || semDoc(porTelefone)) && primeiroNome(porTelefone.nome) === primeiroNome(d.nome)) existente = porTelefone;
    }
    if (!existente && !doc && !d.telefone) existente = porNome.get(chaveNome(d.nome)) || null;
    if (existente) return { ...c, acao: 'atualizar', existenteId: existente.id, existenteNome: existente.nome };
    return { ...c, acao: 'novo' };
  });
}

function planejar(token, tipo, mapeamentoBruto) {
  if (!CAMPOS[tipo]) throw new ErroMigracao('Tipo de migração inválido.');
  const s = sessao(token);
  const mapeamento = validarMapeamento(tipo, mapeamentoBruto, s.colunas);
  const faltando = CAMPOS[tipo].filter((c) => c.obrigatorio && !mapeamento[c.campo]).map((c) => c.rotulo);
  if (faltando.length) throw new ErroMigracao(`Escolha a coluna de: ${faltando.join(', ')}.`);
  const brutas = linhasMapeadas(s, mapeamento);
  // +2: linha 1 é o cabeçalho (como no Excel); ignora o título acima dele.
  const convertidos = brutas.map((l, i) => (tipo === 'produtos' ? converterProduto(l, i + 2) : converterCliente(l, i + 2)));
  const plano = tipo === 'produtos' ? planejarProdutos(convertidos) : planejarClientes(convertidos);
  return { s, mapeamento, plano };
}

function resumirPlano(tipo, plano) {
  const contar = (acao) => plano.filter((p) => p.acao === acao).length;
  const novos = plano.filter((p) => p.acao === 'novo');
  return {
    total: plano.length,
    novos: contar('novo'),
    atualizar: contar('atualizar'),
    erros: contar('erro'),
    comAviso: plano.filter((p) => p.acao !== 'erro' && p.avisos.length).length,
    estoqueInicial: tipo === 'produtos' ? novos.filter((p) => p.dados.estoque > 0).length : undefined,
    saldoFiadoTotal: tipo === 'clientes' ? Math.round(novos.reduce((t, p) => t + p.dados.saldoFiado, 0) * 100) / 100 : undefined,
  };
}

function previa({ token, tipo, mapeamento }) {
  try {
    const { plano, mapeamento: usado } = planejar(token, tipo, mapeamento);
    const exemplos = [
      ...plano.filter((p) => p.acao === 'erro').slice(0, 30),
      ...plano.filter((p) => p.acao !== 'erro').slice(0, 30),
    ].sort((a, b) => a.linha - b.linha);
    return {
      ok: true,
      mapeamento: usado,
      resumo: resumirPlano(tipo, plano),
      linhas: exemplos.map(({ linha, acao, erros, avisos, dados, existenteNome }) => ({ linha, acao, erros, avisos, dados, existenteNome: existenteNome || null })),
    };
  } catch (err) {
    if (err instanceof ErroMigracao) return { ok: false, error: err.message };
    throw err;
  }
}

// ---------------------------------------------------------------------
// Importação
// ---------------------------------------------------------------------

function findOrCreateSupplier(db, nome) {
  const existente = db.prepare('SELECT id FROM suppliers WHERE LOWER(nome) = LOWER(?)').get(nome);
  if (existente) return existente.id;
  const id = randomUUID();
  db.prepare('INSERT INTO suppliers (id, nome) VALUES (?, ?)').run(id, nome);
  return id;
}

function importarProdutos(plano, { locationId, operadorId, deviceId }) {
  const db = getDb();
  const productService = require('./productService');
  const r = { novos: 0, atualizados: 0, comEstoque: 0, erros: [] };
  for (const p of plano) {
    if (p.acao === 'erro') { r.erros.push({ linha: p.linha, erro: p.erros.join('; ') }); continue; }
    try {
      importarUmProduto(db, productService, p, r, { locationId, operadorId, deviceId });
    } catch (err) {
      // Falha de um comando só desfaz aquele comando (SQLite), não a
      // transação inteira: a linha vira erro e o resto segue.
      r.erros.push({ linha: p.linha, erro: err.message });
    }
  }
  return r;
}

function importarUmProduto(db, productService, p, r, { locationId, operadorId, deviceId }) {
  {
    const d = p.dados;
    const fornecedorId = d.fornecedor ? findOrCreateSupplier(db, d.fornecedor) : undefined;
    let payload;
    if (p.acao === 'atualizar') {
      const atual = db.prepare('SELECT * FROM products WHERE id = ?').get(p.existenteId);
      let customFields = {};
      try { customFields = JSON.parse(atual.custom_fields || '{}') || {}; } catch { customFields = {}; }
      // Só completa/atualiza o que veio no arquivo -- nunca apaga um campo
      // que já existia aqui só porque a coluna veio vazia lá.
      payload = {
        id: atual.id, nome: d.nome || atual.nome, preco: d.preco ?? atual.preco, custo: d.custo ?? atual.custo,
        sku: atual.sku || d.sku, codigoBarras: atual.codigo_barras || d.codigoBarras, categoria: atual.categoria || d.categoria,
        unidade: atual.unidade || d.unidade, estoqueMinimo: d.estoqueMinimo ?? atual.estoque_minimo,
        ncm: atual.ncm || d.ncm, cest: atual.cest, cfop: atual.cfop, cstCsosn: atual.cst_csosn,
        origemMercadoria: atual.origem_mercadoria, customFields, codigoBalanca: atual.codigo_balanca, tipo: atual.tipo,
        fornecedorId: atual.fornecedor_id || fornecedorId || null, operadorId,
      };
    } else {
      payload = {
        nome: d.nome, preco: d.preco, custo: d.custo ?? 0, sku: d.sku, codigoBarras: d.codigoBarras, categoria: d.categoria,
        unidade: d.unidade, estoqueMinimo: d.estoqueMinimo ?? 0, ncm: d.ncm, fornecedorId: fornecedorId || null, operadorId,
      };
    }
    const salvo = productService.upsert(payload);
    if (!salvo.ok) { r.erros.push({ linha: p.linha, erro: salvo.error }); return; }
    if (p.reativar) db.prepare('UPDATE products SET ativo = 1 WHERE id = ?').run(salvo.id);
    if (p.acao === 'novo') {
      r.novos += 1;
      if (d.estoque > 0) {
        const e = require('./stockService').adjustStock({
          productId: salvo.id, locationId, quantidade: d.estoque, tipo: 'entrada', motivo: 'Migração do sistema anterior', operadorId, deviceId,
        });
        if (e.ok) r.comEstoque += 1;
      }
    } else {
      r.atualizados += 1;
    }
  }
}

function importarClientes(plano, { operadorId }) {
  const db = getDb();
  const r = { novos: 0, atualizados: 0, comSaldo: 0, saldoTotal: 0, erros: [] };
  for (const p of plano) {
    if (p.acao === 'erro') { r.erros.push({ linha: p.linha, erro: p.erros.join('; ') }); continue; }
    const d = p.dados;
    if (p.acao === 'atualizar') {
      // Completa só o que está vazio aqui; saldo de quem já existe não
      // entra (o fiado dele já está sendo controlado neste sistema).
      db.prepare(
        `UPDATE customers SET telefone = COALESCE(NULLIF(telefone, ''), ?), cpf = COALESCE(NULLIF(cpf, ''), ?),
           cnpj = COALESCE(NULLIF(cnpj, ''), ?), data_nascimento = COALESCE(NULLIF(data_nascimento, ''), ?) WHERE id = ?`
      ).run(d.telefone, d.cpf, d.cnpj, d.dataNascimento, p.existenteId);
      r.atualizados += 1;
      continue;
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO customers (id, nome, telefone, cpf, cnpj, data_nascimento) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, d.nome, d.telefone, d.cpf, d.cnpj, d.dataNascimento);
    r.novos += 1;
    if (d.saldoFiado > 0) {
      db.prepare(
        `INSERT INTO customer_credit_movements (id, customer_id, tipo, valor, motivo, operador_id) VALUES (?, ?, 'divida', ?, ?, ?)`
      ).run(randomUUID(), id, d.saldoFiado, 'Saldo migrado do sistema anterior', operadorId);
      r.comSaldo += 1;
      r.saldoTotal = Math.round((r.saldoTotal + d.saldoFiado) * 100) / 100;
    }
  }
  return r;
}

/** Grava tudo numa transação: ou entra o arquivo inteiro (menos as linhas
 * com erro, listadas no relatório), ou nada. */
function importar({ token, tipo, mapeamento, operadorId, locationId, deviceId }) {
  try {
    const { s, plano } = planejar(token, tipo, mapeamento);
    if (!plano.some((p) => p.acao !== 'erro')) throw new ErroMigracao('Nenhuma linha válida para importar. Confira as colunas escolhidas.');
    const db = getDb();
    const loc = locationId || db.prepare('SELECT id FROM locations LIMIT 1').get()?.id;
    const resultado = db.transaction(() => (tipo === 'produtos'
      ? importarProdutos(plano, { locationId: loc, operadorId, deviceId })
      : importarClientes(plano, { operadorId })))();
    sessoes.delete(token);

    const partes = tipo === 'produtos'
      ? [`${resultado.novos} produto(s) novo(s)`, `${resultado.atualizados} atualizado(s)`, `${resultado.comEstoque} com estoque inicial`]
      : [`${resultado.novos} cliente(s) novo(s)`, `${resultado.atualizados} completado(s)`, `${resultado.comSaldo} com saldo de fiado (R$ ${resultado.saldoTotal.toFixed(2).replace('.', ',')})`];
    require('./authService').registrarEventoAuditoria({
      tipoEvento: 'migracao_sistema_anterior', solicitanteId: operadorId,
      motivo: `${tipo === 'produtos' ? 'Produtos' : 'Clientes'} do arquivo ${s.arquivo}: ${partes.join(', ')}${resultado.erros.length ? `, ${resultado.erros.length} linha(s) com erro` : ''}`,
    });
    return { ok: true, tipo, ...resultado, erros: resultado.erros.slice(0, 200), totalErros: resultado.erros.length };
  } catch (err) {
    if (err instanceof ErroMigracao) return { ok: false, error: err.message };
    throw err;
  }
}

module.exports = {
  CAMPOS, abrir, sugerirComIA, previa, importar,
  // Exportados pra teste.
  lerCsv, decodificar, lerNumero, lerCodigo, lerData, lerUnidade, separarCabecalho, sugerirMapeamento, validarMapeamento,
  mascarar, amostrasPorColuna, sugerirTipo,
};
