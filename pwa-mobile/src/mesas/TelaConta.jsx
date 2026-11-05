import { useEffect, useRef, useState } from 'react';
import { mostrarToast } from '../../pdv-util.js';
import { consultar } from '../../pdv-servidor.js';
import { Folha, Icone } from './comum.jsx';
import { METODOS, fecharPagamentos, formatarMoeda, lerValor, reais, rotuloMesaComUnidas, valorDaSelecao } from './logica.js';
import { executar, observarComanda } from './servidorMesas.js';

const NOTAS = [2, 5, 10, 20, 50, 100, 200];
const ICONE_METODO = { dinheiro: 'dinheiro', cartao_credito: 'cartao', cartao_debito: 'cartao', pix: 'pix' };

/** Fechar a conta pelo celular do operador: mesa inteira ou por pessoa. */
export default function TelaConta({ loja, mesaId, mesasDoc, aoVoltar, aoConcluida }) {
  const [comanda, setComanda] = useState(null);
  const [carregou, setCarregou] = useState(false);
  const [modo, setModo] = useState('tudo');
  const [selecionados, setSelecionados] = useState([]);
  const [pagamentos, setPagamentos] = useState([]);
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState(null);
  const [pix, setPix] = useState(null);

  useEffect(() => observarComanda(loja.installId, mesaId, (r) => { setComanda(r.comanda); setCarregou(true); }), [loja.installId, mesaId]);

  const conta = comanda?.conta || null;
  const devedores = (conta?.grupos || []).filter((g) => g.devido > 0);
  const pagos = (conta?.grupos || []).filter((g) => g.devido <= 0 && g.valor > 0);
  const tudo = modo === 'tudo';
  const valor = valorDaSelecao(conta, selecionados, tudo);
  const fechamento = fecharPagamentos(valor, pagamentos.map((l) => {
    const recebido = lerValor(l.recebidoTexto);
    return l.metodo === 'dinheiro' && Number.isFinite(recebido) ? { ...l, valorRecebido: recebido } : l;
  }));
  const excede = fechamento.linhas.some((l) => l.excede);
  const metodos = (mesasDoc?.metodosPagamento || []).filter((m) => METODOS[m]);
  const pronto = valor > 0 && pagamentos.length > 0 && fechamento.faltaC === 0 && !excede && mesasDoc?.caixaAberto;

  // A conta mudou (item novo, pagamento no computador): o que estava montado não vale mais.
  const valorAnterior = useRef(valor);
  useEffect(() => {
    if (valorAnterior.current !== valor && pagamentos.length) {
      setPagamentos([]);
      setAviso('A conta mudou. Confira o valor e escolha a forma de pagamento de novo.');
    }
    valorAnterior.current = valor;
  }, [valor, pagamentos.length]);

  // Quem já pagou sai da seleção.
  useEffect(() => {
    setSelecionados((s) => s.filter((g) => devedores.some((d) => d.grupo === g)));
  }, [conta]); // eslint-disable-line react-hooks/exhaustive-deps

  const alternar = (grupo) => setSelecionados((s) => (s.includes(grupo) ? s.filter((x) => x !== grupo) : [...s, grupo]));

  const adicionarForma = (metodo) => {
    const falta = reais(fechamento.faltaC);
    if (!(falta > 0)) return;
    setPagamentos((p) => [...p, { chave: `${metodo}-${Date.now()}`, metodo, valor: falta, valorTexto: String(falta.toFixed(2)).replace('.', ','), recebidoTexto: '' }]);
  };

  const mudarLinha = (chave, campos) => setPagamentos((p) => p.map((l) => (l.chave === chave ? { ...l, ...campos } : l)));

  const mudarTaxa = async (percentual) => {
    if (enviando) return;
    setEnviando(true);
    try {
      await executar(loja.installId, 'taxa_servico', { mesaId, percentual });
    } catch (err) {
      mostrarToast(err.message, 'erro');
    } finally {
      setEnviando(false);
    }
  };

  const mostrarPix = async (linha) => {
    setPix({ carregando: true, valor: linha.valor });
    try {
      const txid = `M${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
      const r = await consultar(loja.installId, 'pix', { valor: linha.valor, txid });
      setPix({ valor: r.valor, qr: r.qr, payload: r.payload });
    } catch (err) {
      setPix({ erro: err.message, valor: linha.valor });
    }
  };

  const receber = async () => {
    if (!pronto || enviando) return;
    setEnviando(true);
    setAviso(null);
    try {
      const r = await executar(loja.installId, 'receber', {
        mesaId,
        grupos: tudo ? 'tudo' : selecionados,
        valorEsperado: valor,
        pagamentos: pagamentos.map((l) => ({
          metodo: l.metodo,
          valor: l.valor,
          ...(l.metodo === 'dinheiro' && Number.isFinite(lerValor(l.recebidoTexto)) ? { valorRecebido: lerValor(l.recebidoTexto) } : {}),
        })),
      }, { timeoutMs: 30000 });
      setPagamentos([]);
      setSelecionados([]);
      const troco = r.troco > 0 ? ` Troco: ${formatarMoeda(r.troco)}.` : '';
      if (r.finalizada) {
        mostrarToast(`Conta fechada. Mesa liberada.${troco}`);
        aoConcluida();
        return;
      }
      if (r.finalizar) {
        setAviso(`${r.avisoFinalizacao || 'Pago. A venda vai finalizar no computador.'}${troco}`);
        return;
      }
      mostrarToast(`Recebido.${troco} Falta ${formatarMoeda(r.restante)}.`);
    } catch (err) {
      setAviso(err.semResposta
        ? 'O computador não respondeu a tempo. Antes de cobrar de novo, confira na conta se o pagamento entrou.'
        : err.message);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="pm-tela pm-tela-conta">
      <header className="pm-barra">
        <button type="button" className="btn-icone" aria-label="Voltar para a comanda" onClick={aoVoltar}><Icone nome="voltar" /></button>
        <div className="pm-barra-titulo">
          <strong>Conta · {comanda ? rotuloMesaComUnidas(comanda) : 'Mesa'}</strong>
          {conta && <span className="subtexto">Total {formatarMoeda(conta.totalAPagar)}{conta.pago > 0 ? ` · pago ${formatarMoeda(conta.pago)}` : ''}</span>}
        </div>
      </header>

      {!carregou && <p className="estado-vazio"><span className="spinner spinner-pequeno" /> Carregando a conta...</p>}
      {carregou && !conta && <div className="pm-vazio-grande"><p>Esta mesa não tem conta aberta.</p><button type="button" className="btn-secundario" onClick={aoVoltar}>Voltar</button></div>}

      {conta && (
        <div className="pm-conta">
          {!mesasDoc?.caixaAberto && <p className="aviso aviso-erro">O caixa está fechado no computador da loja. Abra o caixa lá para receber.</p>}
          {aviso && <p className="aviso aviso-alerta" role="status">{aviso}</p>}

          <div className="pm-filtros" role="tablist" aria-label="Como dividir">
            <button type="button" role="tab" aria-selected={tudo} className={`chip${tudo ? ' chip-ativo' : ''}`} onClick={() => { setModo('tudo'); setPagamentos([]); }}>Mesa inteira</button>
            <button type="button" role="tab" aria-selected={!tudo} className={`chip${!tudo ? ' chip-ativo' : ''}`} onClick={() => { setModo('pessoas'); setPagamentos([]); }}>Por pessoa</button>
          </div>

          {tudo ? (
            <div className="pm-totais">
              <div><span>Itens</span><span>{formatarMoeda(conta.subtotal)}</span></div>
              {conta.desconto > 0 && <div><span>Desconto</span><span>− {formatarMoeda(conta.desconto)}</span></div>}
              <div>
                <span>Taxa de serviço</span>
                {conta.pago > 0 ? <span>{conta.taxaServicoPercentual}%</span> : (
                  <span className="pm-taxa">
                    {[0, 10].map((t) => (
                      <button key={t} type="button" className={`chip${Number(conta.taxaServicoPercentual) === t ? ' chip-ativo' : ''}`} disabled={enviando} onClick={() => mudarTaxa(t)}>
                        {t === 0 ? 'Sem' : `${t}%`}
                      </button>
                    ))}
                  </span>
                )}
              </div>
              <div className="pm-totais-total"><span>Total</span><strong>{formatarMoeda(conta.totalAPagar)}</strong></div>
              {conta.pago > 0 && <div><span>Já pago</span><span>{formatarMoeda(conta.pago)}</span></div>}
            </div>
          ) : (
            <div className="pm-pessoas-conta">
              {devedores.map((g) => (
                <label key={g.grupo} className={`pm-pessoa-conta${selecionados.includes(g.grupo) ? ' pm-pessoa-conta-ativa' : ''}`}>
                  <input type="checkbox" checked={selecionados.includes(g.grupo)} onChange={() => { alternar(g.grupo); setPagamentos([]); }} />
                  <span className="pm-pessoa-conta-nome">{g.rotulo}</span>
                  <span className="pm-pessoa-conta-valor">
                    {formatarMoeda(g.devido)}
                    {g.pago > 0 && <small>de {formatarMoeda(g.valor)}</small>}
                  </span>
                </label>
              ))}
              {pagos.map((g) => (
                <div key={g.grupo} className="pm-pessoa-conta pm-pessoa-conta-paga">
                  <Icone nome="check" />
                  <span className="pm-pessoa-conta-nome">{g.rotulo}</span>
                  <span className="pm-pessoa-conta-valor">pago</span>
                </div>
              ))}
              {conta.taxaServicoPercentual > 0 && <p className="subtexto">Com {conta.taxaServicoPercentual}% de serviço, dividido na proporção de cada um.</p>}
            </div>
          )}

          <div className="pm-a-receber">
            <span>A receber</span>
            <strong>{formatarMoeda(valor)}</strong>
          </div>

          {valor > 0 && (
            <div className="pm-pagamentos">
              {fechamento.linhas.map((l) => (
                <div key={l.chave} className="pm-pagamento">
                  <div className="pm-pagamento-topo">
                    <span className="pm-pagamento-metodo"><Icone nome={ICONE_METODO[l.metodo]} /> {METODOS[l.metodo]}</span>
                    <input className="campo pm-campo-valor" inputMode="decimal" aria-label={`Valor em ${METODOS[l.metodo]}`} value={l.valorTexto}
                      onChange={(e) => { const v = lerValor(e.target.value); mudarLinha(l.chave, { valorTexto: e.target.value, valor: Number.isFinite(v) ? Math.round(v * 100) / 100 : 0 }); }} />
                    <button type="button" className="btn-icone" aria-label="Tirar esta forma" onClick={() => setPagamentos((p) => p.filter((x) => x.chave !== l.chave))}><Icone nome="fechar" /></button>
                  </div>
                  {l.metodo === 'dinheiro' && (
                    <div className="pm-dinheiro">
                      <label className="pm-rotulo" htmlFor={`rec-${l.chave}`}>Recebido</label>
                      <input id={`rec-${l.chave}`} className="campo pm-campo-valor" inputMode="decimal" placeholder={formatarMoeda(l.valor)}
                        value={l.recebidoTexto} onChange={(e) => mudarLinha(l.chave, { recebidoTexto: e.target.value })} />
                      <div className="atalhos-valor">
                        {NOTAS.filter((n) => n >= l.valor).slice(0, 4).map((n) => (
                          <button key={n} type="button" className="chip" onClick={() => mudarLinha(l.chave, { recebidoTexto: String(n) })}>{formatarMoeda(n)}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  {l.metodo === 'pix' && (
                    <button type="button" className="btn-link-inline" onClick={() => mostrarPix(l)}>Mostrar QR do Pix</button>
                  )}
                  {l.excede && <p className="msg-erro">{METODOS[l.metodo]} não pode passar do que falta.</p>}
                </div>
              ))}

              {fechamento.faltaC > 0 && (
                <>
                  <span className="pm-rotulo">{pagamentos.length ? `Falta ${formatarMoeda(reais(fechamento.faltaC))} — mais uma forma:` : 'Como vai pagar?'}</span>
                  <div className="metodos-pagamento">
                    {metodos.map((m) => (
                      <button key={m} type="button" className="metodo" onClick={() => adicionarForma(m)}>
                        <Icone nome={ICONE_METODO[m]} /> {METODOS[m]}
                      </button>
                    ))}
                  </div>
                  {metodos.length === 0 && <p className="subtexto">Nenhuma forma de pagamento liberada para o celular (Configurações → Celular, no computador).</p>}
                </>
              )}
              {fechamento.trocoC > 0 && <p className="preview-troco">Troco: <strong>{formatarMoeda(reais(fechamento.trocoC))}</strong></p>}
            </div>
          )}

          <footer className="pm-rodape">
            <button type="button" className="btn-primario" disabled={!pronto || enviando} onClick={receber}>
              {enviando ? 'Enviando...' : `Receber ${formatarMoeda(valor)}`}
            </button>
          </footer>
        </div>
      )}

      {pix && <FolhaPix pix={pix} aoFechar={() => setPix(null)} />}
    </div>
  );
}

function FolhaPix({ pix, aoFechar }) {
  const canvas = useRef(null);
  useEffect(() => { if (pix.qr && canvas.current) desenharQr(canvas.current, pix.qr); }, [pix.qr]);
  return (
    <Folha titulo={`Pix — ${formatarMoeda(pix.valor)}`} aoFechar={aoFechar}>
      <div className="area-pix">
        {pix.carregando && <p className="subtexto"><span className="spinner spinner-pequeno" /> Gerando QR Code no computador da loja...</p>}
        {pix.erro && <p className="msg-erro">{pix.erro}</p>}
        {pix.qr && (
          <>
            <canvas ref={canvas} width="260" height="260" aria-label="QR Code do Pix" />
            <p className="subtexto centro">Peça para o cliente ler o QR no app do banco e confira o recebimento antes de tocar em Receber.</p>
            <button type="button" className="btn-secundario" onClick={async () => {
              try { await navigator.clipboard.writeText(pix.payload); mostrarToast('Código Pix copiado.'); } catch { mostrarToast('Não foi possível copiar.', 'erro'); }
            }}>Copiar "Pix copia e cola"</button>
          </>
        )}
        <button type="button" className="btn-primario" onClick={aoFechar}>Voltar para a conta</button>
      </div>
    </Folha>
  );
}

function desenharQr(canvas, qr) {
  if (!canvas || !qr?.size || !qr?.bits) return;
  const margem = 4;
  const total = qr.size + margem * 2;
  const escala = Math.max(1, Math.floor(260 / total));
  const lado = escala * total;
  canvas.width = lado;
  canvas.height = lado;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, lado, lado);
  g.fillStyle = '#000000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.bits[y * qr.size + x] === '1') g.fillRect((x + margem) * escala, (y + margem) * escala, escala, escala);
    }
  }
}
