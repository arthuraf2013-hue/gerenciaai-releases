import { useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import Icon from '../common/Icon';
import { RegrasTributariasTab } from './TributacaoErp';
import { NcmPorIa } from './CadastroAutomatico';
import { GlossarioTab, Termo } from './Glossario';
import { brl, dataBR, mesCurto, mesAtualLocal, somarMeses, Abas, useModulosErp, ModuloInativo } from './erpUtils';

/**
 * Assistente fiscal (ERP, Fase 4): facilitadores para o lojista e para o
 * contador. Não apura nem transmite nada; estimativas vêm marcadas.
 */

const ABAS = [
  { id: 'painel', icone: 'chart', rotulo: 'Painel' },
  { id: 'cadastro', icone: 'tag', rotulo: 'Cadastro fiscal' },
  { id: 'mei', icone: 'document', rotulo: 'Relatório do MEI' },
  { id: 'contador', icone: 'archive', rotulo: 'Pacote do contador' },
  { id: 'regras', icone: 'receipt', rotulo: 'Regras tributárias' },
  { id: 'ajustes', icone: 'sliders', rotulo: 'Ajustes' },
  { id: 'glossario', icone: 'book', rotulo: 'Glossário' },
];

const REGIME = { mei: 'MEI', simples_nacional: 'Simples Nacional', lucro_presumido: 'Lucro Presumido', lucro_real: 'Lucro Real' };

export function AssistenteFiscalScreen() {
  const [aba, setAba] = useState('painel');
  const modulos = useModulosErp();
  if (modulos === null) return <div className="screen"><p className="empty-state">Carregando...</p></div>;
  if (!modulos.fiscal) return <ModuloInativo modulo="fiscal" semPermissao={modulos.semPermissao.fiscal} />;
  return (
    <div className="screen">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="document" size={20} /> Fiscal</h1>
      <p className="screen-hint">Ajuda a manter o cadastro certo, acompanhar limites e mandar tudo pronto para o contador. Não substitui o contador.</p>
      <Abas abas={ABAS} atual={aba} onChange={setAba} />
      <div style={{ marginTop: 12 }}>
        {aba === 'painel' && <PainelFiscal irPara={setAba} />}
        {aba === 'cadastro' && <CadastroFiscal />}
        {aba === 'mei' && <RelatorioMei />}
        {aba === 'contador' && <PacoteContador />}
        {aba === 'regras' && <RegrasTributariasTab />}
        {aba === 'ajustes' && <AjustesFiscais />}
        {aba === 'glossario' && <GlossarioTab />}
      </div>
    </div>
  );
}

function BarraLimite({ usado, rotulo }) {
  const pct = Math.max(0, Math.min(100, usado || 0));
  const cor = usado >= 100 ? 'var(--color-danger)' : usado >= 80 ? 'var(--color-warning-text)' : 'var(--color-primary)';
  return (
    <div>
      <div className="bar-track" style={{ height: 16 }}><div className="bar-fill" style={{ width: `${pct}%`, background: cor }} /></div>
      <div className="screen-hint" style={{ margin: '6px 0 0' }}>{rotulo}</div>
    </div>
  );
}

function PainelFiscal({ irPara }) {
  const [p, setP] = useState(null);
  useEffect(() => { window.pdv.assistenteFiscal.painel({ locationId: window.APP_LOCATION_ID }).then(setP); }, []);
  if (!p) return <p className="empty-state">Carregando...</p>;
  if (p.ok === false) return <p className="modal-error">{p.error}</p>;
  const maxMes = Math.max(1, ...p.meses.map((m) => m.receita || 0));
  return (
    <div>
      {p.avisos.map((a) => (
        <p key={a.texto} className={a.nivel === 'critico' ? 'modal-error erp-aviso' : a.nivel === 'aviso' ? 'io-message-aviso' : 'io-message'} style={{ marginBottom: 8 }}>
          <Icon name={a.nivel === 'info' ? 'sparkle' : 'warning'} size={15} /> {a.texto}
        </p>
      ))}
      <div className="dashboard-stats">
        <div className="stat-card"><span>Regime</span><strong>{REGIME[p.regime] || 'Não informado'}</strong></div>
        <div className="stat-card"><span>Faturamento em {p.ano}</span><strong>{brl(p.acumulado)}</strong></div>
        <div className="stat-card"><span>No ritmo atual, o ano fecha em</span><strong>{brl(p.projecaoAno)}</strong></div>
        {p.imposto?.tipo === 'das_mei' && <div className="stat-card"><span>DAS-MEI do mês</span><strong>{brl(p.imposto.valorMensal)}</strong></div>}
        {p.imposto?.tipo === 'simples' && <div className="stat-card"><span>DAS estimado de {mesCurto(p.imposto.competencia)}</span><strong>{brl(p.imposto.dasEstimado)}</strong></div>}
      </div>
      <div className="erp-duas-colunas">
        <section className="settings-section">
          <h2><Icon name="trendUp" size={16} /> Limite de faturamento</h2>
          {p.limite?.tipo === 'mei' && (
            <>
              <BarraLimite usado={p.limite.usadoPercentual} rotulo={`${p.limite.usadoPercentual}% de ${brl(p.limite.limite)}${p.limite.meses < 12 ? ` (proporcional a ${p.limite.meses} meses)` : ''} · faltam ${brl(Math.max(0, p.limite.restante))}`} />
              <p className="screen-hint">Até {brl(p.limite.comTolerancia)} (20% acima) o MEI paga DAS complementar e vira ME no ano seguinte; acima disso, o desenquadramento volta a janeiro.</p>
            </>
          )}
          {p.limite?.tipo === 'simples' && (
            <>
              <BarraLimite usado={p.limite.usadoPercentual} rotulo={`${p.limite.usadoPercentual}% de ${brl(p.limite.limite)} · sublimite do ICMS ${brl(p.limite.sublimite)}`} />
            </>
          )}
          {!p.limite && <p className="empty-state">Escolha o regime em Configurações → Geral → Fiscal (NFC-e).</p>}
          <div className="erp-barras-mes">
            {p.meses.map((m) => (
              <div key={m.competencia} className="erp-barra-mes" title={m.receita === null ? '' : brl(m.receita)}>
                <div className="erp-barra-mes-valor" style={{ height: `${m.receita ? Math.max(2, (m.receita / maxMes) * 100) : 0}%` }} />
                <span>{mesCurto(m.competencia).slice(0, 3)}</span>
              </div>
            ))}
          </div>
        </section>
        {p.imposto?.tipo === 'simples' && (
          <section className="settings-section">
            <h2><Icon name="money" size={16} /> Simples Nacional — Anexo {p.imposto.anexo} ({DESCRICAO_ANEXO[p.imposto.anexo]})</h2>
            <table className="data-table">
              <tbody>
                <tr><td>Receita dos últimos 12 meses (<Termo t="RBT12" />)</td><td style={{ textAlign: 'right' }}>{brl(p.imposto.rbt12.valor)}{p.imposto.rbt12.estimado ? ' *' : ''}</td></tr>
                {p.imposto.fatorR !== null && p.imposto.fatorR !== undefined && (
                  <tr><td><Termo t="Fator R" /> (folha ÷ receita, 12 meses)</td><td style={{ textAlign: 'right' }}>{(p.imposto.fatorR * 100).toFixed(1)}% {p.imposto.anexo === 'III' ? '→ tributa pelo Anexo III' : '→ fica no Anexo V (abaixo de 28%)'}</td></tr>
                )}
                <tr><td>Faixa</td><td style={{ textAlign: 'right' }}>{p.imposto.faixa}ª{p.imposto.acimaDoLimite ? ' (acima do limite do Simples)' : ''}</td></tr>
                <tr><td>Alíquota nominal / a deduzir</td><td style={{ textAlign: 'right' }}>{(p.imposto.nominal * 100).toFixed(2)}% / {brl(p.imposto.deduzir)}</td></tr>
                <tr><td><strong>Alíquota efetiva</strong></td><td style={{ textAlign: 'right' }}><strong>{(p.imposto.efetiva * 100).toFixed(2)}%</strong></td></tr>
                <tr><td>Receita de {mesCurto(p.imposto.competencia)} até agora</td><td style={{ textAlign: 'right' }}>{brl(p.imposto.receitaMes)}</td></tr>
              </tbody>
            </table>
            <p className="screen-hint">Estimativa: produto com ICMS-ST ou monofásico pode baixar o DAS de verdade. Mantenha o cadastro fiscal certo e o contador segrega na apuração.</p>
          </section>
        )}
        {p.imposto?.tipo === 'das_mei' && (
          <section className="settings-section">
            <h2><Icon name="money" size={16} /> DAS do MEI</h2>
            <p>{brl(p.imposto.valorMensal)} por mês{p.imposto.informado ? ' (valor informado em Ajustes)' : ` (${p.imposto.atividade === 'servicos' ? 'serviços' : p.imposto.atividade === 'ambos' ? 'comércio e serviços' : 'comércio'})`}.</p>
            <p className="screen-hint">{p.imposto.estimado ? 'O salário mínimo deste ano ainda não está na tabela do app: confira o valor no Portal do Empreendedor e informe em Ajustes.' : '5% do salário mínimo de INSS + R$ 1 de ICMS (comércio) e/ou R$ 5 de ISS (serviços).'}</p>
          </section>
        )}
      </div>
      <section className="settings-section">
        <h2><Icon name="calendar" size={16} /> Próximas obrigações</h2>
        {p.calendario.length === 0 ? <p className="empty-state">Nada nos próximos 60 dias.</p> : (
          <table className="data-table">
            <tbody>{p.calendario.map((c) => (
              <tr key={`${c.data}${c.titulo}`}>
                <td style={{ whiteSpace: 'nowrap' }}><strong>{dataBR(c.data)}</strong><div className="nfe-item-codigos">{c.diaSemana}</div></td>
                <td><strong>{c.titulo}</strong><div className="nfe-item-codigos">{c.detalhe}{c.fimDeSemana ? ' Cai em fim de semana: confirme o dia de pagamento com o contador.' : ''}</div></td>
                <td style={{ textAlign: 'right' }}>
                  {c.titulo.startsWith('Pacote') && <button className="btn-link" onClick={() => irPara('contador')}>Gerar pacote</button>}
                  {c.titulo.startsWith('Relatório') && <button className="btn-link" onClick={() => irPara('mei')}>Abrir relatório</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}

const ROTULO_CAMPO = { ncm: 'NCM', cest: 'CEST', cfop: 'CFOP', cst_csosn: 'CSOSN/CST' };

function CadastroFiscal() {
  const { currentUser } = useSession();
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState('');
  const carregar = () => window.pdv.assistenteFiscal.diagnostico().then(setD);
  useEffect(() => { carregar(); }, []);
  async function aplicar(incluirPadrao) {
    const texto = incluirPadrao
      ? 'Preencher CFOP 5102 e CSOSN 102 nos produtos sem nota de compra? Use só se esses produtos NÃO têm ICMS-ST. Na dúvida, pergunte ao contador.'
      : 'Corrigir com o que veio nas notas de compra e com o que a loja já usa para o mesmo NCM? Só campos vazios ou inválidos são preenchidos; nada válido é trocado.';
    if (!confirm(texto)) return;
    const r = await window.pdv.assistenteFiscal.aplicarSugestoes({ incluirPadrao, operadorId: currentUser.id });
    setMsg(r?.ok ? `${r.alterados} produto(s) corrigido(s): NCM ${r.campos.ncm}, CEST ${r.campos.cest}, CFOP/CSOSN ${r.campos.cfop}.` : r?.error);
    carregar();
  }
  if (!d) return <p className="empty-state">Carregando...</p>;
  const simples = d.regime === 'mei' || d.regime === 'simples_nacional';
  const semNota = d.produtos.filter((p) => p.sugestao.fonte === 'padrao').length;
  const semNcm = d.problemas.filter((p) => p.codigo === 'sem_ncm' || p.codigo === 'ncm_invalido').reduce((t, p) => t + p.qtd, 0);
  return (
    <div>
      <div className="dashboard-stats">
        <div className="stat-card"><span>Produtos</span><strong>{d.totalProdutos}</strong></div>
        <div className="stat-card"><span>Com problema</span><strong className={d.comProblema ? 'valor-erro' : undefined}>{d.comProblema}</strong></div>
        <div className="stat-card"><span>Corrigíveis automaticamente</span><strong>{d.sugestoesDeNota}</strong></div>
      </div>
      {msg && <p className="io-message" style={{ marginBottom: 10 }}>{msg}</p>}
      {d.comProblema === 0 ? <p className="io-message">Cadastro fiscal sem problemas. NFC-e com NCM e CFOP certos evita rejeição na SEFAZ.</p> : (
        <>
          <section className="settings-section">
            <h2><Icon name="sparkle" size={16} /> Corrigir em massa</h2>
            <p className="screen-hint">
              O NCM e o CEST vêm da última nota de compra lançada de cada produto; sem nota, o CFOP/CSOSN vem do que a loja já usa nos produtos com o mesmo NCM.{simples && ' Se o fornecedor vendeu com ICMS-ST (CFOP 5401/5403/5405/6401/6403/6404), a revenda fica CFOP 5405 + CSOSN 500; sem ST, 5102 + 102.'}
            </p>
            <div className="settings-actions">
              <button className="btn-primary" onClick={() => aplicar(false)} disabled={!d.sugestoesDeNota}><Icon name="checkCircle" size={15} /> Corrigir automaticamente ({d.sugestoesDeNota})</button>
              {simples && semNota > 0 && <button className="btn-secondary" onClick={() => aplicar(true)}>Preencher o resto com 5102/102 ({semNota})</button>}
            </div>
          </section>
          {semNcm > 0 && <NcmPorIa semNcm={semNcm} onAplicado={carregar} />}
          <div className="period-selector">{d.problemas.map((p) => <span key={p.codigo} className="chip-situacao chip-atualizar">{p.descricao}: {p.qtd}</span>)}</div>
          <table className="data-table">
            <thead><tr><th>Produto</th><th>NCM</th><th>CFOP</th><th>CSOSN/CST</th><th>CEST</th><th>Problemas</th><th>Sugestão</th></tr></thead>
            <tbody>{d.produtos.map((p) => (
              <tr key={p.id}>
                <td>{p.nome}<div className="nfe-item-codigos">{p.codigo_barras || ''}</div></td>
                <td>{p.ncm || '—'}</td><td>{p.cfop || '—'}</td><td>{p.cst_csosn || '—'}</td><td>{p.cest || '—'}</td>
                <td><div className="erp-problemas">{p.problemas.map((c) => <span key={c} className="chip-situacao chip-erro">{d.problemas.find((x) => x.codigo === c)?.descricao || c}</span>)}</div></td>
                <td>{p.sugestao.fonte ? (
                  <div className="nfe-item-codigos" style={{ marginTop: 0 }}>
                    {Object.keys(ROTULO_CAMPO).filter((k) => p.sugestao[k]).map((k) => `${ROTULO_CAMPO[k]} ${p.sugestao[k]}`).join(' · ')}
                    <br />{p.sugestao.fonte === 'padrao' ? 'padrão sem ST (confira)' : p.sugestao.fonte}{p.sugestao.st ? ' · com ST' : ''}
                  </div>
                ) : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
          {d.comProblema > d.produtos.length && <p className="screen-hint">Mostrando {d.produtos.length} de {d.comProblema}.</p>}
        </>
      )}
    </div>
  );
}

function SeletorMes({ valor, onChange }) {
  const atual = mesAtualLocal();
  const opcoes = Array.from({ length: 13 }, (_, i) => somarMeses(atual, -i));
  return <select value={valor} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 180 }}>{opcoes.map((m) => <option key={m} value={m}>{mesCurto(m)}</option>)}</select>;
}

function RelatorioMei() {
  const [comp, setComp] = useState(somarMeses(mesAtualLocal(), -1));
  const [r, setR] = useState(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { setMsg(''); window.pdv.assistenteFiscal.relatorioMei({ locationId: window.APP_LOCATION_ID, competencia: comp }).then(setR); }, [comp]);
  async function salvarPdf() {
    const res = await window.pdv.assistenteFiscal.salvarRelatorioMeiPdf({ locationId: window.APP_LOCATION_ID, competencia: comp });
    if (res?.canceled) return;
    setMsg(res?.ok ? `PDF salvo: ${res.arquivo}. Imprima, assine e guarde com as notas do mês.` : res?.error);
  }
  const linha = (rom, texto, v, total) => <tr className={total ? 'erp-dre-total' : ''}><td style={{ width: 44, textAlign: 'center' }}>{rom}</td><td>{texto}</td><td style={{ textAlign: 'right' }}>{brl(v)}</td></tr>;
  return (
    <div>
      <div className="period-selector"><span className="screen-hint" style={{ margin: 0 }}>Mês</span><SeletorMes valor={comp} onChange={setComp} />
        <button className="btn-primary" onClick={salvarPdf} disabled={!r?.ok}><Icon name="printer" size={15} /> Salvar PDF para assinar</button></div>
      {msg && <p className="io-message" style={{ marginBottom: 10 }}>{msg}</p>}
      {!r ? <p className="empty-state">Carregando...</p> : r.ok === false ? <p className="modal-error">{r.error}</p> : (
        <section className="settings-section">
          <h2>Relatório mensal das receitas brutas — {mesCurto(comp)}</h2>
          <p className="screen-hint">{r.empresa.nome || 'Informe a razão social em Configurações → Geral → Fiscal (NFC-e)'}{r.empresa.cnpj ? ` · CNPJ ${r.empresa.cnpj}` : ''} · {r.vendas} venda(s){r.devolucoes ? `, ${r.devolucoes} devolução(ões) descontada(s)` : ''}</p>
          <table className="data-table">
            <tbody>
              {linha('I', 'Revenda de mercadorias sem documento fiscal', r.linhas.I)}
              {linha('II', 'Revenda de mercadorias com documento fiscal (NFC-e)', r.linhas.II)}
              {linha('III', 'Total de revenda de mercadorias', r.linhas.III, true)}
              {linha('VII', 'Serviços sem documento fiscal', r.linhas.VII)}
              {linha('VIII', 'Serviços com documento fiscal', r.linhas.VIII)}
              {linha('IX', 'Total de serviços', r.linhas.IX, true)}
              {linha('X', 'Total geral das receitas brutas no mês', r.linhas.X, true)}
            </tbody>
          </table>
          <p className="screen-hint">O relatório é obrigatório para o MEI e fica guardado com as notas (não é enviado). Indústria (IV a VI) sai zerada.</p>
        </section>
      )}
    </div>
  );
}

function PacoteContador() {
  const [comp, setComp] = useState(somarMeses(mesAtualLocal(), -1));
  const [gerando, setGerando] = useState(false);
  const [res, setRes] = useState(null);
  async function gerar() {
    setGerando(true); setRes(null);
    const r = await window.pdv.assistenteFiscal.gerarPacoteContador({ locationId: window.APP_LOCATION_ID, competencia: comp });
    setGerando(false);
    if (!r?.canceled) setRes(r);
  }
  return (
    <div>
      <section className="settings-section">
        <h2><Icon name="archive" size={16} /> Tudo do mês num arquivo só</h2>
        <p className="screen-hint">Um .zip para mandar por e-mail ou WhatsApp ao contador:</p>
        <ul className="erp-lista">
          <li><strong>vendas.xlsx</strong> — resumo, formas de pagamento, cada venda com a NFC-e e a receita separada por CFOP/CSOSN/NCM (ajuda a segregar ST na apuração)</li>
          <li><strong>compras.xlsx</strong> e os <strong>XML das notas de compra</strong> lançadas no mês</li>
          <li><strong>XML das NFC-e</strong> autorizadas e canceladas</li>
          <li><strong>financeiro.xlsx</strong> — contas pagas no mês e as que estão em aberto</li>
          <li><strong>Relatório mensal do MEI</strong>, quando o regime é MEI</li>
        </ul>
        <div className="inline-form" style={{ marginTop: 12 }}>
          <label>Mês<SeletorMes valor={comp} onChange={setComp} /></label>
          <button className="btn-primary" onClick={gerar} disabled={gerando}><Icon name="export" size={15} /> {gerando ? 'Gerando...' : 'Gerar pacote'}</button>
        </div>
      </section>
      {res && (res.ok ? (
        <div className="io-message">
          Pacote salvo: <strong>{res.arquivo}</strong> — {res.resumo.vendas} venda(s), {res.resumo.compras} nota(s) de compra, {res.resumo.xmlsNfce} XML de NFC-e, {res.resumo.contasPagas} conta(s) paga(s).
          {res.avisos.map((a) => <div key={a} style={{ marginTop: 4 }}>Atenção: {a}</div>)}
        </div>
      ) : <p className="modal-error">{res.error}</p>)}
    </div>
  );
}

const DESCRICAO_ANEXO = { I: 'comércio', II: 'indústria', III: 'serviços', IV: 'serviços — construção, limpeza, vigilância, advocacia', V: 'serviços intelectuais/técnicos' };

function AjustesFiscais() {
  const [c, setC] = useState(null);
  const [msg, setMsg] = useState('');
  const [erro, setErro] = useState('');
  useEffect(() => { window.pdv.erp.getConfig().then((x) => setC({
    dataAberturaEmpresa: x.data_abertura_empresa || '', atividadeMei: x.atividade_mei, dasMeiValor: x.das_mei_valor ?? '',
    rbt12Anterior: x.rbt12_anterior ?? '', diaPacoteContador: x.dia_pacote_contador,
    anexoSimples: x.anexo_simples || 'I', folha12Meses: x.folha_12_meses ?? '',
  })); }, []);
  async function salvar(e) {
    e.preventDefault();
    const r = await window.pdv.erp.salvarConfig(c);
    if (!r?.ok) { setErro(r?.error); setMsg(''); } else { setErro(''); setMsg('Ajustes salvos.'); }
  }
  if (!c) return <p className="empty-state">Carregando...</p>;
  return (
    <form onSubmit={salvar} className="settings-section" style={{ maxWidth: 760 }}>
      <h2><Icon name="sliders" size={16} /> Ajustes do assistente fiscal</h2>
      <p className="screen-hint">O regime tributário, o CNPJ e a razão social ficam em Configurações → Geral → Fiscal (NFC-e).</p>
      <div className="form-grid">
        <label>Data de abertura do CNPJ<input type="date" value={c.dataAberturaEmpresa} onChange={(e) => setC({ ...c, dataAberturaEmpresa: e.target.value })} /></label>
        <label>Atividade (MEI)<select value={c.atividadeMei} onChange={(e) => setC({ ...c, atividadeMei: e.target.value })}>
          <option value="comercio">Comércio</option><option value="servicos">Serviços</option><option value="ambos">Comércio e serviços</option></select></label>
        <label>DAS-MEI mensal (deixe vazio para o valor do ano)<input type="number" step="0.01" min="0" value={c.dasMeiValor} onChange={(e) => setC({ ...c, dasMeiValor: e.target.value })} /></label>
        <label>Faturamento dos 12 meses antes de usar o sistema (R$)<input type="number" step="0.01" min="0" value={c.rbt12Anterior} onChange={(e) => setC({ ...c, rbt12Anterior: e.target.value })} /></label>
        <label>Lembrar do pacote do contador no dia<input type="number" min="1" max="28" value={c.diaPacoteContador} onChange={(e) => setC({ ...c, diaPacoteContador: e.target.value })} /></label>
        <label>Anexo do Simples (atividade principal)<select value={c.anexoSimples} onChange={(e) => setC({ ...c, anexoSimples: e.target.value })}>
          {Object.entries(DESCRICAO_ANEXO).map(([a, d]) => <option key={a} value={a}>Anexo {a} — {d}</option>)}</select></label>
        {c.anexoSimples === 'V' && (
          <label title="Salários, pró-labore, INSS patronal e FGTS dos últimos 12 meses. Com 28% ou mais da receita, a empresa paga pelo Anexo III (mais barato).">
            Folha de pagamento dos últimos 12 meses (R$, para o fator R)<input type="number" step="0.01" min="0" value={c.folha12Meses} onChange={(e) => setC({ ...c, folha12Meses: e.target.value })} /></label>
        )}
      </div>
      <p className="screen-hint">O anexo é definido pelo CNAE da empresa — na dúvida, pergunte ao contador. Comércio é quase sempre Anexo I.</p>
      {erro && <p className="modal-error" style={{ marginTop: 10 }}>{erro}</p>}
      {msg && <p className="io-message" style={{ marginTop: 10 }}>{msg}</p>}
      <div className="settings-actions"><button className="btn-primary" type="submit"><Icon name="save" size={15} /> Salvar</button></div>
    </form>
  );
}
