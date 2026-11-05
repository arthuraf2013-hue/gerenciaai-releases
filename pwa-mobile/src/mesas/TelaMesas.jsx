import { useState } from 'react';
import { Contador, Folha, Icone, Opcoes } from './comum.jsx';
import { contarPorStatus, filtrarMesas, formatarMoeda, rotuloMesa, rotuloMesaComUnidas, tempoDesde } from './logica.js';

const FILTROS = [
  { chave: 'todas', rotulo: 'Todas' },
  { chave: 'minhas', rotulo: 'Minhas' },
  { chave: 'livres', rotulo: 'Livres' },
];

/** Tela inicial: todas as mesas da loja, por status. */
export default function TelaMesas({ mesas, meuUsuarioId, envios, online, agora, aoAbrirComanda, aoAbrirMesaLivre, aoMarcarLimpa, aoVerEnvios }) {
  const [filtro, setFiltro] = useState('todas');
  const [livreEscolhida, setLivreEscolhida] = useState(null);
  const [limpezaEscolhida, setLimpezaEscolhida] = useState(null);
  const lista = filtrarMesas(mesas, filtro, meuUsuarioId);
  const contagem = contarPorStatus(mesas);
  const naFila = envios.filter((e) => e.situacao !== 'erro').length;
  const comErro = envios.filter((e) => e.situacao === 'erro').length;

  const tocar = (m) => {
    if (m.unidaA) return aoAbrirComanda(m.unidaA);
    if (m.status === 'ocupada') return aoAbrirComanda(m.id);
    if (m.status === 'aguardando_limpeza') return setLimpezaEscolhida(m);
    return setLivreEscolhida(m);
  };

  return (
    <div className="pm-tela">
      <div className="pm-filtros" role="tablist" aria-label="Filtrar mesas">
        {FILTROS.map((f) => (
          <button key={f.chave} type="button" role="tab" aria-selected={filtro === f.chave}
            className={`chip${filtro === f.chave ? ' chip-ativo' : ''}`} onClick={() => setFiltro(f.chave)}>
            {f.rotulo}
          </button>
        ))}
        <span className="pm-contagem">{contagem.ocupada} ocupada{contagem.ocupada === 1 ? '' : 's'} · {contagem.livre} livre{contagem.livre === 1 ? '' : 's'}</span>
      </div>

      {(naFila > 0 || comErro > 0) && (
        <button type="button" className={`pm-aviso-envios${comErro ? ' pm-aviso-envios-erro' : ''}`} onClick={aoVerEnvios}>
          <Icone nome={comErro ? 'fechar' : 'semSinal'} />
          <span>
            {comErro > 0 ? `${comErro} envio${comErro > 1 ? 's' : ''} com problema` : ''}
            {comErro > 0 && naFila > 0 ? ' · ' : ''}
            {naFila > 0 ? `${naFila} envio${naFila > 1 ? 's' : ''} ${online ? 'saindo' : 'na fila (sem internet)'}` : ''}
          </span>
          <Icone nome="chevronRight" />
        </button>
      )}

      {lista.length === 0 ? (
        <p className="estado-vazio">{filtro === 'minhas' ? 'Nenhuma mesa aberta por você agora.' : filtro === 'livres' ? 'Nenhuma mesa livre agora.' : 'Nenhuma mesa cadastrada. Cadastre as mesas no computador.'}</p>
      ) : (
        <div className="pm-grade-mesas">
          {lista.map((m) => <CartaoMesa key={m.id} mesa={m} agora={agora} aoTocar={() => tocar(m)} />)}
        </div>
      )}

      {livreEscolhida && (
        <AbrirMesa
          mesa={livreEscolhida}
          online={online}
          aoFechar={() => setLivreEscolhida(null)}
          aoConfirmar={(pessoas) => { const m = livreEscolhida; setLivreEscolhida(null); aoAbrirMesaLivre(m, pessoas); }}
        />
      )}
      {limpezaEscolhida && (
        <Opcoes
          titulo={rotuloMesa(limpezaEscolhida)}
          aoFechar={() => setLimpezaEscolhida(null)}
          opcoes={[
            { rotulo: 'Marcar como limpa', detalhe: 'A mesa volta a ficar livre', aoEscolher: () => { const m = limpezaEscolhida; setLimpezaEscolhida(null); aoMarcarLimpa(m); } },
          ]}
        />
      )}
    </div>
  );
}

function CartaoMesa({ mesa: m, agora, aoTocar }) {
  if (m.unidaA) {
    return (
      <button type="button" className="pm-mesa pm-mesa-unida" onClick={aoTocar}>
        <span className="pm-mesa-nome">{rotuloMesa(m)}</span>
        <span className="pm-mesa-info">unida à mesa {m.unidaANumero}</span>
      </button>
    );
  }
  if (m.status === 'ocupada') {
    return (
      <button type="button" className={`pm-mesa pm-mesa-ocupada${m.pago > 0 ? ' pm-mesa-pagando' : ''}`} onClick={aoTocar}>
        <span className="pm-mesa-nome">{rotuloMesaComUnidas(m)}</span>
        <span className="pm-mesa-info">
          {m.pessoas ? `${m.pessoas} pessoa${m.pessoas > 1 ? 's' : ''}` : 'aberta'}{m.abertaEm ? ` · ${tempoDesde(m.abertaEm, agora)}` : ''}
        </span>
        <span className="pm-mesa-total">{formatarMoeda(m.total)}</span>
        {m.pago > 0 && <span className="pm-mesa-info">falta {formatarMoeda(m.restante)}</span>}
      </button>
    );
  }
  if (m.status === 'aguardando_limpeza') {
    return (
      <button type="button" className="pm-mesa pm-mesa-limpeza" onClick={aoTocar}>
        <span className="pm-mesa-nome">{rotuloMesa(m)}</span>
        <span className="pm-mesa-info">limpeza</span>
      </button>
    );
  }
  if (m.status === 'reservada') {
    return (
      <button type="button" className="pm-mesa pm-mesa-reservada" onClick={aoTocar}>
        <span className="pm-mesa-nome">{rotuloMesa(m)}</span>
        <span className="pm-mesa-info">reservada{m.reservadoPara ? ` · ${m.reservadoPara}` : ''}</span>
      </button>
    );
  }
  return (
    <button type="button" className="pm-mesa" onClick={aoTocar}>
      <span className="pm-mesa-nome">{rotuloMesa(m)}</span>
      <span className="pm-mesa-info">livre</span>
    </button>
  );
}

function AbrirMesa({ mesa, online, aoFechar, aoConfirmar }) {
  const [pessoas, setPessoas] = useState(2);
  return (
    <Folha titulo={`Abrir ${rotuloMesa(mesa)}`} aoFechar={aoFechar}>
      <div className="pm-form">
        {mesa.status === 'reservada' && <p className="aviso aviso-alerta">Reservada{mesa.reservadoPara ? ` para ${mesa.reservadoPara}` : ''}. Abrir agora tira a reserva.</p>}
        <span className="pm-rotulo">Quantas pessoas?</span>
        <Contador valor={pessoas} min={1} max={60} aoMudar={setPessoas} rotulo="Pessoas na mesa" />
        {!online && <p className="subtexto">Sem internet: a mesa abre junto com o primeiro pedido, quando a conexão voltar.</p>}
        <button type="button" className="btn-primario" onClick={() => aoConfirmar(pessoas)}>Abrir e lançar</button>
      </div>
    </Folha>
  );
}
