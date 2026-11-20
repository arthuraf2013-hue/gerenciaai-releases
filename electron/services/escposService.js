const net = require('net');

/**
 * Impressora térmica de REDE (ESC/POS pela porta 9100, sem driver) -- usada
 * pela impressora da cozinha (cozinhaService.js) quando ela fica ligada no
 * roteador. A impressora instalada no Windows continua indo pelo caminho de
 * sempre (HTML + webContents.print).
 *
 * Comandos usados são os do padrão Epson, que Elgin, Bematech, Daruma,
 * Tanca, Knup e as genéricas aceitam: ESC @ (reinicia), ESC t (tabela de
 * caracteres), ESC a (alinhamento), ESC E (negrito), GS ! (tamanho) e
 * GS V 66 (corte parcial depois de avançar o papel).
 *
 * Acentos: a impressora não entende UTF-8. Cada caractere vira o byte da
 * tabela escolhida -- CP860 (português, ESC t 3) por padrão, CP850 (ESC t 2)
 * para modelos que não têm a 860 --; o que não existe na tabela sai sem
 * acento. "sem_acento" tira todos (impressora que imprime lixo nas duas).
 */

const TABELAS = {
  cp850: {
    escT: 2,
    mapa: {
      'Ç': 0x80, 'ü': 0x81, 'é': 0x82, 'â': 0x83, 'ä': 0x84, 'à': 0x85, 'ç': 0x87, 'ê': 0x88, 'ë': 0x89, 'è': 0x8a,
      'ï': 0x8b, 'î': 0x8c, 'ì': 0x8d, 'Ä': 0x8e, 'É': 0x90, 'ô': 0x93, 'ö': 0x94, 'ò': 0x95, 'û': 0x96, 'ù': 0x97,
      'Ö': 0x99, 'Ü': 0x9a, 'á': 0xa0, 'í': 0xa1, 'ó': 0xa2, 'ú': 0xa3, 'ñ': 0xa4, 'Ñ': 0xa5, 'ª': 0xa6, 'º': 0xa7,
      'Á': 0xb5, 'Â': 0xb6, 'À': 0xb7, 'ã': 0xc6, 'Ã': 0xc7, 'Ê': 0xd2, 'Ë': 0xd3, 'È': 0xd4, 'Í': 0xd6, 'Î': 0xd7,
      'Ï': 0xd8, 'Ì': 0xde, 'Ó': 0xe0, 'Ô': 0xe2, 'Ò': 0xe3, 'õ': 0xe4, 'Õ': 0xe5, 'Ú': 0xe9, 'Û': 0xea, 'Ù': 0xeb, '°': 0xf8,
    },
  },
  cp860: {
    escT: 3,
    mapa: {
      'Ç': 0x80, 'ü': 0x81, 'é': 0x82, 'â': 0x83, 'ã': 0x84, 'à': 0x85, 'Á': 0x86, 'ç': 0x87, 'ê': 0x88, 'Ê': 0x89,
      'è': 0x8a, 'Í': 0x8b, 'Ô': 0x8c, 'ì': 0x8d, 'Ã': 0x8e, 'Â': 0x8f, 'É': 0x90, 'À': 0x91, 'È': 0x92, 'ô': 0x93,
      'õ': 0x94, 'ò': 0x95, 'Ú': 0x96, 'ù': 0x97, 'Ì': 0x98, 'Õ': 0x99, 'Ü': 0x9a, 'Ù': 0x9d, 'Ó': 0x9f, 'á': 0xa0,
      'í': 0xa1, 'ó': 0xa2, 'ú': 0xa3, 'ñ': 0xa4, 'Ñ': 0xa5, 'ª': 0xa6, 'º': 0xa7, 'Ò': 0xa9, '°': 0xf8,
    },
  },
};

const ESC = 0x1b;
const GS = 0x1d;

