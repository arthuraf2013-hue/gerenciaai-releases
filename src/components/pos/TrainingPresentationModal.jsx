import { useEscToClose } from '../../hooks/useEscToClose';

/**
 * @param {{ onClose: () => void }} props
 */
export function TrainingPresentationModal({ onClose }) {
  useEscToClose(onClose);
  return (
    <div className="modal-overlay">
      <div className="training-modal">
        <div className="training-modal-header">
          <h2>Treinamento — como operar o PDV</h2>
          <button className="btn-secondary" onClick={onClose}>Fechar</button>
        </div>
        <iframe
          src="/treinamento-pdv.pdf"
          title="Apresentação de treinamento do PDV"
          className="training-modal-frame"
        />
      </div>
    </div>
  );
}
