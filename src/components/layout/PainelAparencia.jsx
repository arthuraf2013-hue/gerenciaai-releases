import { useEffect, useRef } from 'react';
import { usePreferencias } from '../../context/PreferenciasContext';
import { useToque } from '../../context/ToqueContext';
import { useEscToClose } from '../../hooks/useEscToClose';
import { proximoZoom, ZOOM_OPCOES } from '../../utils/preferencias';

function Opcoes({ valor, opcoes, onChange, rotulo }) {
  return (
    <div className="aparencia-opcoes" role="radiogroup" aria-label={rotulo}>
      {opcoes.map(([v, texto]) => (
        <button type="button" key={String(v)} role="radio" aria-checked={valor === v}
          className={valor === v ? 'ativo' : undefined} onClick={() => onChange(v)}>{texto}</button>
      ))}
    </div>
  );
}

/**
 * "Aparência" (rodapé do menu): letra, densidade, tema e o jeito do PDV,
 * tudo salvo por usuário (PreferenciasContext). Muda na hora, sem salvar.
 */
export function PainelAparencia({ onClose }) {
  const { prefs, atualizar, densidade } = usePreferencias();
  const toque = useToque();
  const caixa = useRef(null);
  useEscToClose(onClose);

  useEffect(() => {
    function fora(e) {
      if (caixa.current?.contains(e.target)) return;
      if (e.target.closest?.('.sidebar-footer-actions')) return; // o próprio botão alterna
      onClose();
    }
    document.addEventListener('pointerdown', fora);
    return () => document.removeEventListener('pointerdown', fora);
  }, [onClose]);

  const zoom = prefs.visual.zoom;
  const tema = prefs.visual.tema || (document.documentElement.getAttribute('data-theme') === 'dark' ? 'escuro' : 'claro');

  return (
    <div className="painel-aparencia" ref={caixa} role="dialog" aria-label="Aparência">
      <div className="aparencia-linha">
        <span>Tamanho da letra</span>
        <div className="aparencia-zoom">
          <button type="button" onClick={() => atualizar('visual', { zoom: proximoZoom(zoom, -1) })} disabled={zoom === ZOOM_OPCOES[0]} aria-label="Diminuir a letra">A−</button>
          <strong>{Math.round(zoom * 100)}%</strong>
          <button type="button" onClick={() => atualizar('visual', { zoom: proximoZoom(zoom, +1) })} disabled={zoom === ZOOM_OPCOES[ZOOM_OPCOES.length - 1]} aria-label="Aumentar a letra">A+</button>
        </div>
      </div>
      <div className="aparencia-linha">
        <span>Espaçamento</span>
        <Opcoes rotulo="Espaçamento" valor={prefs.visual.densidade} onChange={(v) => atualizar('visual', { densidade: v })}
          opcoes={[['auto', 'Automático'], ['confortavel', 'Confortável'], ['compacta', 'Compacto']]} />
        {toque.ativo ? (
          <small>Na tela de toque fica sempre confortável.</small>
        ) : prefs.visual.densidade === 'auto' && (
          <small>Agora: {densidade === 'compacta' ? 'compacto (tela de notebook)' : 'confortável'}</small>
        )}
      </div>
      <div className="aparencia-linha">
        <span>Tela de toque</span>
        <Opcoes rotulo="Tela de toque" valor={toque.modo} onChange={toque.definirModo}
          opcoes={[['auto', 'Automático'], ['sim', 'Ligado'], ['nao', 'Desligado']]} />
        <small>
          {toque.modo === 'auto' && (toque.ativo ? 'Agora: ligado (tela de toque encontrada). ' : 'Agora: desligado (mouse). ')}
          Botões maiores e teclado de números na tela. Vale para este computador, para todos os usuários.
        </small>
      </div>
      <div className="aparencia-linha">
        <span>Tema</span>
        <Opcoes rotulo="Tema" valor={tema} onChange={(v) => atualizar('visual', { tema: v })}
          opcoes={[['claro', 'Claro'], ['escuro', 'Escuro']]} />
      </div>
      <hr />
      <div className="aparencia-linha">
        <span>Categorias no PDV</span>
        <Opcoes rotulo="Categorias no PDV" valor={prefs.pdv.categorias} onChange={(v) => atualizar('pdv', { categorias: v })}
          opcoes={[['faixa', 'Botões'], ['suspenso', 'Lista'], ['oculto', 'Ocultas']]} />
      </div>
      <label className="aparencia-check">
        <input type="checkbox" checked={prefs.pdv.recentes} onChange={(e) => atualizar('pdv', { recentes: e.target.checked })} />
        Mostrar "Vendidos recentemente" no PDV
      </label>
      <p className="aparencia-dica">O resto vale só para o seu usuário: quem entrar depois vê do jeito dele.</p>
    </div>
  );
}
