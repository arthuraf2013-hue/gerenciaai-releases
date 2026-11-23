import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

// Taxa de serviço fixa da casa (mesas) -- electron/services/taxaServicoService.js.
// Ligada: toda mesa nova já abre com a %, e a nota e a pré-nota da mesa sempre
// trazem o total sem serviço e o total com serviço (opcional). Continua
// opcional para o cliente: quem atende desmarca na conta.

const mostrarPct = (v) => String(v).replace('.', ',');

export function TaxaServicoConfig() {
  const [form, setForm] = useState(null);
  const [salvo, setSalvo] = useState(null);
  const [mensagem, setMensagem] = useState(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    window.pdv.taxaServico.get().then((r) => {
      if (r?.ok === false) { setMensagem({ tipo: 'erro', texto: r.error }); return; }
      setSalvo(r);
      setForm({ ativa: !!r.ativa, percentual: mostrarPct(r.percentual) });
    });
  }, []);

  async function salvar(e) {
    e.preventDefault();
    setSalvando(true); setMensagem(null);
    const r = await window.pdv.taxaServico.salvar({ ativa: form.ativa, percentual: String(form.percentual).replace(',', '.') });
    setSalvando(false);
    if (!r?.ok) { setMensagem({ tipo: 'erro', texto: r?.error || 'Não consegui salvar.' }); return; }
    setSalvo(r);
    setForm({ ativa: !!r.ativa, percentual: mostrarPct(r.percentual) });
    setMensagem({
      tipo: 'ok',
      texto: r.ativa
        ? `Salvo. As mesas abertas daqui em diante já começam com ${mostrarPct(r.percentual)}%. As que já estão abertas não mudam.`
        : 'Salvo. Taxa fixa desligada: a taxa volta a ser marcada na hora do pagamento.',
    });
  }

  if (!form) return <section className="settings-section"><p className="screen-hint">Carregando...</p></section>;
  const mudou = salvo && (form.ativa !== !!salvo.ativa || String(form.percentual).replace(',', '.') !== String(salvo.percentual));
  return (
    <section className="settings-section">
      <h2><Icon name="receipt" size={16} /> Taxa de serviço fixa (mesas)</h2>
      <p className="screen-hint">
        Ligada, toda mesa já abre com a taxa, no computador e no celular do garçom. A nota e a pré-nota da mesa sempre mostram
        o <strong>total sem serviço</strong> e o <strong>total com serviço (opcional)</strong>, mesmo quando o cliente não quis pagar a taxa.
        A taxa continua opcional para o cliente: no pagamento, quem atende desmarca "Taxa de serviço". Venda de balcão não muda.
      </p>
      <form className="product-form" onSubmit={salvar} style={{ marginTop: 8 }}>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.ativa} onChange={(e) => setForm({ ...form, ativa: e.target.checked })} />
          Usar taxa de serviço fixa nas mesas
        </label>
        <label style={{ maxWidth: 220 }}>Taxa de serviço (%)
          <input
            type="text" inputMode="decimal" value={form.percentual} disabled={!form.ativa}
            onChange={(e) => setForm({ ...form, percentual: e.target.value.replace(/[^0-9.,]/g, '').slice(0, 5) })}
            aria-label="Taxa de serviço em porcentagem"
          />
        </label>
        <p className="screen-hint" style={{ margin: 0 }}>
          Grupo de caixas: ligue igual em todos os caixas. Quem abre a mesa é o servidor do grupo, e cada caixa imprime a nota com a configuração dele.
        </p>
        <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
          <button type="submit" className="btn-primary" disabled={salvando || !mudou}>
            <Icon name="save" size={15} /> {salvando ? 'Salvando...' : 'Salvar'}
          </button>
          {mensagem && <span className={mensagem.tipo === 'erro' ? 'modal-error' : 'io-message'}>{mensagem.texto}</span>}
        </div>
      </form>
    </section>
  );
}
