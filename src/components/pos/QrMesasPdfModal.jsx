import { useEffect, useMemo, useState } from 'react';
import Icon from '../common/Icon';
import { useEscToClose } from '../../hooks/useEscToClose';

// "QR das mesas": escolhe as mesas, quantos QR por folha, papel e orientação,
// e gera o PDF (para imprimir onde quiser) ou manda direto para a impressora.
// Cada QR abre a vitrine SÓ daquela mesa (vitrineService.gerarPdfQrMesas).
// A aparência (cor, logo, textos) vem do Estúdio de impressão -> Display da mesa.

const POR_FOLHA = [1, 2, 4, 6, 8, 9, 12, 16];
const PAPEIS = [['a4', 'A4'], ['carta', 'Carta'], ['oficio', 'Ofício'], ['a6', 'A6 (1 por folha)'], ['termica', 'Térmica 80 mm (1 por cupom)']];
// Mesma grade do impressaoLayout.medidasDoCartao.
const GRADE = {
  paisagem: { 1: '1 × 1', 2: '2 × 1', 4: '2 × 2', 6: '3 × 2', 8: '4 × 2', 9: '3 × 3', 12: '4 × 3', 16: '4 × 4' },
  retrato: { 1: '1 × 1', 2: '1 × 2', 4: '2 × 2', 6: '2 × 3', 8: '2 × 4', 9: '3 × 3', 12: '3 × 4', 16: '4 × 4' },
};

export function QrMesasPdfModal({ onFechar, mesaInicial = null, onAbrirEstudio }) {
  useEscToClose(onFechar, true);
  const [dados, setDados] = useState(null);
  const [escolhidas, setEscolhidas] = useState(new Set());
  const [porFolha, setPorFolha] = useState(6);
  const [papel, setPapel] = useState('a4');
  const [orientacao, setOrientacao] = useState('paisagem');
  const [ocupado, setOcupado] = useState('');
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    window.pdv.vitrine.qrDasMesas().then((r) => {
      setDados(r);
      if (r?.ok) setEscolhidas(new Set(mesaInicial ? [mesaInicial] : r.mesas.map((m) => m.tableId)));
    });
    window.pdv.estudio?.get?.().then((e) => {
      if (!e?.ok || !e.qrmesa) return;
      setPorFolha(e.qrmesa.porFolha); setPapel(e.qrmesa.papel); setOrientacao(e.qrmesa.orientacao);
    }).catch(() => {});
  }, [mesaInicial]);

  const umPorFolha = papel === 'a6' || papel === 'termica';
  const porPagina = umPorFolha ? 1 : porFolha;
  const folhas = Math.ceil(escolhidas.size / porPagina) || 0;
  const todas = useMemo(() => dados?.ok && escolhidas.size === dados.mesas.length, [dados, escolhidas]);

  function alternar(id) {
    setEscolhidas((atual) => {
      const nova = new Set(atual);
      if (nova.has(id)) nova.delete(id); else nova.add(id);
      return nova;
    });
  }

  async function gerar(tipo) {
    setMsg(null);
    setOcupado(tipo);
    const payload = { tableIds: [...escolhidas], porFolha, papel, orientacao };
    const r = await (tipo === 'pdf' ? window.pdv.vitrine.gerarPdfQrMesas(payload) : window.pdv.vitrine.imprimirQrMesas(payload))
      .catch((e) => ({ ok: false, error: e?.message }));
    setOcupado('');
    if (r?.cancelado) return;
    if (!r?.ok) return setMsg({ erro: true, texto: r?.error || 'Não deu certo.' });
    setMsg({ texto: tipo === 'pdf'
      ? `PDF pronto: ${r.quantidade} QR em ${r.folhas} folha(s). Salvo em ${r.caminho}`
      : `Enviado para a impressão: ${r.quantidade} QR.` });
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card qr-pdf-modal" role="dialog" aria-label="QR das mesas">
        <h2><Icon name="mobile" size={18} /> QR das mesas</h2>
        <p className="screen-hint">Cada QR abre a vitrine só daquela mesa: o cliente informa o nome e o pedido chega no caixa já com a mesa. Recorte e cole na mesa.</p>
        {!dados && <p className="empty-state">Carregando as mesas...</p>}
        {dados && !dados.ok && <p className="modal-error">{dados.error}</p>}
        {dados?.ok && (
          <>
            {!dados.pedidosOnline && <p className="modal-error">Ligue "Receber os pedidos direto no sistema" em Configurações → Vitrine online para os QR funcionarem.</p>}
            <div className="qr-pdf-opcoes">
              <label>QR por folha
                <select value={umPorFolha ? 1 : porFolha} disabled={umPorFolha} onChange={(e) => setPorFolha(Number(e.target.value))}>
                  {POR_FOLHA.map((n) => <option key={n} value={n}>{n} ({GRADE[orientacao][n]})</option>)}
                </select>
              </label>
              <label>Papel
                <select value={papel} onChange={(e) => setPapel(e.target.value)}>
                  {PAPEIS.map(([v, r]) => <option key={v} value={v}>{r}</option>)}
                </select>
              </label>
              <label>Folha
                <select value={orientacao} disabled={umPorFolha} onChange={(e) => setOrientacao(e.target.value)}>
                  <option value="paisagem">Deitada (paisagem)</option>
                  <option value="retrato">Em pé (retrato)</option>
                </select>
              </label>
            </div>
            <div className="qr-pdf-mesas-topo">
              <strong>Mesas ({escolhidas.size} de {dados.mesas.length})</strong>
              <button type="button" className="btn-link" onClick={() => setEscolhidas(new Set(todas ? [] : dados.mesas.map((m) => m.tableId)))}>
                {todas ? 'Desmarcar todas' : 'Marcar todas'}
              </button>
            </div>
            <div className="qr-pdf-mesas">
              {dados.mesas.map((m) => (
                <label key={m.tableId} className={escolhidas.has(m.tableId) ? 'qr-pdf-mesa qr-pdf-mesa-ativa' : 'qr-pdf-mesa'}>
                  <input type="checkbox" checked={escolhidas.has(m.tableId)} onChange={() => alternar(m.tableId)} /> {m.rotulo}
                </label>
              ))}
            </div>
            <p className="qr-pdf-resumo">{escolhidas.size} QR → {folhas} folha(s){umPorFolha ? '' : `, ${porPagina} por folha`}.</p>
          </>
        )}
        {msg && <p className={msg.erro ? 'modal-error' : 'io-message'}>{msg.texto}</p>}
        <div className="modal-actions">
          {onAbrirEstudio && <button type="button" className="btn-link" onClick={onAbrirEstudio}><Icon name="palette" size={14} /> Mudar a aparência no Estúdio</button>}
          <button type="button" className="btn-secondary" onClick={onFechar}>Fechar</button>
          <button type="button" className="btn-secondary" disabled={!!ocupado || !escolhidas.size} onClick={() => gerar('imprimir')}>
            <Icon name="printer" size={15} /> {ocupado === 'imprimir' ? 'Abrindo...' : 'Imprimir agora'}
          </button>
          <button type="button" className="btn-primary" disabled={!!ocupado || !escolhidas.size} onClick={() => gerar('pdf')}>
            <Icon name="export" size={15} /> {ocupado === 'pdf' ? 'Gerando...' : 'Gerar PDF'}
          </button>
        </div>
      </div>
    </div>
  );
}
