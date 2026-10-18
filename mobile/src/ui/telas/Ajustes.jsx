import { useEffect, useState } from 'react';
import { useApp, useTentar, useCarregar, podeGerenciar } from '../contexto.jsx';
import { configPix, salvarConfigPix } from '../../services/pix.js';
import { configDeVenda } from '../../services/vendas.js';
import { listarUsuarios, criarUsuario, trocarPin, definirAtivo } from '../../services/usuarios.js';
import { gravarConfig, ErroDeNegocio } from '../../services/base.js';
import { textoDoBloqueio } from '../../services/licenca.js';
import { apagarBancoDemo } from '../../app/plataforma.js';
import { VERSAO_APP } from '../../app/iniciar.js';
import Modal from '../comp/Modal.jsx';
import Icone from '../comp/Icone.jsx';

const TIPO_EVENTO = { venda: 'Venda', venda_cancelada: 'Cancelamento', fiado_pagamento: 'Fiado recebido', cliente: 'Cliente', estoque: 'Estoque' };

const PAPEL = { admin: 'Administrador', gerente: 'Gerente', operador: 'Operador' };
const quando = (ms) => (ms ? new Date(ms).toLocaleString('pt-BR') : '—');

function SeloLicenca({ status }) {
  if (!status) return null;
  const mapa = { ok: ['ok', 'Ativa'], aviso: ['alerta', 'Aviso'], somente_leitura: ['perigo', 'Só consulta'], bloqueado: ['perigo', 'Bloqueada'] };
  const [cls, txt] = mapa[status.status] || ['', status.status];
  return <span className={`selo ${cls}`}>{txt}</span>;
}

function Backup() {
  const { servicos, usuario } = useApp();
  const tentar = useTentar();
  const [e, setE] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => {
    servicos.backup.estado().then(setE);
    return servicos.backup.aoMudar(setE);
  }, [servicos.backup]);
  const lic = servicos.licenca.estado || {};
  return (
    <div className="cartao pilha">
      <div className="entre"><h3>Backup na nuvem</h3>{e?.ultimoErro ? <span className="selo perigo">falhou</span> : e?.ultimoEnvioMs ? <span className="selo ok">em dia</span> : <span className="selo">ainda não</span>}</div>
      <div className="pilha-p peq">
        <div className="entre"><span className="muted">Último envio</span><span>{quando(e?.ultimoEnvioMs)}</span></div>
        <div className="entre"><span className="muted">Última conferência</span><span>{quando(e?.ultimaVerificacaoMs)}</span></div>
        {e?.ultimoTamanhoBytes ? <div className="entre"><span className="muted">Tamanho</span><span>{(e.ultimoTamanhoBytes / 1024).toFixed(0)} KB</span></div> : null}
        <div className="entre"><span className="muted">Frequência</span><span>a cada {lic.backupFrequenciaHoras || 1} h</span></div>
        <div className="entre"><span className="muted">Guarda</span><span>até {lic.backupRetencaoDias || 30} dias</span></div>
      </div>
      {e?.ultimoErro && <div className="aviso perigo"><Icone nome="alerta" /><span>{e.ultimoErro}</span></div>}
      <p className="muted peq">Frequência e tempo de guarda são definidos pela Central. Sem internet, o backup sai assim que a conexão voltar. Ele só envia quando algo mudou.</p>
      {podeGerenciar(usuario) && (
        <button type="button" className="btn" disabled={ocupado} onClick={async () => {
          setOcupado(true);
          await tentar(() => servicos.backup.fazerBackup({ forcar: true, motivo: 'manual' }), { sucesso: 'Backup enviado para a nuvem.' });
          setOcupado(false);
        }}><Icone nome="nuvem" />{ocupado ? 'Enviando...' : 'Fazer backup agora'}</button>
      )}
    </div>
  );
}

