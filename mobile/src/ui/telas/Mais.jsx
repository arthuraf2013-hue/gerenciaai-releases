import { useState } from 'react';
import { useApp, podeGerenciar } from '../contexto.jsx';
import Icone from '../comp/Icone.jsx';
import Caixa from './Caixa.jsx';
import Relatorio from './Relatorio.jsx';
import Ajustes from './Ajustes.jsx';

export default function Mais({ parametros }) {
  const { usuario } = useApp();
  const [sub, setSub] = useState(parametros?.sub || null);
  const voltar = () => setSub(null);
  if (sub === 'caixa') return <Caixa voltar={voltar} />;
  if (sub === 'relatorio') return <Relatorio voltar={voltar} />;
  if (sub === 'ajustes') return <Ajustes voltar={voltar} />;

  const itens = [
    ['caixa', 'caixa', 'Caixa', 'Resumo, sangria, suprimento e fechamento'],
    podeGerenciar(usuario) && ['relatorio', 'grafico', 'Relatório', 'Faturamento, formas de pagamento, mais vendidos'],
    ['ajustes', 'engrenagem', 'Ajustes', 'Backup, Pix, operadores, licença'],
  ].filter(Boolean);

  return (
    <>
      <header className="topo"><h1>Mais</h1><span className="selo">{usuario.nome}</span></header>
      <main className="conteudo">
        <div className="cartao plano">
          {itens.map(([id, ic, t, d]) => (
            <button type="button" key={id} className="item" onClick={() => setSub(id)}>
              <Icone nome={ic} width="24" height="24" />
              <div className="cresce"><div className="forte">{t}</div><div className="muted peq">{d}</div></div>
            </button>
          ))}
        </div>
      </main>
    </>
  );
}
