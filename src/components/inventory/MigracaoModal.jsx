import { useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';
import { useSession } from '../../context/SessionContext';
import Icon from '../common/Icon';

/**
 * "Migrar do sistema antigo": lê a planilha/CSV exportada de qualquer
 * sistema, sugere qual coluna é o quê (pelo nome e, se quiser, pela IA),
 * mostra a prévia e importa produtos ou clientes com saldo de fiado.
 * Lógica em electron/services/migracaoService.js.
 *
 * @param {{ tipoInicial?: 'produtos'|'clientes', onClose: () => void, onImportado?: () => void }} props
 */
export function MigracaoModal({ tipoInicial = 'produtos', onClose, onImportado }) {
  useEscToClose(onClose);
  const { currentUser } = useSession();
  const [etapa, setEtapa] = useState('inicio'); // inicio | colunas | previa | pronto
  const [arquivo, setArquivo] = useState(null);
  const [tipo, setTipo] = useState(tipoInicial);
  const [mapeamento, setMapeamento] = useState({});
  const [previa, setPrevia] = useState(null);
  const [resultado, setResultado] = useState(null);
  const [ocupado, setOcupado] = useState('');
  const [erro, setErro] = useState('');
  const [avisoIA, setAvisoIA] = useState('');

  const campos = arquivo?.campos?.[tipo] || [];

  function exemplosDaColuna(coluna) {
    const i = arquivo.colunas.indexOf(coluna);
    if (i < 0) return '';
    return arquivo.linhasOriginais.map((l) => String(l[i] ?? '').trim()).filter(Boolean).slice(0, 3).join(' · ');
  }

  async function escolherArquivo() {
    setErro('');
    setOcupado('Lendo o arquivo...');
    const r = await window.pdv.migracao.abrirArquivo();
    setOcupado('');
    if (r.canceled) return;
    if (!r.ok) { setErro(r.error); return; }
    setArquivo(r);
    const t = tipoInicial === 'clientes' ? 'clientes' : r.tipoSugerido;
    setTipo(t);
    setMapeamento(r.mapeamentoSugerido[t] || {});
    setPrevia(null);
    setAvisoIA('');
    setEtapa('colunas');
  }

  function trocarTipo(t) {
    setTipo(t);
    setMapeamento(arquivo.mapeamentoSugerido[t] || {});
    setPrevia(null);
    setAvisoIA('');
  }

  function escolherColuna(campo, coluna) {
    setMapeamento((m) => {
      const novo = { ...m };
      // Uma coluna serve a um campo só: tira de onde ela estava.
      for (const [c, col] of Object.entries(novo)) if (col === coluna) delete novo[c];
      if (coluna) novo[campo] = coluna; else delete novo[campo];
      return novo;
    });
    setPrevia(null);
  }

  async function sugerirComIA() {
    setErro('');
    setAvisoIA('');
    setOcupado('Perguntando à IA...');
    const r = await window.pdv.migracao.sugerirComIA({ token: arquivo.token, tipo });
    setOcupado('');
    if (!r.ok) { setErro(r.error); return; }
    const mudou = campos.filter((c) => (r.mapeamento[c.campo] || '') !== (mapeamento[c.campo] || '')).length;
    setMapeamento(r.mapeamento);
    setPrevia(null);
    setAvisoIA(mudou
      ? `A IA mudou ${mudou} coluna(s). Confira antes de continuar — ${tipo === 'clientes' ? 'ela viu só o nome das colunas e exemplos mascarados, nenhum dado de cliente.' : 'ela viu só o nome das colunas e 3 exemplos de cada.'}`
      : 'A IA concordou com as colunas escolhidas.');
  }

  async function verPrevia() {
    setErro('');
    setOcupado('Conferindo todas as linhas...');
    const r = await window.pdv.migracao.previa({ token: arquivo.token, tipo, mapeamento });
    setOcupado('');
    if (!r.ok) { setErro(r.error); return; }
    setPrevia(r);
    setEtapa('previa');
  }

  async function importar() {
    const validas = previa.resumo.novos + previa.resumo.atualizar;
    const extra = tipo === 'clientes' && previa.resumo.saldoFiadoTotal > 0
      ? `\n\nSaldo de fiado migrado: ${dinheiro(previa.resumo.saldoFiadoTotal)} (só clientes novos).`
      : '';
    if (!confirm(`Importar ${validas} ${tipo === 'clientes' ? 'cliente(s)' : 'produto(s)'}?${previa.resumo.erros ? `\n\n${previa.resumo.erros} linha(s) com erro ficam de fora.` : ''}${extra}`)) return;
    setErro('');
    setOcupado('Importando...');
    const r = await window.pdv.migracao.importar({
      token: arquivo.token, tipo, mapeamento,
      operadorId: currentUser.id, locationId: window.APP_LOCATION_ID, deviceId: window.APP_DEVICE_ID,
    });
    setOcupado('');
    if (!r.ok) { setErro(r.error); return; }
    setResultado(r);
    setEtapa('pronto');
    onImportado?.();
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="titulo-migracao">
      <div className="modal-card modal-card-fullscreen migracao">
        <div className="migracao-topo">
          <div>
            <h2 id="titulo-migracao" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
              <Icon name="import" size={20} /> Migrar do sistema antigo
            </h2>
            <ol className="migracao-passos" aria-label="Etapas">
              {[['inicio', 'Arquivo'], ['colunas', 'Colunas'], ['previa', 'Prévia'], ['pronto', 'Pronto']].map(([id, rotulo], i) => (
                <li key={id} className={etapa === id ? 'atual' : ''}>{i + 1}. {rotulo}</li>
              ))}
            </ol>
          </div>
          <button type="button" className="btn-secondary" onClick={onClose}><Icon name="close" size={16} /> Fechar</button>
        </div>

        {erro && <p className="modal-error">{erro}</p>}
        {ocupado && <p className="io-message">{ocupado}</p>}

        <div className="modal-card-fullscreen-scroll">
          {etapa === 'inicio' && (
            <div className="migracao-inicio">
              <p>No sistema antigo, procure <strong>Exportar</strong> (ou Relatórios → Produtos/Clientes → Excel/CSV) e salve o arquivo.
                Não precisa arrumar nada nele: aqui você diz qual coluna é o quê e confere tudo antes de entrar.</p>
              <ul className="migracao-lista">
                <li><strong>Produtos:</strong> nome, preço, custo, código de barras, código interno, estoque, unidade, categoria, NCM, fornecedor.</li>
                <li><strong>Clientes:</strong> nome, telefone, CPF/CNPJ, nascimento e o saldo de fiado em aberto.</li>
                <li>Aceita <code>.xlsx</code> e <code>.csv</code> (separado por ponto e vírgula ou vírgula, com ou sem acentuação UTF-8).</li>
                <li>Pode importar de novo o mesmo arquivo: quem já existe é atualizado, não duplicado. Estoque inicial e saldo de fiado só entram em cadastro novo.</li>
              </ul>
              <button type="button" className="btn-primary" onClick={escolherArquivo} disabled={!!ocupado}>
                <Icon name="folder" size={16} /> Escolher arquivo exportado
              </button>
            </div>
          )}

          {etapa === 'colunas' && arquivo && (
            <>
              <p className="screen-hint" style={{ marginTop: 0 }}>
                <strong>{arquivo.arquivo}</strong>{arquivo.aba ? ` · aba "${arquivo.aba}"` : ''} · {arquivo.totalLinhas} linha(s) · {arquivo.colunas.length} coluna(s)
              </p>
              <div className="migracao-tipo" role="radiogroup" aria-label="O que tem neste arquivo">
                <span>Este arquivo tem:</span>
                {[['produtos', 'Produtos', 'tag'], ['clientes', 'Clientes', 'users']].map(([t, rotulo, ic]) => (
                  <button key={t} type="button" role="radio" aria-checked={tipo === t} className={tipo === t ? 'btn-primary' : 'btn-secondary'} onClick={() => trocarTipo(t)}>
                    <Icon name={ic} size={15} /> {rotulo}
                  </button>
                ))}
              </div>

              <table className="data-table migracao-colunas">
                <thead><tr><th>Campo no GerenciaAI</th><th>Coluna do arquivo</th><th>Exemplos</th></tr></thead>
                <tbody>
                  {campos.map((c) => (
                    <tr key={c.campo}>
                      <td>{c.rotulo}{c.obrigatorio && <span className="obrigatorio" title="Obrigatório"> *</span>}</td>
                      <td>
                        <select value={mapeamento[c.campo] || ''} onChange={(e) => escolherColuna(c.campo, e.target.value)} aria-label={`Coluna para ${c.rotulo}`}>
                          <option value="">— não importar —</option>
                          {arquivo.colunas.map((col) => <option key={col} value={col}>{col}</option>)}
                        </select>
                      </td>
                      <td className="migracao-exemplo">{mapeamento[c.campo] ? exemplosDaColuna(mapeamento[c.campo]) || <span className="screen-hint">(vazia nas primeiras linhas)</span> : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {avisoIA && <p className="io-message-aviso" style={{ marginTop: 12 }}><Icon name="sparkle" size={15} /> {avisoIA}</p>}
            </>
          )}

          {etapa === 'previa' && previa && (
            <>
              <div className="dashboard-stats" style={{ marginBottom: 14 }}>
                <div className="stat-card"><span>Novos</span><strong>{previa.resumo.novos}</strong></div>
                <div className="stat-card"><span>{tipo === 'clientes' ? 'Já cadastrados (completar)' : 'Já cadastrados (atualizar)'}</span><strong>{previa.resumo.atualizar}</strong></div>
                <div className="stat-card"><span>Com erro (ficam de fora)</span><strong className={previa.resumo.erros ? 'valor-erro' : ''}>{previa.resumo.erros}</strong></div>
                {tipo === 'produtos'
                  ? <div className="stat-card"><span>Com estoque inicial</span><strong>{previa.resumo.estoqueInicial}</strong></div>
                  : <div className="stat-card"><span>Fiado migrado</span><strong>{dinheiro(previa.resumo.saldoFiadoTotal)}</strong></div>}
              </div>
              <p className="screen-hint" style={{ marginTop: 0 }}>
                Mostrando as primeiras linhas de cada situação. {tipo === 'produtos'
                  ? 'Produto já cadastrado tem nome, preço e custo atualizados; estoque dele não muda (use Abastecimento ou Ajustar estoque).'
                  : 'Cliente já cadastrado só tem os campos vazios completados; o fiado dele não muda.'}
              </p>
              <table className="data-table migracao-previa">
                <thead>
                  <tr>
                    <th>Linha</th><th>Situação</th><th>Nome</th>
                    {tipo === 'produtos'
                      ? <><th>Preço</th><th>Custo</th><th>Código</th><th>Estoque</th></>
                      : <><th>Telefone</th><th>CPF/CNPJ</th><th>Fiado</th></>}
                    <th>Observação</th>
                  </tr>
                </thead>
                <tbody>
                  {previa.linhas.map((l) => (
                    <tr key={l.linha} className={l.acao === 'erro' ? 'row-critical' : ''}>
                      <td>{l.linha}</td>
                      <td><span className={`chip-situacao chip-${l.acao}`}>{{ novo: 'Novo', atualizar: tipo === 'clientes' ? 'Completar' : 'Atualizar', erro: 'Erro' }[l.acao]}</span></td>
                      <td>{l.dados.nome || '—'}{l.existenteNome && l.existenteNome !== l.dados.nome ? <div className="screen-hint">= {l.existenteNome}</div> : null}</td>
                      {tipo === 'produtos'
                        ? <><td>{l.dados.preco != null ? dinheiro(l.dados.preco) : '—'}</td><td>{l.dados.custo != null ? dinheiro(l.dados.custo) : '—'}</td>
                          <td>{l.dados.codigoBarras || l.dados.sku || '—'}</td><td>{l.dados.estoque != null ? `${Number(l.dados.estoque).toLocaleString('pt-BR')} ${l.dados.unidade}` : '—'}</td></>
                        : <><td>{l.dados.telefone || '—'}</td><td>{l.dados.cpf || l.dados.cnpj ? 'informado' : '—'}</td><td>{l.dados.saldoFiado ? dinheiro(l.dados.saldoFiado) : '—'}</td></>}
                      <td className="migracao-obs">{[...l.erros, ...l.avisos].join('; ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {etapa === 'pronto' && resultado && (
            <div className="migracao-inicio">
              <p className="io-message" style={{ fontSize: 15 }}>
                <Icon name="check" size={16} /> {resultado.tipo === 'produtos'
                  ? `${resultado.novos} produto(s) novo(s), ${resultado.atualizados} atualizado(s), ${resultado.comEstoque} com estoque inicial.`
                  : `${resultado.novos} cliente(s) novo(s), ${resultado.atualizados} completado(s), ${resultado.comSaldo} com saldo de fiado (${dinheiro(resultado.saldoTotal)}).`}
              </p>
              {resultado.totalErros > 0 && (
                <details open>
                  <summary>{resultado.totalErros} linha(s) ficaram de fora</summary>
                  <ul className="migracao-lista">
                    {resultado.erros.map((e) => <li key={e.linha}>Linha {e.linha}: {e.erro}</li>)}
                  </ul>
                  {resultado.totalErros > resultado.erros.length && <p className="screen-hint">Mostrando as primeiras {resultado.erros.length}.</p>}
                </details>
              )}
              <p className="screen-hint">Registrado na Auditoria. Dados fiscais que não vieram no arquivo (CFOP, CST) continuam sendo completados em cada produto.</p>
            </div>
          )}
        </div>

        <div className="modal-actions">
          {etapa === 'colunas' && (
            <>
              <button type="button" className="btn-secondary" onClick={escolherArquivo} disabled={!!ocupado}><Icon name="folder" size={16} /> Outro arquivo</button>
              <button type="button" className="btn-secondary" onClick={sugerirComIA} disabled={!!ocupado}><Icon name="sparkle" size={16} /> Sugerir colunas com IA</button>
              <button type="button" className="btn-primary" onClick={verPrevia} disabled={!!ocupado}><Icon name="search" size={16} /> Ver prévia</button>
            </>
          )}
          {etapa === 'previa' && previa && (
            <>
              <button type="button" className="btn-secondary" onClick={() => setEtapa('colunas')} disabled={!!ocupado}><Icon name="undo" size={16} /> Ajustar colunas</button>
              <button type="button" className="btn-primary" onClick={importar} disabled={!!ocupado || previa.resumo.novos + previa.resumo.atualizar === 0}>
                <Icon name="import" size={16} /> Importar {previa.resumo.novos + previa.resumo.atualizar} {tipo === 'clientes' ? 'cliente(s)' : 'produto(s)'}
              </button>
            </>
          )}
          {etapa === 'pronto' && <button type="button" className="btn-primary" onClick={onClose}><Icon name="check" size={16} /> Concluir</button>}
        </div>
      </div>
    </div>
  );
}

function dinheiro(v) {
  return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
