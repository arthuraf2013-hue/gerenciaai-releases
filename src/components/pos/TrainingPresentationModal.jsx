import { useEscToClose } from '../../hooks/useEscToClose';
import { useProfile } from '../../context/ProfileContext';

// Cada perfil de negócio tem seu próprio treinamento — mostra só o que
// é relevante pra aquele tipo de loja, em vez de uma apresentação
// genérica com slide de mesa de restaurante pra quem é ótica. Perfil
// sem arquivo específico (ou não reconhecido) cai no "padrão".
const ARQUIVO_POR_PERFIL = {
  farmacia: 'treinamento-farmacia.pdf',
  petshop: 'treinamento-petshop.pdf',
  armazem: 'treinamento-armazem.pdf',
  salao_beleza: 'treinamento-salao_beleza.pdf',
  padaria: 'treinamento-padaria.pdf',
  otica: 'treinamento-otica.pdf',
  material_construcao: 'treinamento-material_construcao.pdf',
  restaurante: 'treinamento-restaurante.pdf',
};
const ARQUIVO_PADRAO = 'treinamento-padrao.pdf';

/**
 * @param {{ onClose: () => void }} props
 */
export function TrainingPresentationModal({ onClose }) {
  useEscToClose(onClose);
  const { profile } = useProfile();
  const arquivo = ARQUIVO_POR_PERFIL[profile?.id] || ARQUIVO_PADRAO;

  return (
    <div className="modal-overlay">
      <div className="training-modal">
        <div className="training-modal-header">
          <h2>🎓 Treinamento — como operar o PDV</h2>
          <button className="btn-secondary" onClick={onClose}>✖️ Fechar</button>
        </div>
        <iframe
          src={`/${arquivo}`}
          title="Apresentação de treinamento do PDV"
          className="training-modal-frame"
        />
      </div>
    </div>
  );
}
