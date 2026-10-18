import { useState } from 'react';
import Icon from '../common/Icon';

// Trazer os dados de um PDV mobile autônomo (celular que vendia sozinho,
// sem computador) pra este computador -- ver
// electron/services/pdvMobileMigracaoService.js pras regras.

const quando = (ms) => (ms ? new Date(ms).toLocaleString('pt-BR') : '—');
const dinheiro = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function Resumo({ r }) {
  const linhas = [
    ['Vendas', `${r.vendas.novas} nova(s)${r.vendas.jaImportadas ? ` · ${r.vendas.jaImportadas} já estavam aqui` : ''}${r.vendas.canceladasDepois ? ` · ${r.vendas.canceladasDepois} cancelada(s) depois no celular` : ''}`],
    ['Produtos', `${r.produtos.novos} novo(s)${r.produtos.existentes ? ` · ${r.produtos.existentes} já existiam` : ''}${r.produtos.ligadosPorCodigo ? ` · ${r.produtos.ligadosPorCodigo} ligado(s) pelo código de barras` : ''}`],
    ['Clientes', `${r.clientes.novos} novo(s)${r.clientes.existentes ? ` · ${r.clientes.existentes} já existiam` : ''}${r.clientes.ligadosPorDocumento ? ` · ${r.clientes.ligadosPorDocumento} ligado(s) pelo CPF/CNPJ` : ''}`],
    ['Estoque', r.celular.primeiraImportacao ? `${r.estoque.saldosIniciais} saldo(s) trazido(s) do celular` : `${r.estoque.saldosIniciais} saldo(s) novo(s) · ${r.estoque.movimentosReplicados} movimento(s) feitos no celular depois da última importação`],
    ['Fiado', r.celular.primeiraImportacao ? `${r.fiado.saldosIniciais} saldo(s) devedor(es) trazido(s)` : `${r.fiado.saldosIniciais} saldo(s) novo(s) · ${r.fiado.lancamentosReplicados} lançamento(s) depois da última importação`],
    ['Operadores', `${r.usuarios.novos} entram desativados (reative em Usuários com um PIN novo)`],
    ['Caixas fechados', `${r.caixas.importados}${r.caixas.abertoNoCelularNaoImportado ? ' · o caixa aberto agora no celular fica lá' : ''}`],
  ];
  return (
    <>
      <table className="data-table" style={{ marginBottom: 12 }}>
        <tbody>{linhas.map(([k, v]) => <tr key={k}><td style={{ width: 160, color: 'var(--color-text-muted)' }}>{k}</td><td>{v}</td></tr>)}</tbody>
      </table>
      {r.produtos.estoqueMantidoDoComputador?.length > 0 && (
        <p className="io-message-aviso" style={{ marginBottom: 12 }}>
          <Icon name="warning" size={15} /> {r.produtos.estoqueMantidoDoComputador.length} produto(s) já existia(m) aqui com o mesmo código de barras — o estoque deste computador foi mantido
          ({r.produtos.estoqueMantidoDoComputador.slice(0, 3).map((p) => `${p.nome}: ${String(p.saldoNoCelular).replace('.', ',')} no celular`).join('; ')}). Confira e ajuste no Estoque se precisar.
        </p>
      )}
      <h3 style={{ fontSize: 14, margin: '12px 0 6px' }}>Conferência (celular × computador)</h3>
      <table className="data-table">
        <thead><tr><th>Item</th><th style={{ textAlign: 'right' }}>Celular</th><th style={{ textAlign: 'right' }}>Computador</th><th /></tr></thead>
        <tbody>
          {r.conferencia.linhas.map((l) => (
            <tr key={l.rotulo}>
              <td>{l.rotulo}</td>
              <td style={{ textAlign: 'right' }}>{/^(Vendas|Recebido|Fiado)/.test(l.rotulo) ? dinheiro(l.celular) : String(l.celular).replace('.', ',')}</td>
              <td style={{ textAlign: 'right' }}>{/^(Vendas|Recebido|Fiado)/.test(l.rotulo) ? dinheiro(l.computador) : String(l.computador).replace('.', ',')}</td>
              <td style={{ color: l.ok ? 'var(--color-primary)' : 'var(--color-danger)' }}><Icon name={l.ok ? 'check' : 'warning'} size={15} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function MigracaoPdvMobile() {
  const [carregando, setCarregando] = useState(false);
  const [celulares, setCelulares] = useState(null);
  const [erro, setErro] = useState(null);
  const [etapa, setEtapa] = useState(null); // { installId, nome, fase: 'conferindo'|'previa'|'importando'|'feito', dados }

  const procurar = async () => {
    setCarregando(true); setErro(null); setEtapa(null);
    const r = await window.pdv.pdvMobileMigracao.listar();
    setCarregando(false);
    if (!r || r.ok === false) { setErro(r?.error || 'Não consegui consultar a Central.'); return; }
    setCelulares(r.celulares);
  };

  const conferir = async (c) => {
    setEtapa({ installId: c.installId, nome: c.nomeNegocio, fase: 'conferindo' }); setErro(null);
    const r = await window.pdv.pdvMobileMigracao.previsualizar({ installId: c.installId });
    if (!r || r.ok === false) { setEtapa(null); setErro(r?.error || 'Falha ao preparar.'); return; }
    setEtapa({ installId: c.installId, nome: c.nomeNegocio, fase: 'previa', dados: r });
  };

  const importar = async () => {
    if (!window.confirm(`Importar os dados de "${etapa.nome}" para este computador agora? A conferência acabou de bater; se algo mudar até lá e não bater de novo, nada é gravado.`)) return;
    setEtapa((e) => ({ ...e, fase: 'importando' }));
    const r = await window.pdv.pdvMobileMigracao.importar({ installId: etapa.installId });
    if (!r || r.ok === false) { setEtapa((e) => ({ ...e, fase: 'previa' })); setErro(r?.error || 'Falha na importação.'); return; }
    setEtapa((e) => ({ ...e, fase: 'feito', dados: r }));
    procurar();
  };

  return (
    <section className="settings-section">
      <h2><Icon name="mobile" size={16} /> Trazer dados de um PDV mobile (celular)</h2>
      <p className="screen-hint">
        Para quem vendia só pelo celular (app GerenciaAI PDV, sem computador) e agora passou a usar este computador.
        O sistema pede ao celular um backup novo, baixa da nuvem e traz produtos, estoque, clientes com fiado, vendas e
        fechamentos de caixa. Antes de gravar, mostra uma <strong>conferência</strong> celular × computador — se algum
        número não bater, nada é gravado. Pode repetir depois: só entra o que for novo, sem duplicar.
      </p>
      <button className="btn-secondary" onClick={procurar} disabled={carregando}>
        <Icon name="search" size={15} /> {carregando ? 'Procurando...' : 'Procurar celulares deste cliente'}
      </button>
      {erro && <p className="io-message-aviso" style={{ marginTop: 12 }}><Icon name="warning" size={15} /> {erro}</p>}

      {celulares && celulares.length === 0 && <p className="screen-hint" style={{ marginTop: 12 }}>Nenhum PDV mobile vinculado ao mesmo cliente deste computador na Central.</p>}
      {celulares && celulares.length > 0 && (
        <table className="data-table" style={{ marginTop: 12 }}>
          <thead><tr><th>Celular</th><th>Último contato</th><th>Último backup</th><th>Situação</th><th /></tr></thead>
          <tbody>
            {celulares.map((c) => (
              <tr key={c.installId}>
                <td><strong>{c.nomeNegocio}</strong><div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>v{c.versaoApp || '—'} · {c.installId.slice(0, 8)}</div></td>
                <td>{quando(c.ultimoContatoMs)}</td>
                <td>{quando(c.ultimoBackupMs)}</td>
                <td>{c.importadoAquiEmMs ? `Importado aqui (até ${quando(c.importadoAquiEmMs)})` : c.migradoParaNome ? `Migrado para ${c.migradoParaNome}` : 'Ainda não importado'}</td>
                <td><button className="btn-primary" onClick={() => conferir(c)} disabled={!!etapa && etapa.fase !== 'feito'}>{c.importadoAquiEmMs ? 'Trazer o que é novo' : 'Conferir dados'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {etapa?.fase === 'conferindo' && <p className="io-message" style={{ marginTop: 12 }}>Pedindo um backup novo ao celular e conferindo (pode levar até 1 minuto)...</p>}
      {(etapa?.fase === 'previa' || etapa?.fase === 'importando') && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 15, margin: '0 0 6px' }}>Pré-visualização — {etapa.nome}</h3>
          <p className="screen-hint" style={{ marginTop: 0 }}>
            Dados do celular até {quando(Date.now() - etapa.dados.idadeMinutos * 60000)}
            {etapa.dados.backupRecente ? ' (backup pedido agora).' : ' — o celular não respondeu a tempo; usando o último backup que já estava na nuvem.'}
          </p>
          <Resumo r={etapa.dados.resumo} />
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className="btn-primary" onClick={importar} disabled={etapa.fase === 'importando'}><Icon name="import" size={15} /> {etapa.fase === 'importando' ? 'Importando...' : 'Importar agora'}</button>
            <button className="btn-secondary" onClick={() => setEtapa(null)} disabled={etapa.fase === 'importando'}>Cancelar</button>
          </div>
        </div>
      )}
      {etapa?.fase === 'feito' && (
        <div style={{ marginTop: 16 }}>
          <p className="io-message"><Icon name="checkCircle" size={15} /> Dados de "{etapa.nome}" importados — a conferência bateu.</p>
          {etapa.dados.resumo.avisoCentral && <p className="io-message-aviso" style={{ marginTop: 8 }}><Icon name="warning" size={15} /> {etapa.dados.resumo.avisoCentral}</p>}
          <p className="screen-hint" style={{ marginTop: 8 }}>
            Próximos passos: reative em <strong>Usuários</strong> quem vai usar este computador (com PIN novo). Se o celular continuar
            vendendo sozinho, use "Trazer o que é novo" de novo mais tarde — ou, na Central, use <strong>"Usar como terminal"</strong>:
            o celular continua vendendo (até offline) e as vendas passam a chegar aqui sozinhas.
          </p>
          <Resumo r={etapa.dados.resumo} />
        </div>
      )}
    </section>
  );
}
