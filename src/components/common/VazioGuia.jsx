import Icon from './Icon';

/**
 * Lista vazia que diz o próximo passo ("Toque em + Novo orçamento…") em vez
 * de só "Nenhum item". Use no lugar de <p className="empty-state"> quando a
 * lista está vazia porque a pessoa ainda não começou, não por causa de filtro.
 */
export function VazioGuia({ icone = 'sparkle', titulo, children }) {
  return (
    <div className="vazio-guia">
      <Icon name={icone} size={22} />
      <span>{titulo && <strong>{titulo} </strong>}{children}</span>
    </div>
  );
}
