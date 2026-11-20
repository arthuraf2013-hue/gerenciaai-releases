import { useEffect, useRef, useState } from 'react';
import Icon from '../common/Icon';

// Aviso em qualquer tela: pedido novo (vitrine ou QR da mesa) e chamados da
// mesa (chamar garçom, pedir a conta, celular que entrou na mesa). Toca um
// som (mesmo com o "som ao adicionar produto" desligado: é um chamado) e
// some sozinho; o pedido esperando confirmação leva à Separação.

const DURACAO = { pedido: 30000, conta: 45000, garcom: 45000, entrou: 8000, mudanca: 45000 };

function tocar(vezes) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < vezes; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = i % 2 ? 1175 : 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.22);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.22 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.22 + 0.18);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.22);
      o.stop(ctx.currentTime + i * 0.22 + 0.2);
    }
    setTimeout(() => ctx.close().catch(() => {}), 1500);
  } catch { /* sem áudio */ }
}

const moeda = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function AvisosDaMesa({ onAbrir }) {
  const [avisos, setAvisos] = useState([]);
  const seq = useRef(0);

  useEffect(() => {
    const vitrine = window.pdv?.vitrine;
    if (!vitrine?.onPedidoNovo) return undefined;
    const adicionar = (aviso) => {
      const id = ++seq.current;
      setAvisos((lista) => [...lista.slice(-4), { ...aviso, id }]);
      setTimeout(() => setAvisos((lista) => lista.filter((a) => a.id !== id)), DURACAO[aviso.tipo] || 20000);
    };
    const pararPedido = vitrine.onPedidoNovo((p) => {
      if (!p) return;
      tocar(p.aceitoSozinho ? 2 : 3);
      adicionar({
        tipo: 'pedido',
        titulo: p.aceitoSozinho ? `Pedido entrou na ${p.mesa || 'comanda'}` : `Pedido novo${p.mesa ? ` · ${p.mesa}` : ''}`,
        texto: `${p.nome || 'Cliente'} · ${p.itens || 0} item(ns) · ${moeda(p.total)}${p.aceitoSozinho ? '' : ' · confirme na Separação'}`,
        destino: p.aceitoSozinho ? 'restaurant' : 'botOrders',
      });
    });
    const pararChamado = vitrine.onChamadoDaMesa?.((c) => {
      if (!c) return;
      if (c.tipo !== 'entrou') tocar(4);
      adicionar({
        tipo: c.tipo,
        titulo: c.tipo === 'conta' ? `${c.mesa}: pediram a conta` : c.tipo === 'garcom' ? `${c.mesa}: chamando o garçom`
          : c.tipo === 'mudanca' ? `${c.mesa}: pedido de mudança de mesa` : `${c.mesa}: entrou ${c.nome}`,
        texto: c.tipo === 'entrou' ? 'Pelo QR da mesa' : c.tipo === 'mudanca' ? `${c.texto} · aprove no quadrado da mesa` : (c.nome || 'Pelo QR da mesa'),
        destino: 'restaurant',
      });
    });
    return () => { pararPedido?.(); pararChamado?.(); };
  }, []);

  if (!avisos.length) return null;
  return (
    <div className="avisos-mesa" role="status" aria-live="polite">
      {avisos.map((a) => (
        <div key={a.id} className={`aviso-mesa aviso-mesa-${a.tipo}`}>
          <Icon name={a.tipo === 'pedido' ? 'plate' : a.tipo === 'entrou' ? 'users' : 'chat'} size={18} />
          <button type="button" className="aviso-mesa-corpo" onClick={() => { onAbrir?.(a.destino); setAvisos((l) => l.filter((x) => x.id !== a.id)); }}>
            <strong>{a.titulo}</strong>
            <span>{a.texto}</span>
          </button>
          <button type="button" className="aviso-mesa-fechar" aria-label="Fechar aviso" onClick={() => setAvisos((l) => l.filter((x) => x.id !== a.id))}>×</button>
        </div>
      ))}
    </div>
  );
}
