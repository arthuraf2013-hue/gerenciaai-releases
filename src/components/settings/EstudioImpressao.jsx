import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../common/Icon';
import { useEscToClose } from '../../hooks/useEscToClose';
import '../../styles/estudioImpressao.css';

// Estúdio de impressão: aparência da nota (recibo da venda) e da pré-nota
// (conferência da conta antes de pagar). A prévia à direita é montada pelo
// mesmo código que imprime (electron/services/impressaoLayout.js).

const ABAS = [
  { tipo: 'nota', rotulo: 'Nota (recibo)', icone: 'receipt' },
  { tipo: 'prenota', rotulo: 'Pré-nota (conferência)', icone: 'clipboard' },
  { tipo: 'cozinha', rotulo: 'Comanda da cozinha', icone: 'plate' },
  { tipo: 'qrmesa', rotulo: 'Display da mesa (QR)', icone: 'mobile' },
];
const CORES_QR = [['verde', '#0f6e56'], ['azul', '#185fa5'], ['laranja', '#b5521d'], ['vinho', '#8a2337'], ['roxo', '#4b3fa8'], ['preto', '#141a26']];
const PAPEIS = [
  { valor: 80, rotulo: 'Térmica 80mm' },
  { valor: 58, rotulo: 'Térmica 58mm' },
  { valor: 210, rotulo: 'Folha A4' },
];
// Chaves que "copiar o cabeçalho para a outra" leva junto.
const CHAVES_CABECALHO = ['logo', 'logoLarguraPct', 'logoPretoBranco', 'mostrarNomeLoja', 'nomeLoja', 'cabecalhoTexto', 'alinhamento', 'fonte', 'tamanho', 'separador'];
const LOGO_LARGURA_MAX_PX = 384; // largura útil de uma térmica de 80mm

/** Reduz a imagem escolhida para caber no rolo e no limite de tamanho. */
function lerLogo(arquivo) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg)$/.test(arquivo.type)) { reject(new Error('Use uma imagem PNG ou JPG.')); return; }
    const leitor = new FileReader();
    leitor.onerror = () => reject(new Error('Não consegui ler a imagem.'));
    leitor.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Imagem inválida.'));
      img.onload = () => {
        const escala = Math.min(1, LOGO_LARGURA_MAX_PX / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * escala));
        canvas.height = Math.max(1, Math.round(img.height * escala));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; // fundo branco: transparência some no papel
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        let url = canvas.toDataURL('image/png');
        if (url.length > 400000) url = canvas.toDataURL('image/jpeg', 0.85);
        if (url.length > 400000) { reject(new Error('Imagem grande demais. Use uma logo mais simples (até 300 KB).')); return; }
        resolve(url);
      };
      img.src = leitor.result;
    };
    leitor.readAsDataURL(arquivo);
  });
}

function Marcar({ rotulo, dica, checked, onChange, disabled }) {
  return (
    <label className="estudio-marcar" title={dica}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{rotulo}</span>
    </label>
  );
}

function Escolha({ valor, opcoes, onChange, rotulo }) {
  return (
    <div className="estudio-escolha" role="radiogroup" aria-label={rotulo}>
      {opcoes.map(([v, r]) => (
        <button key={v} type="button" role="radio" aria-checked={valor === v}
          className={valor === v ? 'estudio-escolha-ativa' : ''} onClick={() => onChange(v)}>{r}</button>
      ))}
    </div>
  );
}

