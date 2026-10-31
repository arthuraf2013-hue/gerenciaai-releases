import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

export const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Custo unitário: até 4 casas quando a conta não fecha em centavos. */
export const brlCusto = (v) => Number(v || 0).toLocaleString('pt-BR', {
  style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 4,
});

export const qtd = (v) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });

/** 'AAAA-MM-DD' (data de calendário) -> 'DD/MM/AAAA', sem passar por Date (fuso). */
export const dataBR = (iso) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).split('-').reverse().join('/') : '—');

const CHIPS = {
  rascunho: ['chip-atualizar', 'Em conferência'],
  confirmada: ['chip-novo', 'Lançada'],
  estornada: ['chip-erro', 'Estornada'],
  enviado: ['chip-novo', 'Enviado'],
  parcial: ['chip-atualizar', 'Recebido em parte'],
  recebido: ['chip-novo', 'Recebido'],
  cancelado: ['chip-erro', 'Cancelado'],
};

export function ChipStatus({ status, rascunhoPedido = false }) {
  const [classe, texto] = rascunhoPedido && status === 'rascunho' ? ['chip-neutro', 'Rascunho'] : (CHIPS[status] || ['chip-neutro', status]);
  return <span className={`chip-situacao ${classe}`}>{texto}</span>;
}

/** Quais áreas do ERP este usuário pode abrir nesta loja (null enquanto
 * carrega): { compras, financeiro, estoque, fiscal } = licença E permissão;
 * `semPermissao[area]` diz quando o bloqueio é do usuário, não da licença. */
export function useModulosErp() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    window.pdv.erp.status().then((r) => {
      const areas = ['compras', 'financeiro', 'estoque', 'fiscal'];
      const semPermissao = Object.fromEntries(areas.map((a) => [a, r?.permissoes?.[a] === false]));
      setStatus({ ...Object.fromEntries(areas.map((a) => [a, r?.[a] !== false && !semPermissao[a]])), semPermissao });
    });
  }, []);
  return status;
}

/** Status do módulo pago "ERP — Compras" (null enquanto carrega). */
export function useModuloCompras() {
  const status = useModulosErp();
  return status === null ? null : status.compras;
}

const MODULOS = {
  compras: ['ERP — Compras', 'Pedido de compra e entrada de mercadoria pelo XML da nota fiscal fazem parte do módulo',
    'O custo médio dos produtos continua sendo calculado normalmente no Abastecimento.'],
  financeiro: ['ERP — Financeiro', 'Contas a receber, despesas recorrentes, fluxo de caixa e DRE fazem parte do módulo',
    'As despesas e o resumo do período continuam funcionando na aba Resumo e despesas.'],
  estoque: ['ERP — Estoque', 'Inventário (contagem de estoque) e movimentação por produto fazem parte do módulo',
    'Ajuste de estoque, perdas e alertas continuam funcionando normalmente.'],
  fiscal: ['ERP — Fiscal', 'O assistente fiscal (cadastro, limites, DAS estimado, relatório do MEI e pacote do contador) faz parte do módulo',
    'A emissão de NFC-e não depende deste módulo.'],
};

export function ModuloInativo({ modulo, semPermissao = false }) {
  const [nome, texto, extra] = MODULOS[modulo];
  if (semPermissao) {
    return (
      <div className="screen">
        <section className="settings-section erp-bloqueado">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="lock" size={18} /> {nome}</h2>
          <p>Seu usuário não tem acesso a esta área.</p>
          <p className="screen-hint" style={{ marginBottom: 0 }}>O administrador libera em Usuários → Permissões do ERP.</p>
        </section>
      </div>
    );
  }
  return (
    <div className="screen">
      <section className="settings-section erp-bloqueado">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="lock" size={18} /> {nome}</h2>
        <p>{texto} <strong>{nome}</strong>, que não está ativo nesta loja.</p>
        <p className="screen-hint" style={{ marginBottom: 0 }}>Fale com o suporte da Vetta Sistemas para liberar. {extra}</p>
      </section>
    </div>
  );
}

export function ModuloComprasInativo() {
  return <ModuloInativo modulo="compras" />;
}

/** Abas no padrão do app (botões .category-btn). */
export function Abas({ abas, atual, onChange, bloqueadas = {} }) {
  return (
    <div className="settings-tabs" style={{ marginTop: 0 }}>
      {abas.map((a) => (
        <button key={a.id} className={atual === a.id ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => onChange(a.id)}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {a.icone && <Icon name={a.icone} size={15} />} {a.rotulo}
            {bloqueadas[a.id] && <Icon name="lock" size={13} title="Módulo não ativo" />}
          </span>
        </button>
      ))}
    </div>
  );
}

/** 'AAAA-MM' -> 'out/2026'. */
export function mesCurto(competencia) {
  const nomes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const [a, m] = competencia.split('-');
  return `${nomes[Number(m) - 1]}/${a}`;
}

/** Mês local atual 'AAAA-MM' e soma de meses, sem passar por fuso. */
export function mesAtualLocal() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
}
export function somarMeses(competencia, n) {
  const [a, m] = competencia.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1 + n, 1)).toISOString().slice(0, 7);
}
export function hojeLocal() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function somarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
