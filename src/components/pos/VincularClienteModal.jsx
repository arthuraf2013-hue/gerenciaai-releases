import { useEffect, useRef, useState } from 'react';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useEscToClose } from '../../hooks/useEscToClose';
import Icon from '../common/Icon';

/**
 * Liga uma pessoa da comanda da mesa a um cliente do cadastro (ou desliga).
 * O consumo dela passa a aparecer na ficha do cliente; não muda quem paga a
 * conta (fiado e pontos continuam no cliente da venda).
 */
export function VincularClienteModal({ pessoa, rotulo, onEscolher, onDesvincular, onFechar }) {
  const [busca, setBusca] = useState('');
  const buscaAtrasada = useDebouncedValue(busca, 250);
  const [clientes, setClientes] = useState([]);
  const [salvando, setSalvando] = useState(false);
  const campo = useRef(null);
  useEscToClose(onFechar);
  useEffect(() => { campo.current?.focus(); }, []);

  useEffect(() => {
    const texto = buscaAtrasada.trim();
    if (texto.length < 2) { setClientes([]); return undefined; }
    let ignorar = false;
    window.pdv.customers.list({ query: texto }).then((lista) => {
      if (!ignorar) setClientes(Array.isArray(lista) ? lista.slice(0, 8) : []);
    });
    return () => { ignorar = true; };
  }, [buscaAtrasada]);

  async function escolher(fn) {
    setSalvando(true);
    await fn();
    setSalvando(false);
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card vincular-cliente" role="dialog" aria-modal="true" aria-label={`Cliente de ${rotulo}`}>
        <h2><span className="ficha-btn"><Icon name="user" size={18} /> Cliente de {rotulo}</span></h2>
        {pessoa.clienteId ? (
          <div className="vincular-atual">
            <span>Ligada a <strong>{pessoa.clienteNome}</strong></span>
            <button type="button" className="btn-link-danger" disabled={salvando} onClick={() => escolher(onDesvincular)}>Desligar</button>
          </div>
        ) : (
          <p className="modal-subtitle">O consumo desta pessoa vai aparecer na ficha do cliente escolhido. Quem paga a conta não muda.</p>
        )}
        <input
          ref={campo} className="search-input" placeholder="Buscar cliente por nome, telefone ou CPF..."
          value={busca} onChange={(e) => setBusca(e.target.value)}
        />
        {busca.trim().length >= 2 && clientes.length === 0 && <p className="screen-hint">Nenhum cliente encontrado.</p>}
        {clientes.length > 0 && (
          <ul className="vincular-lista">
            {clientes.map((c) => (
              <li key={c.id}>
                <button type="button" disabled={salvando || c.id === pessoa.clienteId} onClick={() => escolher(() => onEscolher(c))}>
                  <strong>{c.nome}</strong>
                  <span className="screen-hint">{[c.telefone, c.cpf && `CPF ${c.cpf}`].filter(Boolean).join(' · ') || 'sem telefone'}</span>
                  {c.id === pessoa.clienteId && <span className="screen-hint">(atual)</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onFechar}>Fechar</button>
        </div>
      </div>
    </div>
  );
}
