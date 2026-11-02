import { useEffect, useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';
import Icon from '../common/Icon';

// Demonstração completa (aba "Suporte" de Configurações, só para o papel
// suporte). Carrega uma loja fictícia inteira de um perfil, troca de perfil
// e limpa, voltando ao banco de antes. Ver electron/services/demoDataService.js.

const PALAVRA_DE_CONFIRMACAO = 'DEMONSTRAÇÃO';
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();

const ACOES = {
  carregar: {
    titulo: 'Carregar dados de demonstração?',
    texto: 'Antes de gravar, o sistema guarda uma cópia completa dos dados atuais. Ao limpar a demonstração, essa cópia volta inteira. O sistema reinicia ao terminar.',
    botao: 'Carregar',
    classe: 'btn-primary',
  },
  trocar: {
    titulo: 'Trocar o perfil da demonstração?',
    texto: 'A demonstração atual é limpa e a do novo perfil é carregada no lugar. Vendas e cadastros feitos durante a demonstração atual se perdem. O sistema reinicia ao terminar.',
    botao: 'Trocar perfil',
    classe: 'btn-primary',
  },
  limpar: {
    titulo: 'Limpar a demonstração?',
    texto: 'Os dados de antes da demonstração voltam exatamente como estavam. Tudo o que foi feito durante a demonstração se perde. O sistema reinicia ao terminar.',
    botao: 'Limpar demonstração',
    classe: 'btn-danger',
  },
};

function ConfirmacaoDigitada({ acao, perfilRotulo, onConfirmar, onCancelar, executando }) {
  const [texto, setTexto] = useState('');
  const [erro, setErro] = useState(null);
  useEscToClose(onCancelar, !executando);
  const info = ACOES[acao];

  function confirmar(e) {
    e.preventDefault();
    if (semAcento(texto) !== semAcento(PALAVRA_DE_CONFIRMACAO)) {
      setErro(`Digite ${PALAVRA_DE_CONFIRMACAO} para confirmar.`);
      return;
    }
    onConfirmar();
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <form onSubmit={confirmar}>
          <h2>{info.titulo}</h2>
          {perfilRotulo && <p><strong>Perfil:</strong> {perfilRotulo}</p>}
          <p className="screen-hint">{info.texto}</p>
          <label htmlFor="demo-confirmacao">Digite {PALAVRA_DE_CONFIRMACAO} para confirmar</label>
          <input
            id="demo-confirmacao"
            autoFocus
            className="prompt-modal-input"
            value={texto}
            placeholder={PALAVRA_DE_CONFIRMACAO}
            disabled={executando}
            onChange={(e) => { setTexto(e.target.value); setErro(null); }}
          />
          {erro && <p className="modal-error">{erro}</p>}
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button type="button" className="btn-secondary" onClick={onCancelar} disabled={executando}><Icon name="close" size={15} /> Cancelar</button>
            <button type="submit" className={info.classe} disabled={executando}>
              <Icon name={acao === 'limpar' ? 'trash' : 'import'} size={15} /> {executando ? 'Aguarde...' : info.botao}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const dataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');

export function DemonstracaoSuporte() {
  const [estado, setEstado] = useState(null);
  const [perfil, setPerfil] = useState('');
  const [acao, setAcao] = useState(null);
  const [executando, setExecutando] = useState(false);
  const [mensagem, setMensagem] = useState(null);

  async function atualizar() {
    const r = await window.pdv.demo.estado();
    if (r?.ok === false) {
      setMensagem({ tipo: 'erro', texto: r.error });
      return;
    }
    setEstado(r);
    setPerfil((atual) => atual || (r.ativa ? '' : r.perfis[0]?.id) || '');
  }

  useEffect(() => { atualizar(); }, []);

  async function executar() {
    setExecutando(true);
    setMensagem(null);
    const r = acao === 'carregar'
      ? await window.pdv.demo.carregar({ perfil })
      : acao === 'trocar'
        ? await window.pdv.demo.trocarPerfil({ perfil })
        : await window.pdv.demo.limpar();
    if (r?.reiniciar) {
      setMensagem({ tipo: r.ok ? 'ok' : 'erro', texto: r.ok ? 'Pronto. O sistema está reiniciando...' : `${r.error} O sistema está reiniciando.` });
      return; // o processo principal reinicia o app
    }
    setExecutando(false);
    setAcao(null);
    setMensagem({ tipo: r?.ok ? 'ok' : 'erro', texto: r?.ok ? 'Concluído.' : (r?.error || 'Não foi possível concluir.') });
    atualizar();
  }

  if (!estado) return <section className="settings-section"><p className="screen-hint">Carregando...</p></section>;

  const rotuloDe = (id) => estado.perfis.find((p) => p.id === id)?.rotulo || id;
  const outrosPerfis = estado.perfis.filter((p) => p.id !== estado.perfil);
  const bloqueado = !estado.ativa && estado.impedimentos.length > 0;

  return (
    <section className="settings-section">
      <h2><Icon name="store" size={16} /> Dados de demonstração <span className="badge-warning" style={{ marginLeft: 8 }}>Somente suporte</span></h2>
      <p className="screen-hint">
        Carrega uma loja fictícia completa do perfil escolhido: produtos, clientes, fornecedores, entregas e
        quatro meses de vendas, para apresentar o sistema. Os dados reais desta máquina ficam guardados e voltam
        ao limpar a demonstração.
      </p>

      {estado.pontoPerdido && (
        <p className="modal-error">
          Esta máquina tem uma demonstração registrada, mas a cópia dos dados de antes dela não foi encontrada.
          Não é possível limpar com segurança. Restaure um backup de antes da demonstração em Backup.
        </p>
      )}

      {estado.ativa ? (
        <>
          <p className="io-message">
            <Icon name="checkCircle" size={15} /> Demonstração ativa: <strong>{estado.rotulo}</strong>, carregada em {dataHora(estado.carregadaEm)}.
            {estado.resumo && ` ${estado.resumo.produtos} produtos, ${estado.resumo.clientes} clientes e ${estado.resumo.vendas} vendas desde ${estado.resumo.desde.split('-').reverse().join('/')}.`}
          </p>
          <p className="io-message-aviso"><Icon name="warning" size={15} /> Vendas e cadastros feitos durante a demonstração se perdem ao limpar ou trocar de perfil.</p>
          <p className="screen-hint">Cópia dos dados de antes: {estado.pontoRestauracao}</p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
            <select value={perfil} onChange={(e) => setPerfil(e.target.value)} aria-label="Novo perfil da demonstração">
              <option value="">Escolha o novo perfil</option>
              {outrosPerfis.map((p) => <option key={p.id} value={p.id}>{p.rotulo}</option>)}
            </select>
            <button type="button" className="btn-secondary" disabled={!perfil} onClick={() => setAcao('trocar')}>
              <Icon name="refresh" size={15} /> Trocar perfil da demonstração
            </button>
            <button type="button" className="btn-danger" onClick={() => setAcao('limpar')}>
              <Icon name="trash" size={15} /> Limpar demonstração
            </button>
          </div>
        </>
      ) : (
        <>
          {estado.impedimentos.map((texto) => (
            <p className="io-message-aviso" key={texto}><Icon name="warning" size={15} /> {texto}</p>
          ))}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
            <select value={perfil} onChange={(e) => setPerfil(e.target.value)} aria-label="Perfil da demonstração" disabled={bloqueado}>
              {estado.perfis.map((p) => <option key={p.id} value={p.id}>{p.rotulo}</option>)}
            </select>
            <button type="button" className="btn-primary" disabled={bloqueado || !perfil} onClick={() => setAcao('carregar')}>
              <Icon name="import" size={15} /> Carregar dados de demonstração
            </button>
          </div>
        </>
      )}

      {mensagem && <p className={mensagem.tipo === 'erro' ? 'modal-error' : 'io-message'} style={{ marginTop: 12 }}>{mensagem.texto}</p>}

      {acao && (
        <ConfirmacaoDigitada
          acao={acao}
          perfilRotulo={acao === 'limpar' ? null : rotuloDe(perfil)}
          executando={executando}
          onConfirmar={executar}
          onCancelar={() => { if (!executando) setAcao(null); }}
        />
      )}
    </section>
  );
}
