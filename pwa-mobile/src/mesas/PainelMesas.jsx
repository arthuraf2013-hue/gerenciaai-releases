import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mostrarToast } from '../../pdv-util.js';
import { Folha, Icone } from './comum.jsx';
import TelaMesas from './TelaMesas.jsx';
import TelaComanda from './TelaComanda.jsx';
import TelaLancar from './TelaLancar.jsx';
import TelaConta from './TelaConta.jsx';
import { formatarMoeda, servidorVivo } from './logica.js';
import { criarFilaDeLancamentos, executar, observarCatalogo, observarMesas } from './servidorMesas.js';
import './mesas.css';

/**
 * Painel de mesas do celular (garçom e operador). `modo`:
 *   'garcom' -- lança, pessoas, mover, observação, cancelar (regra do
 *               computador), marcar limpa;
 *   'pdv'    -- tudo do garçom + juntar/separar/transferir + fechar conta
 *               (se a loja liberou venda pelo celular).
 * O computador confere tudo de novo (mesaCelularService.js); os botões aqui
 * só aparecem para quem pode.
 *
 * `aoSemPainel(motivo)`: o computador desta loja ainda não publica as mesas
 * (GerenciaAI do computador desatualizado, ou regras do Firestore antigas)
 * -- quem montou o painel volta para a tela antiga do garçom.
 */