// Terminal do computador: o que já foi, o que falta, o que foi recusado.
function Computador() {
  const { servicos, usuario, terminal } = useApp();
  const tentar = useTentar();
  const [ocupado, setOcupado] = useState(false);
  if (!terminal || (!terminal.ativo && !terminal.pendentes && !terminal.erros.length)) return null;
  const nome = terminal.servidorNome || 'computador';
  const enviar = async () => {
    setOcupado(true);
    const r = await tentar(() => servicos.terminal.enviarPendentes());
    setOcupado(false);
    if (r?.erro) servicos.terminal.resumo(); // a faixa/selo já mostram o erro de rede
  };
  return (
    <div className="cartao pilha">
      <div className="entre">
        <h3>Computador</h3>
        {terminal.erros.length ? <span className="selo perigo">{terminal.erros.length} recusado(s)</span>
          : terminal.naoEnviados ? <span className="selo alerta">{terminal.naoEnviados} a enviar</span>
            : <span className="selo ok">em dia</span>}
      </div>
      <p className="muted peq">
        {terminal.ativo
          ? <>Este celular é terminal do <strong>{nome}</strong>: vende normalmente (até sem internet) e manda vendas, cancelamentos, fiado recebido e clientes para lá. Produtos, preços e estoque vêm do computador.</>
          : <>Este celular voltou a ser autônomo. O que ainda estava na fila continua indo para o <strong>{nome}</strong>.</>}
      </p>
      <div className="pilha-p peq">
        <div className="entre"><span className="muted">Aguardando internet</span><span className="num">{terminal.naoEnviados}</span></div>
        <div className="entre"><span className="muted">Enviados, esperando o computador</span><span className="num">{terminal.pendentes - terminal.naoEnviados}</span></div>
        <div className="entre"><span className="muted">Último envio</span><span>{quando(terminal.ultimoEnvioMs)}</span></div>
        {terminal.ativo && <div className="entre"><span className="muted">Produtos atualizados em</span><span>{quando(terminal.catalogo?.aplicadoEmMs)}{terminal.catalogo ? ` · ${terminal.catalogo.produtos}` : ''}</span></div>}
      </div>
      {terminal.ultimoErroRede && terminal.naoEnviados > 0 && <div className="aviso"><Icone nome="wifiOff" /><span>Sem conexão agora — tenta de novo sozinho a cada minuto.</span></div>}
      {terminal.erros.map((e) => (
        <div className="aviso perigo" key={e.id}>
          <Icone nome="alerta" />
          <div className="cresce pilha-p">
            <span><strong>{TIPO_EVENTO[e.tipo] || e.tipo}</strong> de {new Date(e.criado_em).toLocaleString('pt-BR')}: {e.erro}</span>
            {podeGerenciar(usuario) && <button type="button" className="btn peq" onClick={() => tentar(() => servicos.terminal.tentarNovamente(e.id), { sucesso: 'Enviado de novo.' })}>Tentar de novo</button>}
          </div>
        </div>
      ))}
      {terminal.naoEnviados > 0 && <button type="button" className="btn" disabled={ocupado} onClick={enviar}><Icone nome="sincronizar" />{ocupado ? 'Enviando...' : 'Enviar agora'}</button>}
    </div>
  );
}

function Pix() {
  const { servicos } = useApp();
  const tentar = useTentar();
  const cfg = useCarregar(() => configPix(servicos.db), []);
  const [f, setF] = useState(null);
  useEffect(() => { if (cfg.dados) setF(cfg.dados); }, [cfg.dados]);
  if (!f) return null;
  return (
    <div className="cartao pilha">
      <h3>Pix</h3>
      <label className="campo">Chave Pix<input value={f.chave} onChange={(e) => setF({ ...f, chave: e.target.value })} placeholder="CPF, CNPJ, e-mail, celular ou aleatória" /></label>
      <div className="grade-2">
        <label className="campo">Nome do recebedor<input value={f.nomeRecebedor} onChange={(e) => setF({ ...f, nomeRecebedor: e.target.value })} /></label>
        <label className="campo">Cidade<input value={f.cidade} onChange={(e) => setF({ ...f, cidade: e.target.value })} /></label>
      </div>
      <button type="button" className="btn" onClick={() => tentar(() => salvarConfigPix(servicos.db, f), { sucesso: 'Pix salvo.' })}>Salvar Pix</button>
    </div>
  );
}