export function EstudioImpressao({ onFechar, abaInicial = 'nota' }) {
  const [aba, setAba] = useState(abaInicial);
  const [carregado, setCarregado] = useState(null); // como está salvo
  const [configs, setConfigs] = useState(null); // como está na tela
  const [larguraMm, setLarguraMm] = useState(80);
  const [rodapeNota, setRodapeNota] = useState('');
  const [previa, setPrevia] = useState('');
  const [msg, setMsg] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [confirmarSaida, setConfirmarSaida] = useState(false);
  const arquivoRef = useRef(null);

  useEffect(() => {
    window.pdv.estudio.get().then((r) => {
      if (!r?.ok) { setMsg({ erro: true, texto: r?.error || 'Não consegui abrir o estúdio.' }); return; }
      setCarregado(r);
      setConfigs({ nota: r.nota, prenota: r.prenota, cozinha: r.cozinha, qrmesa: r.qrmesa });
      setLarguraMm(r.larguraMm);
      setRodapeNota(r.rodapeNota || '');
    });
  }, []);

  const c = configs?.[aba];
  const alterado = useMemo(() => {
    if (!carregado || !configs) return false;
    return JSON.stringify(configs.nota) !== JSON.stringify(carregado.nota)
      || JSON.stringify(configs.prenota) !== JSON.stringify(carregado.prenota)
      || JSON.stringify(configs.cozinha) !== JSON.stringify(carregado.cozinha)
      || JSON.stringify(configs.qrmesa) !== JSON.stringify(carregado.qrmesa)
      || larguraMm !== carregado.larguraMm || rodapeNota !== (carregado.rodapeNota || '');
  }, [carregado, configs, larguraMm, rodapeNota]);

  // Prévia: espera a pessoa parar de mexer um instante.
  useEffect(() => {
    if (!c) return undefined;
    const t = setTimeout(() => {
      window.pdv.estudio.previa({ tipo: aba, config: c, larguraMm: aba === 'cozinha' ? carregado?.larguraCozinha : larguraMm, rodapeNota }).then((r) => {
        if (r?.ok) setPrevia(r.html);
      });
    }, 200);
    return () => clearTimeout(t);
  }, [aba, c, larguraMm, rodapeNota]);

  function fechar() {
    if (alterado && !confirmarSaida) { setConfirmarSaida(true); return; }
    onFechar();
  }
  useEscToClose(fechar, true);

  const mudar = (chave, valor) => {
    setMsg(null);
    setConfigs((atual) => ({ ...atual, [aba]: { ...atual[aba], [chave]: valor } }));
  };

  async function escolherLogo(e) {
    const arquivo = e.target.files?.[0];
    e.target.value = '';
    if (!arquivo) return;
    try { mudar('logo', await lerLogo(arquivo)); } catch (err) { setMsg({ erro: true, texto: err.message }); }
  }

  function copiarCabecalho() {
    const outra = aba === 'nota' ? 'prenota' : 'nota';
    setConfigs((atual) => {
      const copia = { ...atual[outra] };
      for (const k of CHAVES_CABECALHO) copia[k] = atual[aba][k];
      return { ...atual, [outra]: copia };
    });
    setMsg({ texto: `Cabeçalho, logo e letra copiados para a ${outra === 'nota' ? 'nota' : 'pré-nota'}. Salve para gravar.` });
  }

  async function salvar() {
    setSalvando(true);
    setMsg(null);
    try {
      const r1 = await window.pdv.estudio.salvar({ tipo: 'nota', config: configs.nota, rodapeNota });
      if (!r1?.ok) throw new Error(r1?.error || 'Não consegui salvar a nota.');
      const r2 = await window.pdv.estudio.salvar({ tipo: 'prenota', config: configs.prenota });
      if (!r2?.ok) throw new Error(r2?.error || 'Não consegui salvar a pré-nota.');
      const r4 = await window.pdv.estudio.salvar({ tipo: 'cozinha', config: configs.cozinha });
      if (!r4?.ok) throw new Error(r4?.error || 'Não consegui salvar a comanda da cozinha.');
      const r5 = await window.pdv.estudio.salvar({ tipo: 'qrmesa', config: configs.qrmesa });
      if (!r5?.ok) throw new Error(r5?.error || 'Não consegui salvar o display da mesa.');
      if (larguraMm !== carregado.larguraMm) {
        const r3 = await window.pdv.print.updateReceiptConfig({ larguraMm });
        if (r3?.ok === false) throw new Error(r3.error);
      }
      const novo = { ...carregado, nota: r1.config, prenota: r2.config, cozinha: r4.config, qrmesa: r5.config, larguraMm, rodapeNota };
      setCarregado(novo);
      setConfigs({ nota: r1.config, prenota: r2.config, cozinha: r4.config, qrmesa: r5.config });
      setConfirmarSaida(false);
      setMsg({ texto: 'Salvo. As próximas impressões já saem assim.' });
    } catch (err) {
      setMsg({ erro: true, texto: err.message });
    } finally {
      setSalvando(false);
    }
  }

  function restaurar() {
    setConfigs((atual) => ({ ...atual, [aba]: { ...carregado.padrao[aba] } }));
    if (aba === 'nota') setRodapeNota('');
    setMsg({ texto: 'Voltou ao padrão nesta aba. Salve para gravar.' });
  }

  if (!configs) {
    return (
      <div className="modal-overlay">
        <div className="modal-card">{msg ? <p className="modal-error">{msg.texto}</p> : <p>Abrindo o estúdio...</p>}
          <button className="btn-secondary" onClick={onFechar}>Fechar</button></div>
      </div>
    );
  }

  const ePre = aba === 'prenota';
  const eCozinha = aba === 'cozinha';
  const eQr = aba === 'qrmesa';
  // Largura da prévia na tela: 1mm ≈ 3,78px; A4 é reduzido para caber.
  const larguraPrevia = eCozinha ? (carregado?.larguraCozinha || 80) : larguraMm;
  const larguraPreviaPx = eQr ? 700 : larguraPrevia === 210 ? 760 : Math.round(larguraPrevia * 3.78) + 24;

  return (
    <div className="modal-overlay">
      <div className="modal-card modal-card-fullscreen estudio" role="dialog" aria-label="Estúdio de impressão">
        <header className="estudio-topo">
          <h2><Icon name="palette" size={18} /> Estúdio de impressão</h2>
          <nav className="estudio-abas" aria-label="O que personalizar">
            {ABAS.map((a) => (
              <button key={a.tipo} type="button" className={aba === a.tipo ? 'estudio-aba estudio-aba-ativa' : 'estudio-aba'} onClick={() => setAba(a.tipo)}>
                <Icon name={a.icone} size={15} /> {a.rotulo}
              </button>
            ))}
          </nav>
          <div className="estudio-acoes">
            {alterado && <span className="estudio-alterado">Alterações não salvas</span>}
            <button type="button" className="btn-secondary" onClick={restaurar}><Icon name="restore" size={15} /> Padrão</button>
            <button type="button" className="btn-primary" onClick={salvar} disabled={salvando || !alterado}>
              <Icon name="save" size={15} /> {salvando ? 'Salvando...' : 'Salvar'}
            </button>
            <button type="button" className="btn-secondary" onClick={fechar} aria-label="Fechar o estúdio"><Icon name="close" size={15} /></button>
          </div>
        </header>

        {confirmarSaida && (
          <div className="estudio-aviso">
            Há alterações não salvas.
            <button type="button" className="btn-primary" onClick={salvar}>Salvar e continuar</button>
            <button type="button" className="btn-secondary" onClick={onFechar}>Sair sem salvar</button>
            <button type="button" className="btn-secondary" onClick={() => setConfirmarSaida(false)}>Voltar</button>
          </div>
        )}
        {msg && <p className={msg.erro ? 'modal-error estudio-msg' : 'io-message estudio-msg'}>{msg.texto}</p>}

        <div className="estudio-corpo">
          <div className="estudio-painel">
            {eQr ? (
              <>
                <section className="estudio-grupo">
                  <h3>Folha</h3>
                  <Escolha rotulo="Papel" valor={c.papel} onChange={(v) => mudar('papel', v)}
                    opcoes={[['a4', 'A4'], ['carta', 'Carta'], ['oficio', 'Ofício'], ['a6', 'A6'], ['termica', 'Térmica']]} />
                  {c.papel !== 'a6' && c.papel !== 'termica' && (
                    <>
                      <Escolha rotulo="Orientação da folha" valor={c.orientacao} onChange={(v) => mudar('orientacao', v)}
                        opcoes={[['paisagem', 'Deitada'], ['retrato', 'Em pé']]} />
                      <label className="estudio-campo">QR por folha
                        <select value={c.porFolha} onChange={(e) => mudar('porFolha', Number(e.target.value))}>
                          {[1, 2, 4, 6, 8, 9, 12, 16].map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </label>
                    </>
                  )}
                  <Marcar rotulo="Linha tracejada para recortar" checked={c.linhaDeCorte} onChange={(v) => mudar('linhaDeCorte', v)} />
                  <p className="estudio-dica">É o padrão. Na hora de gerar o PDF dá para mudar a quantidade por folha.</p>
                </section>
                <section className="estudio-grupo">
                  <h3>Cor</h3>
                  <div className="estudio-cores" role="radiogroup" aria-label="Cor do display">
                    {CORES_QR.map(([nome, hex]) => (
                      <button key={nome} type="button" role="radio" aria-checked={c.cor === nome} aria-label={nome}
                        className={c.cor === nome ? 'estudio-cor estudio-cor-ativa' : 'estudio-cor'} style={{ background: hex }} onClick={() => mudar('cor', nome)} />
                    ))}
                  </div>
                </section>
                <section className="estudio-grupo">
                  <h3>Logo e loja</h3>
                  <div className="estudio-logo">
                    {c.logo ? <img src={c.logo} alt="Logo atual" /> : <span className="estudio-logo-vazio"><Icon name="image" size={22} /></span>}
                    <div className="estudio-logo-botoes">
                      <button type="button" className="btn-secondary" onClick={() => arquivoRef.current?.click()}>
                        <Icon name="image" size={15} /> {c.logo ? 'Trocar logo' : 'Colocar logo'}
                      </button>
                      {c.logo && <button type="button" className="btn-secondary" onClick={() => mudar('logo', '')}>Tirar</button>}
                      <input ref={arquivoRef} type="file" accept="image/png,image/jpeg" hidden onChange={escolherLogo} />
                    </div>
                  </div>
                  <Marcar rotulo="Mostrar o nome da loja" checked={c.mostrarNomeLoja} onChange={(v) => mudar('mostrarNomeLoja', v)} />
                  {c.mostrarNomeLoja && (
                    <label className="estudio-campo">Nome impresso (vazio = nome da loja)
                      <input value={c.nomeLoja} maxLength={60} onChange={(e) => mudar('nomeLoja', e.target.value)} />
                    </label>
                  )}
                </section>
                <section className="estudio-grupo">
                  <h3>Textos</h3>
                  <label className="estudio-campo">Chamada (embaixo do nome da mesa)
                    <input value={c.titulo} maxLength={60} onChange={(e) => mudar('titulo', e.target.value)} placeholder="Peça por aqui" />
                  </label>
                  <label className="estudio-campo">Instrução (abaixo do QR)
                    <textarea rows={2} maxLength={160} value={c.instrucao} onChange={(e) => mudar('instrucao', e.target.value)} />
                  </label>
                  <label className="estudio-campo">Rodapé (ex.: Wi-Fi, Instagram)
                    <input value={c.rodape} maxLength={300} onChange={(e) => mudar('rodape', e.target.value)} placeholder="Wi-Fi: SaborDaTerra · @sabordaterra" />
                  </label>
                  <p className="estudio-dica">Com 12 ou 16 por folha, a logo e a instrução saem do cartão para o QR caber.</p>
                </section>
              </>
            ) : eCozinha ? (
              <>
                <section className="estudio-grupo">
                  <h3>Papel</h3>
                  <p className="estudio-dica">A largura ({carregado?.larguraCozinha || 80} mm) e a impressora vêm de Configurações → Cozinha.</p>
                </section>
                <section className="estudio-grupo">
                  <h3>Letra</h3>
                  <Escolha rotulo="Tipo de letra" valor={c.fonte} onChange={(v) => mudar('fonte', v)} opcoes={[['sans', 'Moderna'], ['mono', 'Cupom (mono)']]} />
                  <Escolha rotulo="Tamanho dos itens" valor={c.tamanho} onChange={(v) => mudar('tamanho', v)} opcoes={[['pequena', 'Pequena'], ['normal', 'Normal'], ['grande', 'Grande']]} />
                  <Escolha rotulo="Linha separadora" valor={c.separador} onChange={(v) => mudar('separador', v)} opcoes={[['tracejado', '- - - Tracejada'], ['continuo', '—— Contínua']]} />
                </section>
                <section className="estudio-grupo">
                  <h3>Mesa</h3>
                  <Marcar rotulo="Número da mesa em destaque" checked={c.mostrarMesa} onChange={(v) => mudar('mostrarMesa', v)}
                    dica="Comanda de mesa sai com a mesa (e as unidas: MESA 4 + 5). Sem mesa sai a senha ou BALCÃO." />
                  {c.mostrarMesa && (
                    <div className="estudio-sub">
                      <Escolha rotulo="Tamanho do número da mesa" valor={c.mesaTamanho} onChange={(v) => mudar('mesaTamanho', v)}
                        opcoes={[['normal', 'Normal'], ['grande', 'Grande'], ['enorme', 'Bem grande']]} />
                      <Marcar rotulo="Número da mesa em negrito" checked={c.mesaNegrito} onChange={(v) => mudar('mesaNegrito', v)} />
                    </div>
                  )}
                </section>
                <section className="estudio-grupo">
                  <h3>Conteúdo</h3>
                  <label className="estudio-campo">Título acima da mesa (opcional)
                    <input value={c.titulo} maxLength={60} onChange={(e) => mudar('titulo', e.target.value)} placeholder="Ex: COZINHA ou CHAPA" />
                  </label>
                  <Marcar rotulo="Valor de cada item" checked={c.mostrarValores} onChange={(v) => mudar('mostrarValores', v)}
                    dica="Diferencia variações do mesmo prato (ex.: peixe de R$ 45 e de R$ 60). Vale também para a tela Cozinha." />
                  {c.mostrarValores && (
                    <div className="estudio-sub">
                      <Marcar rotulo="Total da comanda no fim" checked={c.mostrarTotal} onChange={(v) => mudar('mostrarTotal', v)} />
                    </div>
                  )}
                  <Marcar rotulo="Data e hora" checked={c.mostrarDataHora} onChange={(v) => mudar('mostrarDataHora', v)} />
                  <Marcar rotulo="Atendente que abriu a conta" checked={c.mostrarOperador} onChange={(v) => mudar('mostrarOperador', v)} />
                  <Marcar rotulo="Nome do cliente (senha e pedidos do WhatsApp/QR)" checked={c.mostrarCliente} onChange={(v) => mudar('mostrarCliente', v)} />
                  <Marcar rotulo="Pessoa da mesa de cada item" checked={c.mostrarPessoa} onChange={(v) => mudar('mostrarPessoa', v)} />
                  <Marcar rotulo="Observações dos itens (ex: sem cebola)" checked={c.mostrarObservacoes} onChange={(v) => mudar('mostrarObservacoes', v)} />
                </section>
                <section className="estudio-grupo">
                  <h3>Rodapé</h3>
                  <textarea rows={2} maxLength={300} value={c.rodape} onChange={(e) => mudar('rodape', e.target.value)} aria-label="Rodapé da comanda" placeholder="Ex: Conferir antes de sair da cozinha" />
                </section>
              </>
            ) : (
              <>

            <section className="estudio-grupo">
              <h3>Papel</h3>
              <Escolha rotulo="Papel" valor={larguraMm} onChange={setLarguraMm} opcoes={PAPEIS.map((p) => [p.valor, p.rotulo])} />
              <p className="estudio-dica">Vale para a nota e para a pré-nota.</p>
            </section>

            <section className="estudio-grupo">
              <h3>Cabeçalho</h3>
              <div className="estudio-logo">
                {c.logo
                  ? <img src={c.logo} alt="Logo atual" />
                  : <span className="estudio-logo-vazio"><Icon name="image" size={22} /></span>}
                <div className="estudio-logo-botoes">
                  <button type="button" className="btn-secondary" onClick={() => arquivoRef.current?.click()}>
                    <Icon name="image" size={15} /> {c.logo ? 'Trocar logo' : 'Colocar logo'}
                  </button>
                  {c.logo && <button type="button" className="btn-secondary" onClick={() => mudar('logo', '')}>Tirar</button>}
                  <input ref={arquivoRef} type="file" accept="image/png,image/jpeg" hidden onChange={escolherLogo} />
                </div>
              </div>
              {c.logo && (
                <>
                  <label className="estudio-campo">Tamanho da logo: {c.logoLarguraPct}%
                    <input type="range" min="20" max="100" step="5" value={c.logoLarguraPct} onChange={(e) => mudar('logoLarguraPct', Number(e.target.value))} />
                  </label>
                  <Marcar rotulo="Logo em preto e branco (melhor na térmica)" checked={c.logoPretoBranco} onChange={(v) => mudar('logoPretoBranco', v)} />
                </>
              )}
              <Marcar rotulo="Mostrar o nome da loja" checked={c.mostrarNomeLoja} onChange={(v) => mudar('mostrarNomeLoja', v)} />
              {c.mostrarNomeLoja && (
                <label className="estudio-campo">Nome impresso (vazio = nome da loja)
                  <input value={c.nomeLoja} maxLength={60} onChange={(e) => mudar('nomeLoja', e.target.value)} placeholder="Ex: Restaurante Sabor da Terra" />
                </label>
              )}
              <label className="estudio-campo">Linhas abaixo do nome
                <textarea rows={3} maxLength={400} value={c.cabecalhoTexto} onChange={(e) => mudar('cabecalhoTexto', e.target.value)}
                  placeholder={'CNPJ 00.000.000/0001-00\nRua das Flores, 123 — Recife\n(81) 3333-4444 · @minhaloja'} />
              </label>
              <Escolha rotulo="Alinhamento do cabeçalho" valor={c.alinhamento} onChange={(v) => mudar('alinhamento', v)} opcoes={[['centro', 'Centralizado'], ['esquerda', 'À esquerda']]} />
              <button type="button" className="estudio-link" onClick={copiarCabecalho}>
                <Icon name="duplicate" size={13} /> Usar este cabeçalho também na {ePre ? 'nota' : 'pré-nota'}
              </button>
            </section>

            <section className="estudio-grupo">
              <h3>Letra</h3>
              <Escolha rotulo="Tipo de letra" valor={c.fonte} onChange={(v) => mudar('fonte', v)} opcoes={[['mono', 'Cupom (mono)'], ['sans', 'Moderna']]} />
              <Escolha rotulo="Tamanho da letra" valor={c.tamanho} onChange={(v) => mudar('tamanho', v)} opcoes={[['pequena', 'Pequena'], ['normal', 'Normal'], ['grande', 'Grande']]} />
              <Escolha rotulo="Linha separadora" valor={c.separador} onChange={(v) => mudar('separador', v)} opcoes={[['tracejado', '- - - Tracejada'], ['continuo', '—— Contínua']]} />
            </section>

            <section className="estudio-grupo">
              <h3>Conteúdo</h3>
              <label className="estudio-campo">Título {ePre ? '' : '(opcional)'}
                <input value={c.titulo} maxLength={60} onChange={(e) => mudar('titulo', e.target.value)} placeholder={ePre ? 'PRÉ-CONTA · CONFERÊNCIA' : 'Ex: RECIBO DE VENDA'} />
              </label>
              <Marcar rotulo={ePre ? 'Código da conta' : 'Código da venda'} checked={c.mostrarCodigoVenda} onChange={(v) => mudar('mostrarCodigoVenda', v)} />
              <Marcar rotulo="Data e hora" checked={c.mostrarDataHora} onChange={(v) => mudar('mostrarDataHora', v)} />
              <Marcar rotulo="Número da mesa" checked={c.mostrarMesa} onChange={(v) => mudar('mostrarMesa', v)}
                dica="Só aparece em conta de mesa. No balcão não sai nada." />
              {c.mostrarMesa && (
                <div className="estudio-sub">
                  <Escolha rotulo="Tamanho do número da mesa" valor={c.mesaTamanho} onChange={(v) => mudar('mesaTamanho', v)}
                    opcoes={[['normal', 'Normal'], ['grande', 'Grande'], ['enorme', 'Bem grande']]} />
                  <Marcar rotulo="Número da mesa em negrito" checked={c.mesaNegrito} onChange={(v) => mudar('mesaNegrito', v)} />
                </div>
              )}
              <Marcar rotulo="Atendente" checked={c.mostrarOperador} onChange={(v) => mudar('mostrarOperador', v)} />
              <Marcar rotulo="Cliente" checked={c.mostrarCliente} onChange={(v) => mudar('mostrarCliente', v)} />
              <Marcar rotulo="Coluna de preço unitário" checked={c.colunaUnitario} onChange={(v) => mudar('colunaUnitario', v)} />
              <Marcar rotulo="Observações dos itens (ex: sem cebola)" checked={c.mostrarObservacoes} onChange={(v) => mudar('mostrarObservacoes', v)} />
              {!ePre && <Marcar rotulo="Formas de pagamento" checked={c.mostrarPagamentos} onChange={(v) => mudar('mostrarPagamentos', v)} />}
              {ePre && (
                <>
                  <Marcar rotulo="Separar os itens por pessoa da mesa" checked={c.agruparPorPessoa} onChange={(v) => mudar('agruparPorPessoa', v)}
                    dica="Quando a conta tem pessoas, cada uma aparece com os itens dela e a parte a pagar." />
                  <Marcar rotulo="Valor dividido pelo número de pessoas" checked={c.mostrarDivisao} onChange={(v) => mudar('mostrarDivisao', v)} />
                  <label className="estudio-campo">Sugerir serviço (%) quando a conta não tem taxa — 0 desliga
                    <input type="number" min="0" max="30" step="1" value={c.taxaSugeridaPercentual} onChange={(e) => mudar('taxaSugeridaPercentual', e.target.value === '' ? 0 : Number(e.target.value))} />
                  </label>
                  <Marcar rotulo="QR Code do Pix com o valor a pagar" checked={c.pixQr} onChange={(v) => mudar('pixQr', v)}
                    disabled={!carregado.pixConfigurado && !c.pixQr} />
                  {!carregado.pixConfigurado && <p className="estudio-dica">Para o QR do Pix, cadastre a chave em Configurações → Pagamento.</p>}
                </>
              )}
            </section>

            <section className="estudio-grupo">
              <h3>Rodapé</h3>
              {ePre ? (
                <textarea rows={3} maxLength={300} value={c.rodape} onChange={(e) => mudar('rodape', e.target.value)} aria-label="Rodapé da pré-nota" />
              ) : (
                <textarea rows={3} maxLength={300} value={rodapeNota} onChange={(e) => { setMsg(null); setRodapeNota(e.target.value); }}
                  aria-label="Rodapé da nota" placeholder="Obrigado pela preferência!" />
              )}
              {ePre
                ? <p className="estudio-dica">"NÃO É DOCUMENTO FISCAL" sai sempre, em cima e embaixo.</p>
                : <p className="estudio-dica">O rodapé da nota também vai na mensagem do WhatsApp. Os dados da NFC-e (chave, protocolo e QR) saem sempre que a venda tiver nota fiscal.</p>}
            </section>
              </>
            )}
          </div>

          <div className="estudio-previa" aria-label="Prévia da impressão">
            <p className="estudio-previa-rotulo">Prévia com uma venda de exemplo</p>
            <div className="estudio-papel" style={{ width: larguraPreviaPx }}>
              <iframe title="Prévia da impressão" sandbox="" srcDoc={previa} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