export default function PainelMesas({ loja, modo, aoSemPainel }) {
  const [mesas, setMesas] = useState({ carregou: false, dados: null });
  const [catalogo, setCatalogo] = useState({ produtos: [] });
  const [envios, setEnvios] = useState([]);
  const [online, setOnline] = useState(navigator.onLine !== false);
  const [agora, setAgora] = useState(Date.now());
  const [pilha, setPilha] = useState([{ tipo: 'mesas' }]);
  const [verEnvios, setVerEnvios] = useState(false);
  const filaRef = useRef(null);
  const avisouFallback = useRef(false);

  useEffect(() => observarMesas(loja.installId, (r) => {
    if (r.erro) {
      if (!avisouFallback.current) { avisouFallback.current = true; aoSemPainel?.('sem_permissao', r.erro); }
      return;
    }
    if (r.doServidor && !r.existe) {
      if (!avisouFallback.current) { avisouFallback.current = true; aoSemPainel?.('sem_publicacao'); }
      return;
    }
    // Loja sem mesa cadastrada: a tela antiga (pedido sem mesa) atende melhor.
    if (r.doServidor && r.existe && !(r.dados?.mesas || []).length) {
      if (!avisouFallback.current) { avisouFallback.current = true; aoSemPainel?.('sem_mesas'); }
      return;
    }
    if (r.existe) setMesas({ carregou: true, dados: r.dados, ultimaNovidadeMs: r.ultimaNovidadeMs, doServidor: r.doServidor });
  }), [loja.installId, aoSemPainel]);

  useEffect(() => observarCatalogo(loja.installId, (r) => setCatalogo(r)), [loja.installId]);

  useEffect(() => {
    const fila = criarFilaDeLancamentos(loja.installId, setEnvios);
    filaRef.current = fila;
    return () => fila.parar();
  }, [loja.installId]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const t = setInterval(() => setAgora(Date.now()), 20000);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); clearInterval(t); };
  }, []);

  // Navegação com o "voltar" do celular: cada tela nova empilha uma entrada
  // no histórico com a profundidade dela; voltar (botão da tela ou do
  // aparelho) corta a pilha até a profundidade da entrada atual.
  const ir = useCallback((tela) => {
    setPilha((p) => {
      const nova = [...p, tela];
      try { window.history.pushState({ painelMesas: nova.length - 1 }, ''); } catch { /* sem history */ }
      return nova;
    });
  }, []);
  const voltar = useCallback(() => {
    if (window.history.state?.painelMesas > 0) window.history.back();
    else setPilha((p) => (p.length > 1 ? p.slice(0, -1) : p));
  }, []);
  const trocarTopo = useCallback((tela) => setPilha((p) => [...p.slice(0, -1), tela]), []);
  useEffect(() => {
    // O painel sempre começa na tela de mesas: a entrada atual do histórico
    // vira a profundidade 0 (depois de recarregar a página, ela ainda podia
    // ter a profundidade de antes e o "voltar" não voltava).
    try { window.history.replaceState({ ...(window.history.state || {}), painelMesas: 0 }, ''); } catch { /* sem history */ }
    const aoVoltar = (e) => {
      const profundidade = Number(e.state?.painelMesas) || 0;
      setPilha((p) => p.slice(0, Math.min(p.length, profundidade + 1)));
    };
    window.addEventListener('popstate', aoVoltar);
    return () => window.removeEventListener('popstate', aoVoltar);
  }, []);
  const irParaMesas = useCallback(() => {
    const profundidade = Number(window.history.state?.painelMesas) || 0;
    if (profundidade > 0) window.history.go(-profundidade);
    else setPilha([{ tipo: 'mesas' }]);
  }, []);

  const doc = mesas.dados;
  const vivo = servidorVivo(doc, mesas.ultimaNovidadeMs, agora);
  const podeOrganizar = modo === 'pdv';
  const podeReceber = modo === 'pdv' && !!doc?.permitirVenda && (doc?.metodosPagamento || []).length > 0;
  const tela = pilha[pilha.length - 1];
  const mesaDa = (id) => (doc?.mesas || []).find((m) => m.id === id) || null;

  const abrirMesaLivre = async (m, pessoas) => {
    if (!online) {
      ir({ tipo: 'lancar', mesaId: m.id, pessoa: null, pessoasAoAbrir: pessoas });
      return;
    }
    try {
      await executar(loja.installId, 'abrir', { mesaId: m.id, pessoas });
      ir({ tipo: 'comanda', mesaId: m.id });
      ir({ tipo: 'lancar', mesaId: m.id, pessoa: null, pessoasAoAbrir: pessoas });
    } catch (err) {
      mostrarToast(err.message, 'erro');
    }
  };

  const marcarLimpa = async (m) => {
    try {
      await executar(loja.installId, 'limpar_mesa', { mesaId: m.id });
      mostrarToast('Mesa livre.');
    } catch (err) {
      mostrarToast(err.message, 'erro');
    }
  };

  const separarMesa = async (m) => {
    try {
      await executar(loja.installId, 'separar', { mesaId: m.id });
      mostrarToast(`${m.nome || `Mesa ${m.numero}`} separada.`);
    } catch (err) {
      mostrarToast(err.message, 'erro');
    }
  };

  const enviarItens = (mesaId, { itens, itensTela }, pessoasAoAbrir) => {
    filaRef.current?.lancar({ mesaId, itens, itensTela, pessoas: pessoasAoAbrir || null });
    mostrarToast(online ? 'Pedido enviado.' : 'Sem internet: o pedido ficou guardado e vai assim que a conexão voltar.');
    // Volta para a comanda (que já mostra os itens chegando).
    const anterior = pilha[pilha.length - 2];
    if (anterior?.tipo === 'comanda' && anterior.mesaId === mesaId) voltar();
    else trocarTopo({ tipo: 'comanda', mesaId });
  };

  const comErro = useMemo(() => envios.filter((e) => e.situacao === 'erro'), [envios]);

  if (!mesas.carregou) {
    return (
      <div className={`pm-painel pm-painel-${modo}`}>
        <p className="estado-vazio"><span className="spinner spinner-pequeno" /> Carregando as mesas...</p>
        {!online && <p className="pm-offline">Sem internet. As mesas aparecem quando a conexão voltar.</p>}
      </div>
    );
  }

  return (
    <div className={`pm-painel pm-painel-${modo}`}>
      {!vivo && (
        <p className="aviso aviso-alerta pm-aviso-servidor" role="status">
          O computador da loja não está respondendo. Pedidos lançados ficam na fila e entram quando ele voltar.
        </p>
      )}

      {tela.tipo === 'mesas' && (
        <TelaMesas
          mesas={doc?.mesas || []}
          meuUsuarioId={loja.vinculoUserId}
          envios={envios}
          online={online}
          agora={agora}
          aoAbrirComanda={(id) => ir({ tipo: 'comanda', mesaId: id })}
          aoAbrirMesaLivre={abrirMesaLivre}
          podeOrganizar={podeOrganizar}
          aoMarcarLimpa={marcarLimpa}
          aoSepararMesa={separarMesa}
          aoVerEnvios={() => setVerEnvios(true)}
        />
      )}
      {tela.tipo === 'comanda' && (
        <TelaComanda
          key={tela.mesaId}
          loja={loja}
          mesaId={tela.mesaId}
          mesasDoc={doc}
          envios={envios}
          online={online}
          agora={agora}
          podeOrganizar={podeOrganizar}
          podeReceber={podeReceber}
          pessoaInicial={tela.pessoa ?? null}
          aoVoltar={voltar}
          aoLancar={(pessoa) => { trocarTopo({ ...tela, pessoa }); ir({ tipo: 'lancar', mesaId: tela.mesaId, pessoa }); }}
          aoFecharConta={() => ir({ tipo: 'conta', mesaId: tela.mesaId })}
          aoTrocarMesa={(id) => trocarTopo({ tipo: 'comanda', mesaId: id })}
        />
      )}
      {tela.tipo === 'lancar' && (
        <TelaLancar
          key={`l-${tela.mesaId}`}
          loja={loja}
          mesaId={tela.mesaId}
          mesa={mesaDa(tela.mesaId)}
          pessoaInicial={tela.pessoa ?? null}
          pessoasAoAbrir={tela.pessoasAoAbrir || 0}
          catalogo={catalogo}
          online={online}
          aoVoltar={voltar}
          aoEnviar={(dados) => enviarItens(tela.mesaId, dados, tela.pessoasAoAbrir)}
        />
      )}
      {tela.tipo === 'conta' && (
        <TelaConta
          key={`c-${tela.mesaId}`}
          loja={loja}
          mesaId={tela.mesaId}
          mesasDoc={doc}
          aoVoltar={voltar}
          aoConcluida={irParaMesas}
        />
      )}

      {verEnvios && (
        <Folha titulo="Envios deste celular" aoFechar={() => setVerEnvios(false)}>
          <div className="pm-envios">
            {envios.length === 0 && <p className="estado-vazio">Nada pendente.</p>}
            {envios.map((e) => {
              const mesa = mesaDa(e.mesaId);
              const total = (e.itens || []).reduce((s, i) => s + (Number(i.preco) || 0) * (Number(i.quantidade) || 0), 0);
              return (
                <div key={e.id} className={`pm-envio${e.situacao === 'erro' ? ' pm-envio-erro' : ''}`}>
                  <div className="pm-envio-topo">
                    <strong>{mesa ? `Mesa ${mesa.numero}` : 'Mesa'}</strong>
                    <span>{(e.itens || []).length} ite{(e.itens || []).length === 1 ? 'm' : 'ns'} · {formatarMoeda(total)}</span>
                  </div>
                  <span className="subtexto">
                    {e.situacao === 'erro' ? e.erro : e.situacao === 'na_fila' ? 'Guardado no celular, vai quando a internet voltar.' : e.situacao === 'enviando' ? 'Enviando...' : 'Chegou; o computador está lançando.'}
                  </span>
                  {e.situacao === 'erro' && (
                    <button type="button" className="btn-link-inline" onClick={() => filaRef.current?.dispensar(e.id)}>Entendi, tirar da lista</button>
                  )}
                </div>
              );
            })}
          </div>
        </Folha>
      )}

      {comErro.length > 0 && tela.tipo !== 'mesas' && (
        <button type="button" className="pm-aviso-envios pm-aviso-envios-erro pm-aviso-flutuante" onClick={() => setVerEnvios(true)}>
          <Icone nome="fechar" /> <span>{comErro.length} envio{comErro.length > 1 ? 's' : ''} com problema</span>
        </button>
      )}
    </div>
  );
}