function RegrasDeVenda() {
  const { servicos } = useApp();
  const tentar = useTentar();
  const cfg = useCarregar(() => configDeVenda(servicos.db), []);
  const [f, setF] = useState(null);
  useEffect(() => { if (cfg.dados) setF({ desconto: String(cfg.dados.descontoMaxPercent), negativo: cfg.dados.permitirEstoqueNegativo }); }, [cfg.dados]);
  if (!f) return null;
  return (
    <div className="cartao pilha">
      <h3>Regras de venda</h3>
      <label className="campo">Desconto máximo sem gerente (%)<input value={f.desconto} onChange={(e) => setF({ ...f, desconto: e.target.value })} inputMode="numeric" /></label>
      <label className="check"><input type="checkbox" checked={f.negativo} onChange={(e) => setF({ ...f, negativo: e.target.checked })} />Permitir vender sem estoque (estoque fica negativo)</label>
      <button type="button" className="btn" onClick={() => tentar(async () => {
        const p = Number(f.desconto);
        if (!Number.isInteger(p) || p < 0 || p > 100) throw new ErroDeNegocio('Desconto máximo entre 0 e 100.');
        await gravarConfig(servicos.db, 'desconto_max_percent', p);
        await gravarConfig(servicos.db, 'permitir_estoque_negativo', f.negativo);
      }, { sucesso: 'Regras salvas.' })}>Salvar regras</button>
    </div>
  );
}

function Operadores() {
  const { servicos, usuario } = useApp();
  const tentar = useTentar();
  const lista = useCarregar(() => listarUsuarios(servicos.db, { incluirInativos: true }), []);
  const [novo, setNovo] = useState(null);
  const [pin, setPin] = useState(null);
  return (
    <div className="cartao pilha">
      <div className="entre"><h3>Operadores</h3><button type="button" className="btn peq" onClick={() => setNovo({ nome: '', papel: 'operador', pin: '' })}><Icone nome="mais1" />Novo</button></div>
      <div className="cartao plano">
        {(lista.dados || []).map((u) => (
          <div className="item" key={u.id}>
            <div className="cresce"><div className="forte">{u.nome}{u.id === usuario.id ? ' (você)' : ''}</div><div className="muted peq">{PAPEL[u.papel]}{u.ativo ? '' : ' · desativado'}</div></div>
            <button type="button" className="btn peq" onClick={() => setPin({ id: u.id, nome: u.nome, pin: '' })}>PIN</button>
            {u.id !== usuario.id && <button type="button" className="btn peq" onClick={() => tentar(async () => { await definirAtivo(servicos.db, u.id, !u.ativo, usuario.id); lista.recarregar(); })}>{u.ativo ? 'Desativar' : 'Reativar'}</button>}
          </div>
        ))}
      </div>
      {novo && (
        <Modal titulo="Novo operador" aoFechar={() => setNovo(null)}>
          <label className="campo">Nome<input autoFocus value={novo.nome} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} /></label>
          <div className="segmentado">
            {['operador', 'gerente', 'admin'].map((p) => <button type="button" key={p} className={novo.papel === p ? 'ativo' : ''} onClick={() => setNovo({ ...novo, papel: p })}>{PAPEL[p]}</button>)}
          </div>
          <label className="campo">PIN (4 a 8 números)<input value={novo.pin} onChange={(e) => setNovo({ ...novo, pin: e.target.value })} type="password" inputMode="numeric" /></label>
          <button type="button" className="btn primario grande" onClick={() => tentar(async () => { await criarUsuario(servicos.db, novo, usuario.id); setNovo(null); lista.recarregar(); }, { sucesso: 'Operador criado.' })}>Criar</button>
        </Modal>
      )}
      {pin && (
        <Modal titulo={`Novo PIN de ${pin.nome}`} aoFechar={() => setPin(null)}>
          <label className="campo">Novo PIN<input autoFocus value={pin.pin} onChange={(e) => setPin({ ...pin, pin: e.target.value })} type="password" inputMode="numeric" /></label>
          <button type="button" className="btn primario grande" onClick={() => tentar(async () => { await trocarPin(servicos.db, pin.id, pin.pin, usuario.id); setPin(null); }, { sucesso: 'PIN trocado.' })}>Salvar</button>
        </Modal>
      )}
    </div>
  );
}

