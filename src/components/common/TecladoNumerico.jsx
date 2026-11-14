import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useToque } from '../../context/ToqueContext';
import { aplicarTecla, campoNumerico, iniciarTeclado, valorParaCampo } from '../../utils/toque';
import Icon from './Icon';

// Teclado numérico da tela, para o modo toque.
//
// Um só para o app inteiro: escuta o foco do documento e aparece ao lado
// de qualquer campo de número (PIN, quantidade, valor, peso, preço) sem
// cada tela precisar saber dele. O campo continua sendo o de sempre --
// o teclado só escreve nele como se a pessoa tivesse digitado, então
// validação, onChange e máscara de cada tela seguem valendo.
//
// Campo que não quer o teclado: data-sem-teclado.
// Campo em que o OK deve enviar o formulário (PIN do login): data-teclado-enviar="Entrar".
// Teclado encostado na borda direita em vez de ao lado do campo: data-teclado-ancora="direita".

const LARGURA = 264;
const MARGEM = 8;
const setValorNativo = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

function escreverNoCampo(el, valor) {
  setValorNativo.call(el, valor);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function cfgDoCampo(el) {
  if (!(el instanceof HTMLInputElement) || 'semTeclado' in el.dataset) return null;
  return campoNumerico({
    tag: el.tagName, type: el.type, inputMode: el.getAttribute('inputmode'),
    step: el.getAttribute('step'), readOnly: el.readOnly, disabled: el.disabled,
  });
}

/**
 * O campo que vem logo depois no mesmo formulário, se também for de número
 * (PIN atual -> novo PIN -> confirmar; preço -> custo). Campo de texto no
 * meio do caminho para: o OK só fecha, para não abrir o teclado do Windows
 * de surpresa.
 */
function proximoCampoNumerico(el) {
  const raiz = el.form || el.closest('.modal-card, form, .screen');
  if (!raiz) return null;
  const campos = [...raiz.querySelectorAll('input, select, textarea')]
    .filter((c) => c.type !== 'hidden' && !c.disabled && c.offsetParent !== null);
  const seguinte = campos[campos.indexOf(el) + 1];
  return seguinte && cfgDoCampo(seguinte) ? seguinte : null;
}

function rotuloDoCampo(el) {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  const label = el.labels?.[0];
  const primeiroTexto = label && [...label.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
  const texto = (primeiroTexto?.textContent || el.placeholder || '').trim();
  return texto.length > 40 ? `${texto.slice(0, 38)}…` : texto;
}

/**
 * Ao lado do campo (direita, esquerda), senão embaixo ou em cima -- sem
 * tampar o que se digita. ancora="direita": encostado na borda direita da
 * janela (quantidade do PDV: o dedo vai direto para o produto depois).
 */
function posicionar(r, largura, altura, ancora, lado = r) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const limitarTopo = (t) => Math.min(Math.max(t, MARGEM), vh - altura - MARGEM);
  const limitarEsq = (l) => Math.min(Math.max(l, MARGEM), vw - largura - MARGEM);
  if (ancora === 'direita') return { left: vw - largura - MARGEM * 2, top: limitarTopo(r.bottom + MARGEM) };
  // `lado`: a janela (modal) em que o campo está -- o teclado fica do lado
  // de FORA dela, para não tampar o resumo e os botões da própria janela.
  if (lado.right + MARGEM + largura <= vw - MARGEM) return { left: lado.right + MARGEM, top: limitarTopo(r.top - 40) };
  if (lado.left - MARGEM - largura >= MARGEM) return { left: lado.left - MARGEM - largura, top: limitarTopo(r.top - 40) };
  if (lado !== r) return posicionar(r, largura, altura, ancora, r);
  if (r.bottom + MARGEM + altura <= vh - MARGEM) return { left: limitarEsq(r.left), top: r.bottom + MARGEM };
  if (r.top - MARGEM - altura >= MARGEM) return { left: limitarEsq(r.left), top: r.top - MARGEM - altura };
  // Não cabe inteiro em lugar nenhum (tela baixa, 1024x768): encosta na
  // borda do lado que tem mais espaço livre -- tampa o mínimo do campo,
  // em vez de cair em cima dele.
  const embaixo = vh - r.bottom >= r.top;
  const left = vw - r.right >= r.left ? vw - largura - MARGEM : MARGEM;
  return { left, top: embaixo ? limitarTopo(r.bottom + MARGEM) : MARGEM };
}

export function TecladoNumerico() {
  const { ativo } = useToque();
  const [alvo, setAlvo] = useState(null);
  const [estado, setEstado] = useState({ texto: '', substituir: false });
  const [pos, setPos] = useState(null);
  const caixa = useRef(null);
  const alvoRef = useRef(null);
  const ultimoValor = useRef('');
  const dispensadoEm = useRef(null);

  alvoRef.current = alvo;

  // Quem ganha o teclado: qualquer <input> de número que recebe o foco.
  useEffect(() => {
    if (!ativo) { setAlvo(null); return undefined; }

    function abrir(el) {
      if (!el || caixa.current?.contains(el)) return;
      const cfg = cfgDoCampo(el);
      if (!cfg) { setAlvo(null); return; }
      if (dispensadoEm.current === el) return; // a pessoa escondeu neste campo
      dispensadoEm.current = null;
      ultimoValor.current = el.value;
      setEstado(iniciarTeclado(el.value));
      setAlvo({
        el, decimal: cfg.decimal, casas: cfg.casas,
        maxLength: el.maxLength > 0 ? el.maxLength : undefined,
        enviar: el.dataset.tecladoEnviar || null,
        senha: el.type === 'password',
        ancora: el.dataset.tecladoAncora || null,
        proximo: !el.dataset.tecladoEnviar && !!proximoCampoNumerico(el),
        rotulo: rotuloDoCampo(el),
      });
    }

    const aoFocar = (e) => abrir(e.target);

    function aoSair() {
      // Espera o foco assentar: indo para outro campo numérico, abrir()
      // já trocou o alvo; indo para o próprio teclado, fica.
      setTimeout(() => {
        const atual = document.activeElement;
        if (caixa.current?.contains(atual)) return;
        if (atual !== dispensadoEm.current) dispensadoEm.current = null;
        setAlvo((a) => (a && a.el === atual ? a : null));
      }, 0);
    }

    // Escondeu e tocou de novo no mesmo campo (que continua com o foco,
    // então não há focusin): o teclado volta.
    function aoTocar(e) {
      if (e.target === dispensadoEm.current && e.target === document.activeElement) {
        dispensadoEm.current = null;
        abrir(e.target);
      }
    }

    document.addEventListener('focusin', aoFocar);
    document.addEventListener('focusout', aoSair);
    document.addEventListener('pointerdown', aoTocar);
    // Campo com autoFocus (PIN do login) ganhou o foco antes deste efeito.
    abrir(document.activeElement);
    return () => {
      document.removeEventListener('focusin', aoFocar);
      document.removeEventListener('focusout', aoSair);
      document.removeEventListener('pointerdown', aoTocar);
    };
  }, [ativo]);

  // Enquanto o nosso teclado está aberto, o do Windows não sobe por cima.
  // Quem digita no teclado físico continua podendo: o visor acompanha.
  useEffect(() => {
    if (!alvo) return undefined;
    const { el } = alvo;
    const original = el.getAttribute('inputmode');
    el.setAttribute('inputmode', 'none');
    function aoDigitarFora() {
      if (el.value === ultimoValor.current) return;
      ultimoValor.current = el.value;
      setEstado({ texto: iniciarTeclado(el.value).texto, substituir: false });
    }
    el.addEventListener('input', aoDigitarFora);
    return () => {
      el.removeEventListener('input', aoDigitarFora);
      if (original === null) el.removeAttribute('inputmode');
      else el.setAttribute('inputmode', original);
    };
  }, [alvo]);

  const reposicionar = useCallback(() => {
    const a = alvoRef.current;
    if (!a || !caixa.current) return;
    if (!a.el.isConnected) { setAlvo(null); return; }
    const janela = a.el.closest('.modal-card');
    const r = a.el.getBoundingClientRect();
    setPos(posicionar(r, LARGURA, caixa.current.offsetHeight, a.ancora, janela ? janela.getBoundingClientRect() : r));
  }, []);

  useLayoutEffect(() => { if (alvo) reposicionar(); else setPos(null); }, [alvo, reposicionar]);

  useEffect(() => {
    if (!alvo) return undefined;
    window.addEventListener('resize', reposicionar);
    document.addEventListener('scroll', reposicionar, true);
    return () => {
      window.removeEventListener('resize', reposicionar);
      document.removeEventListener('scroll', reposicionar, true);
    };
  }, [alvo, reposicionar]);

  if (!alvo) return null;

  function teclar(tecla) {
    const { el } = alvo;
    // O app mexeu no valor por fora (ex.: recusou a letra) -- segue dele.
    const base = el.value === ultimoValor.current ? estado : { texto: iniciarTeclado(el.value).texto, substituir: false };
    const novo = aplicarTecla(base, tecla, { decimal: alvo.decimal, casas: alvo.casas, maxLength: alvo.maxLength });
    setEstado(novo);
    const valor = valorParaCampo(novo.texto, el.type);
    ultimoValor.current = valor;
    if (el.value !== valor) escreverNoCampo(el, valor);
    if (document.activeElement !== el) el.focus({ preventScroll: true });
  }

  function confirmar() {
    const { el } = alvo;
    if (alvo.enviar && el.form) {
      el.form.requestSubmit();
      return;
    }
    const seguinte = proximoCampoNumerico(el);
    if (seguinte) {
      seguinte.focus(); // o focusin leva o teclado para ele
      return;
    }
    el.blur();
    setAlvo(null);
  }

  function esconder() {
    dispensadoEm.current = alvo.el;
    setAlvo(null);
  }

  const segurarFoco = (e) => e.preventDefault();

  return (
    <div
      ref={caixa}
      className="teclado-numerico"
      role="group"
      aria-label={`Teclado numérico${alvo.rotulo ? `: ${alvo.rotulo}` : ''}`}
      style={pos ? { left: pos.left, top: pos.top, width: LARGURA } : { left: -9999, top: 0, width: LARGURA }}
      onPointerDown={segurarFoco}
      onMouseDown={segurarFoco}
    >
      <TecladoPainel
        rotulo={alvo.rotulo || 'Número'} onEsconder={esconder}
        texto={estado.texto} substituir={estado.substituir} senha={alvo.senha} decimal={alvo.decimal}
        okRotulo={alvo.enviar || (alvo.proximo ? 'Próximo' : 'OK')}
        onTecla={teclar} onOk={confirmar}
      />
    </div>
  );
}

/**
 * As teclas, o visor e o OK -- o mesmo desenho no teclado que flutua ao
 * lado do campo e no que fica embutido na tela (login no modo toque).
 * Botões não roubam o foco do campo.
 */
export function TecladoPainel({ rotulo, onEsconder, texto, substituir = false, senha = false, decimal = false, okRotulo = 'OK', onTecla, onOk }) {
  const segurarFoco = (e) => e.preventDefault();
  const botao = (tecla, conteudo, extra = {}) => (
    <button type="button" tabIndex={-1} key={tecla} className={extra.className || 'teclado-tecla'}
      aria-label={extra.rotulo} onPointerDown={segurarFoco} onMouseDown={segurarFoco}
      onClick={extra.onClick || (() => onTecla(tecla))}>{conteudo}</button>
  );
  const visor = texto === ''
    ? <span className="teclado-visor-vazio">{decimal ? '0,00' : '—'}</span>
    : senha ? '•'.repeat(texto.length) : texto;

  return (
    <>
      {(rotulo || onEsconder) && (
        <div className="teclado-topo">
          <span className="teclado-rotulo">{rotulo}</span>
          {onEsconder && botao('esconder', <Icon name="close" size={16} />, { className: 'teclado-esconder', rotulo: 'Esconder o teclado', onClick: onEsconder })}
        </div>
      )}
      <div className={substituir ? 'teclado-visor teclado-visor-substituir' : 'teclado-visor'} aria-live="polite">{visor}</div>
      <div className="teclado-grade">
        {['7', '8', '9', '4', '5', '6', '1', '2', '3'].map((n) => botao(n, n))}
        {decimal ? botao(',', ',', { rotulo: 'Vírgula' }) : botao('limpar', 'C', { className: 'teclado-tecla teclado-limpar', rotulo: 'Limpar' })}
        {botao('0', '0')}
        {botao('apagar', <Icon name="backspace" size={20} />, { className: 'teclado-tecla teclado-apagar', rotulo: 'Apagar' })}
        {decimal && botao('limpar', 'C', { className: 'teclado-tecla teclado-limpar', rotulo: 'Limpar' })}
        {botao('ok', okRotulo, { className: decimal ? 'teclado-ok' : 'teclado-ok teclado-ok-largo', onClick: onOk })}
      </div>
    </>
  );
}