function semAcento(c) {
  return c.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Texto -> bytes na tabela escolhida. Controle e emoji somem. */
function codificar(texto, codepage = 'cp860') {
  const tabela = TABELAS[codepage];
  const bytes = [];
  for (const c of String(texto ?? '')) {
    const code = c.codePointAt(0);
    if (code === 0x0a) { bytes.push(0x0a); continue; }
    if (code < 0x20 || code === 0x7f) continue;
    if (code < 0x80) { bytes.push(code); continue; }
    if (tabela && tabela.mapa[c] != null) { bytes.push(tabela.mapa[c]); continue; }
    // Sem equivalente na tabela: sai sem acento; emoji/símbolo some.
    for (const s of semAcento(c)) {
      const sc = s.codePointAt(0);
      if (sc >= 0x20 && sc < 0x7f) bytes.push(sc);
    }
  }
  return bytes;
}

/** Quebra o texto em linhas de até `colunas` caracteres (por palavra). */
function quebrarLinhas(texto, colunas) {
  const linhas = [];
  for (const paragrafo of String(texto ?? '').split('\n')) {
    let atual = '';
    for (const palavra of paragrafo.split(/\s+/).filter(Boolean)) {
      if (!atual) { atual = palavra; } else if ((atual + ' ' + palavra).length <= colunas) { atual += ` ${palavra}`; } else { linhas.push(atual); atual = palavra; }
      while (atual.length > colunas) { linhas.push(atual.slice(0, colunas)); atual = atual.slice(colunas); }
    }
    linhas.push(atual);
  }
  return linhas;
}

/** Colunas da fonte normal: 48 no rolo de 80 mm, 32 no de 58 mm. */
function colunasDa(largura) {
  return Number(largura) === 58 ? 32 : 48;
}

/**
 * Comanda da cozinha em ESC/POS. `comanda` vem de cozinhaService:
 * { mesa, titulo, subtitulo, hora, operador, itens: [{ quantidade, unidade, nome, precoUnitario, pessoa, observacao }],
 *   rodape, layout } -- `layout` é a configuração do estúdio (impressaoLayout.PADRAO.cozinha).
 */
function montarComandaEscPos(comanda, { largura = 80, codepage = 'cp860', cortar = true } = {}) {
  const layout = require('./impressaoLayout');
  const c = layout.normalizarConfig('cozinha', comanda.layout || {});
  const cp = TABELAS[codepage] ? codepage : null;
  const col = colunasDa(largura);
  const metade = Math.floor(col / 2);
  const b = [];
  const txt = (t) => b.push(...codificar(t, cp || 'sem_acento'));
  const nl = () => b.push(0x0a);
  const alinhar = (n) => b.push(ESC, 0x61, n);
  const negrito = (on) => b.push(ESC, 0x45, on ? 1 : 0);
  const tamanho = (n) => b.push(GS, 0x21, n); // 0x00 normal, 0x11 dobro, 0x01 altura dobrada
  const traco = () => { txt((c.separador === 'continuo' ? '_' : '-').repeat(col)); nl(); };
  const dinheiro = (v) => `R$ ${(Number(v) || 0).toFixed(2).replace('.', ',')}`;
  // Texto à esquerda e valor à direita na mesma linha (quebra o texto se precisar).
  const comValor = (texto, valor, larguraTexto = col) => {
    const v = valor ? ` ${valor}` : '';
    const linhas = quebrarLinhas(texto, Math.max(8, larguraTexto - v.length));
    linhas.forEach((l, k) => {
      if (k === linhas.length - 1 && v) txt(l + ' '.repeat(Math.max(1, larguraTexto - l.length - v.length)) + v.trimStart().padStart(v.length));
      else txt(l);
      nl();
    });
  };

  b.push(ESC, 0x40);
  if (cp) b.push(ESC, 0x74, TABELAS[cp].escT);

  alinhar(1);
  negrito(true);
  if (c.titulo) { for (const l of quebrarLinhas(c.titulo, col)) { txt(l); nl(); } }
  const temMesa = c.mostrarMesa && comanda.mesa;
  const destaque = temMesa ? comanda.mesa : (comanda.titulo || 'COMANDA');
  const tam = temMesa ? ({ normal: 0x01, grande: 0x11, enorme: 0x22 }[c.mesaTamanho] || 0x11) : 0x11;
  const porLinha = tam === 0x22 ? Math.floor(col / 3) : tam === 0x11 ? metade : col;
  if (temMesa && !c.mesaNegrito) negrito(false);
  tamanho(tam);
  for (const l of quebrarLinhas(destaque, porLinha)) { txt(l); nl(); }
  tamanho(0x00);
  negrito(true);
  if (temMesa && comanda.titulo && comanda.titulo !== comanda.mesa) { tamanho(0x01); txt(comanda.titulo); nl(); tamanho(0x00); }
  if (c.mostrarCliente && comanda.subtitulo) { for (const l of quebrarLinhas(comanda.subtitulo, col)) { txt(l); nl(); } }
  negrito(false);
  const info = [c.mostrarDataHora && comanda.hora ? comanda.hora : '', c.mostrarOperador && comanda.operador ? `Atendente: ${comanda.operador}` : ''].filter(Boolean).join(' - ');
  if (info) { for (const l of quebrarLinhas(info, col)) { txt(l); nl(); } }
  alinhar(0);
  traco();

  // Letra dos itens: grande = altura dupla; normal/pequena = normal.
  const alturaItem = c.tamanho === 'grande' ? 0x01 : 0x00;
  for (const item of comanda.itens || []) {
    negrito(true);
    tamanho(alturaItem);
    const qtd = `${layout.qtdDaComanda(item.quantidade, item.unidade)} `;
    const valorNum = c.mostrarValores && item.precoUnitario !== null && item.precoUnitario !== undefined && Number.isFinite(Number(item.precoUnitario))
      ? Math.round(Number(item.precoUnitario) * (Number(item.quantidade) || 0) * 100) / 100 : null;
    comValor(qtd + String(item.nome || ''), valorNum !== null ? dinheiro(valorNum) : '');
    tamanho(0x00);
    negrito(false);
    const detalhe = c.mostrarValores ? layout.detalheDoValor(item) : '';
    if (detalhe) { for (const l of quebrarLinhas(`   ${detalhe}`, col)) { txt(l); nl(); } }
    if (c.mostrarPessoa && item.pessoa) { for (const l of quebrarLinhas(`   para: ${item.pessoa}`, col)) { txt(l); nl(); } }
    if (c.mostrarObservacoes && item.observacao) {
      negrito(true);
      for (const l of quebrarLinhas(`   >> ${item.observacao}`, col)) { txt(l); nl(); }
      negrito(false);
    }
    traco();
  }
  if (c.mostrarValores && c.mostrarTotal && (comanda.itens || []).some((i) => i.precoUnitario !== null && i.precoUnitario !== undefined)) {
    negrito(true);
    alinhar(2);
    txt(`Total desta comanda: ${dinheiro(layout.totalDaComanda(comanda.itens))}`); nl();
    alinhar(0);
    negrito(false);
  }
  for (const r of [comanda.rodape, c.rodape].filter(Boolean)) { alinhar(1); for (const l of quebrarLinhas(r, col)) { txt(l); nl(); } alinhar(0); }
  if (cortar) {
    b.push(GS, 0x56, 66, 3); // avança 3 linhas e corta (parcial)
  } else {
    nl(); nl(); nl(); nl();
  }
  return Buffer.from(b);
}

function formatarQtd(q) {
  const n = Number(q) || 0;
  return Number.isInteger(n) ? `${n}x` : `${n.toLocaleString('pt-BR', { maximumFractionDigits: 3 })}`;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
function enderecoValido(ip) {
  return IPV4.test(String(ip || '').trim());
}

/** Manda os bytes para IP:porta. Resolve quando a impressora fecha/aceita;
 * rejeita com mensagem legível (desligada, IP errado, sem papel travando). */
function enviarParaRede({ ip, porta = 9100, dados, timeoutMs = 6000, conectar = net.connect }) {
  return new Promise((resolve, reject) => {
    if (!enderecoValido(ip)) { reject(new Error('IP da impressora da cozinha inválido.')); return; }
    let terminou = false;
    const fim = (err) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* já fechado */ }
      if (err) reject(err); else resolve({ ok: true });
    };
    const socket = conectar({ host: String(ip).trim(), port: Number(porta) || 9100 });
    const timer = setTimeout(() => fim(new Error(`A impressora da cozinha (${ip}) não respondeu. Confira se está ligada e no mesmo Wi-Fi/rede.`)), timeoutMs);
    socket.on('error', (err) => fim(new Error(
      err?.code === 'ECONNREFUSED' ? `A impressora em ${ip} recusou a conexão (porta ${porta}).`
        : err?.code === 'EHOSTUNREACH' || err?.code === 'ENETUNREACH' ? `Não encontrei a impressora em ${ip}. Confira o IP e a rede.`
          : `Falha ao falar com a impressora da cozinha: ${err?.message || err}`,
    )));
    socket.on('connect', () => {
      socket.write(dados, (err) => {
        if (err) { fim(err); return; }
        socket.end();
        // Algumas impressoras não fecham a conexão: dá 400 ms para o envio terminar.
        setTimeout(() => fim(null), 400);
      });
    });
    socket.on('close', () => fim(null));
  });
}

module.exports = { codificar, quebrarLinhas, colunasDa, montarComandaEscPos, enviarParaRede, enderecoValido, TABELAS };