export default function Ajustes({ voltar }) {
  const { servicos, usuario, sair, licencaStatus, terminal } = useApp();
  const lic = servicos.licenca.estado || {};
  const emTerminal = !!terminal?.ativo;
  const nomePc = terminal?.servidorNome || lic.servidorNome || 'computador';
  const admin = usuario.papel === 'admin';
  return (
    <>
      <header className="topo">
        <button type="button" className="icone-btn" onClick={voltar} aria-label="Voltar"><Icone nome="voltar" /></button>
        <h1>Ajustes</h1>
      </header>
      <main className="conteudo">
        <div className="cartao pilha">
          <div className="entre"><h3>{lic.nomeNegocio}</h3><SeloLicenca status={licencaStatus} /></div>
          <div className="pilha-p peq">
            <div className="entre"><span className="muted">Tipo</span>{emTerminal
              ? <span className="selo"><Icone nome="computador" width="14" height="14" />Terminal de {nomePc}</span>
              : <span className="selo"><Icone nome="celular" width="14" height="14" />PDV mobile autônomo</span>}</div>
            <div className="entre"><span className="muted">Código do aparelho</span><span className="num">{(lic.installId || '').slice(0, 8)}</span></div>
            <div className="entre"><span className="muted">Numeração das vendas</span><span className="num">{lic.prefixoVenda}-000001…</span></div>
            <div className="entre"><span className="muted">Último contato com a Central</span><span>{quando(lic.ultimoContatoOkMs)}</span></div>
            <div className="entre"><span className="muted">Versão do app</span><span>{VERSAO_APP}</span></div>
          </div>
          {licencaStatus && licencaStatus.status !== 'ok' && <div className="aviso"><Icone nome="alerta" /><span>{textoDoBloqueio(licencaStatus)}</span></div>}
          <p className="muted peq">Funciona sem internet por até 3 dias seguidos; depois disso precisa conectar para continuar vendendo.</p>
        </div>

        <Computador />

        <Backup />

        <div className="cartao pilha">
          {emTerminal ? (
            <>
              <div className="entre"><h3>Nota fiscal (NFC-e)</h3><span className="selo">pelo computador</span></div>
              <p className="muted peq">O celular não emite nota. Se a emissão estiver ligada no {nomePc} (Configurações → Celulares terminais), a NFC-e de cada venda sai por lá quando a venda chega — a tela da venda mostra se saiu. Venda que chega muito depois (celular sem internet) fica para emitir no computador.</p>
            </>
          ) : (
            <>
              <div className="entre"><h3>Nota fiscal (NFC-e)</h3><span className="selo">indisponível</span></div>
              <p className="muted peq">O PDV mobile autônomo não emite NFC-e. A emissão só fica disponível quando o celular estiver vinculado a um computador servidor com o GerenciaAI — aí a nota sai pelo computador. As vendas daqui geram recibo sem valor fiscal.</p>
            </>
          )}
        </div>

        {admin && <Pix />}
        {admin && <RegrasDeVenda />}
        {admin && <Operadores />}

        <button type="button" className="btn grande" onClick={sair}><Icone nome="sair" />Trocar operador</button>
        {servicos.demo && (
          <button type="button" className="btn contorno-perigo" onClick={() => { if (confirm('Apagar todos os dados de demonstração deste navegador?')) { apagarBancoDemo(); location.reload(); } }}>Apagar dados de demonstração</button>
        )}
      </main>
    </>
  );
}
