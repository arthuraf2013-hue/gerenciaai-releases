import { useEffect, useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';
import Icon from '../common/Icon';

const TIPO_ICON = { imagem: 'image', pdf: 'document' };
const STATUS_LABEL = {
  nao_solicitada: null,
  processando: 'Lendo com IA...',
  concluida: 'Dados extraídos',
  erro: 'Falha na extração',
};

/**
 * @param {{ saleId: string, operadorId: string, onClose: () => void, onExtracted: (data: object) => void }} props
 */
export function SaleAttachmentsPanel({ saleId, operadorId, onClose, onExtracted }) {
  useEscToClose(onClose);
  const [attachments, setAttachments] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [extractingId, setExtractingId] = useState(null);

  async function reload() {
    const list = await window.pdv.attachments.list({ saleId });
    if (!Array.isArray(list)) {
      setAttachments([]);
      setError(list?.error || 'Não foi possível carregar os anexos.');
      return;
    }
    setAttachments(list);
  }

  useEffect(() => { reload(); }, [saleId]);

  async function handleAdd() {
    setBusy(true);
    setError('');
    const result = await window.pdv.attachments.add({ saleId, operadorId });
    setBusy(false);
    if (result.canceled) return;
    if (!result.ok) return setError(result.error);
    reload();
  }

  async function handleRemove(id) {
    await window.pdv.attachments.remove({ id });
    reload();
  }

  async function handleExtract(id) {
    setExtractingId(id);
    setError('');
    const result = await window.pdv.ai.extractAttachment({ attachmentId: id });
    setExtractingId(null);
    if (!result.ok) {
      setError(result.error);
    } else if (result.data?.medicamentos?.length > 0) {
      onExtracted?.(result.data);
    }
    reload();
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card modal-card-wide">
        <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon name="attachment" size={20} /> Anexos da venda</h2>
        <p className="modal-subtitle">
          Opcional — use para anexar a foto ou o PDF de uma receita, comprovante ou nota
          relacionada a esta venda. Nenhum item exige isso para ser vendido.
        </p>

        {attachments.length === 0 ? (
          <p className="empty-state">Nenhum anexo ainda.</p>
        ) : (
          <ul className="attachment-list">
            {attachments.map((a) => {
              const extracted = a.extracao_status === 'concluida' && a.extracao_json ? JSON.parse(a.extracao_json) : null;
              const failed = a.extracao_status === 'erro' && a.extracao_json ? JSON.parse(a.extracao_json) : null;
              return (
                <li key={a.id} className="attachment-item">
                  <div className="attachment-row">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Icon name={TIPO_ICON[a.tipo] || 'attachment'} size={16} /> {a.nome_arquivo}
                    </span>
                    <div className="attachment-actions">
                      <button
                        className="btn-link"
                        onClick={() => handleExtract(a.id)}
                        disabled={extractingId === a.id}
                      >
                        {extractingId === a.id ? 'Lendo...' : (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <Icon name="search" size={15} /> Extrair dados com IA
                          </span>
                        )}
                      </button>
                      <button className="btn-link-danger" onClick={() => handleRemove(a.id)}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <Icon name="trash" size={15} /> Remover
                        </span>
                      </button>
                    </div>
                  </div>

                  {STATUS_LABEL[a.extracao_status] && a.extracao_status !== 'concluida' && a.extracao_status !== 'erro' && (
                    <p className="attachment-status">{STATUS_LABEL[a.extracao_status]}</p>
                  )}

                  {extracted && (
                    <div className="attachment-extraction">
                      <p className="attachment-extraction-hint">
                        Sugestão da IA — confira antes de usar, pode conter erros. Medicamentos
                        identificados já foram adicionados ao carrinho quando disponíveis em estoque.
                      </p>
                      <dl>
                        {extracted.medico && <><dt>Médico</dt><dd>{extracted.medico}</dd></>}
                        {extracted.crm && <><dt>CRM</dt><dd>{extracted.crm}</dd></>}
                        {extracted.numeroReceita && <><dt>Nº receita</dt><dd>{extracted.numeroReceita}</dd></>}
                        {extracted.dataReceita && <><dt>Data</dt><dd>{extracted.dataReceita}</dd></>}
                        {extracted.medicamentos?.length > 0 && <><dt>Medicamentos</dt><dd>{extracted.medicamentos.join(', ')}</dd></>}
                        {extracted.observacoes && <><dt>Observações</dt><dd>{extracted.observacoes}</dd></>}
                      </dl>
                    </div>
                  )}

                  {failed && <p className="modal-error">{failed.error}</p>}
                </li>
              );
            })}
          </ul>
        )}

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="close" size={15} /> Fechar</span>
          </button>
          <button className="btn-primary" onClick={handleAdd} disabled={busy}>
            {busy ? 'Abrindo...' : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Icon name="attachment" size={15} /> Anexar imagem ou PDF
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
