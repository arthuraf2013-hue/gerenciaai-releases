import { useEffect, useState } from 'react';
import { ProfileManager } from './ProfileManager';
import { isBeepEnabled, setBeepEnabled, playBeep } from '../../utils/sound';

const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

export function SettingsScreen() {
  const [locationId, setLocationId] = useState(null);
  const [locationName, setLocationName] = useState('');
  const [saved, setSaved] = useState(false);

  const [aiSettings, setAiSettings] = useState(null);
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiModelo, setAiModelo] = useState('gemini-3.1-flash-lite');
  const [aiAtivado, setAiAtivado] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiSaved, setAiSaved] = useState(false);

  const [fiscal, setFiscal] = useState(null);
  const [fiscalForm, setFiscalForm] = useState({
    cnpj: '', inscricaoEstadual: '', razaoSocial: '', nomeFantasia: '',
    regimeTributario: '', uf: '', ambiente: 'homologacao', certificadoPath: '', certificadoSenha: '',
    cscId: '', cscToken: '',
  });
  const [fiscalSaving, setFiscalSaving] = useState(false);
  const [fiscalSaved, setFiscalSaved] = useState(false);

  const [pixForm, setPixForm] = useState({ pixChave: '', pixTipoChave: 'aleatoria', pixNomeRecebedor: '', pixCidade: '' });
  const [pixSaving, setPixSaving] = useState(false);
  const [pixSaved, setPixSaved] = useState(false);

  const [syncForm, setSyncForm] = useState({ apiKey: '', authDomain: '', projectId: '', appId: '', ativado: false });
  const [syncSaving, setSyncSaving] = useState(false);
  const [syncSaved, setSyncSaved] = useState(false);
  const [pdvStatus, setPdvStatus] = useState(null);
  const [registrando, setRegistrando] = useState(false);
  const [registroErro, setRegistroErro] = useState('');

  const [loyaltyForm, setLoyaltyForm] = useState({ ativado: false, reaisPorPonto: 10, valorResgatePonto: 0.05 });
  const [loyaltySaving, setLoyaltySaving] = useState(false);
  const [loyaltySaved, setLoyaltySaved] = useState(false);

  const [backupStatus, setBackupStatus] = useState(null);
  const [receiptLargura, setReceiptLargura] = useState(80);
  const [receiptSaved, setReceiptSaved] = useState(false);
  const [receiptRodape, setReceiptRodape] = useState('');
  const [receiptAutoPrint, setReceiptAutoPrint] = useState(false);
  const [updateStatus, setUpdateStatus] = useState(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [somLigado, setSomLigado] = useState(isBeepEnabled());
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupMsg, setBackupMsg] = useState('');
  const [backupList, setBackupList] = useState([]);
  const [showRestoreList, setShowRestoreList] = useState(false);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    window.pdv.settings.get().then((s) => {
      setLocationId(s.location.id);
      setLocationName(s.location.nome);
    });
    window.pdv.ai.getSettings().then((s) => {
      setAiSettings(s);
      setAiModelo(s.modelo);
      setAiAtivado(s.ativado);
    });
    window.pdv.fiscal.getConfig().then((f) => {
      setFiscal(f);
      setFiscalForm({
        cnpj: f.cnpj || '', inscricaoEstadual: f.inscricao_estadual || '',
        razaoSocial: f.razao_social || '', nomeFantasia: f.nome_fantasia || '',
        regimeTributario: f.regime_tributario || '', uf: f.uf || '',
        ambiente: f.ambiente || 'homologacao', certificadoPath: '', certificadoSenha: '',
        cscId: f.csc_id || '', cscToken: '',
      });
    });
    window.pdv.payment.getConfig().then((p) => {
      setPixForm({
        pixChave: p.pix_chave || '', pixTipoChave: p.pix_tipo_chave || 'aleatoria',
        pixNomeRecebedor: p.pix_nome_recebedor || '', pixCidade: p.pix_cidade || '',
      });
    });
    window.pdv.pdvRegistry.getConfig().then((c) => setSyncForm(c));
    window.pdv.pdvRegistry.getStatus().then(setPdvStatus);
    window.pdv.loyalty.getConfig().then((l) => setLoyaltyForm({
      ativado: !!l.ativado, reaisPorPonto: l.reais_por_ponto, valorResgatePonto: l.valor_resgate_ponto,
    }));
    window.pdv.backup.getStatus().then(setBackupStatus);
    window.pdv.print.getReceiptConfig().then((c) => {
      setReceiptLargura(c.largura_mm);
      setReceiptRodape(c.rodape_texto || '');
      setReceiptAutoPrint(!!c.imprimir_automatico);
    });
    window.pdv.update.getStatus().then(setUpdateStatus);
  }, []);

  // Enquanto está verificando ou baixando, consulta o status de novo a
  // cada 1.5s pra atualizar a barra de progresso sozinha.
  useEffect(() => {
    if (!updateStatus?.checking && !updateStatus?.baixando) return;
    const id = setInterval(() => window.pdv.update.getStatus().then(setUpdateStatus), 1500);
    return () => clearInterval(id);
  }, [updateStatus?.checking, updateStatus?.baixando]);

  async function handleLocationSave(e) {
    e.preventDefault();
    await window.pdv.settings.updateLocationName({ locationId, nome: locationName });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleAiSave(e) {
    e.preventDefault();
    setAiSaving(true);
    await window.pdv.ai.updateSettings({
      apiKey: aiApiKey || undefined, // string vazia não sobrescreve a chave já salva
      modelo: aiModelo,
      ativado: aiAtivado,
    });
    const refreshed = await window.pdv.ai.getSettings();
    setAiSettings(refreshed);
    setAiApiKey('');
    setAiSaving(false);
    setAiSaved(true);
    setTimeout(() => setAiSaved(false), 2000);
  }

  async function handleFiscalSave(e) {
    e.preventDefault();
    setFiscalSaving(true);
    await window.pdv.fiscal.updateConfig({
      ...fiscalForm,
      certificadoPath: fiscalForm.certificadoPath || undefined,
      certificadoSenha: fiscalForm.certificadoSenha || undefined,
      cscToken: fiscalForm.cscToken || undefined,
    });
    const refreshed = await window.pdv.fiscal.getConfig();
    setFiscal(refreshed);
    setFiscalForm((prev) => ({ ...prev, certificadoSenha: '', cscToken: '' }));
    setFiscalSaving(false);
    setFiscalSaved(true);
    setTimeout(() => setFiscalSaved(false), 2000);
  }

  async function handlePixSave(e) {
    e.preventDefault();
    setPixSaving(true);
    await window.pdv.payment.updateConfig(pixForm);
    setPixSaving(false);
    setPixSaved(true);
    setTimeout(() => setPixSaved(false), 2000);
  }

  async function handleSyncSave(e) {
    e.preventDefault();
    setSyncSaving(true);
    await window.pdv.pdvRegistry.updateConfig(syncForm);
    setSyncSaving(false);
    setSyncSaved(true);
    setTimeout(() => setSyncSaved(false), 2000);
  }

  async function handleRegisterPdv() {
    setRegistrando(true);
    setRegistroErro('');
    const result = await window.pdv.pdvRegistry.register();
    setRegistrando(false);
    if (!result.ok) return setRegistroErro(result.error);
    const status = await window.pdv.pdvRegistry.getStatus();
    setPdvStatus(status);
  }

  async function handleLoyaltySave(e) {
    e.preventDefault();
    setLoyaltySaving(true);
    await window.pdv.loyalty.updateConfig(loyaltyForm);
    setLoyaltySaving(false);
    setLoyaltySaved(true);
    setTimeout(() => setLoyaltySaved(false), 2000);
  }

  async function handleBackupNow() {
    setBackupRunning(true);
    setBackupMsg('');
    const result = await window.pdv.backup.runNow();
    setBackupRunning(false);
    setBackupMsg(result.ok
      ? `Backup feito com sucesso.${result.avisoSecundaria ? ' ' + result.avisoSecundaria : ''}`
      : result.error);
    window.pdv.backup.getStatus().then(setBackupStatus);
  }

  async function handleChooseSecondaryFolder() {
    const result = await window.pdv.backup.chooseSecondaryFolder();
    if (result.canceled) return;
    window.pdv.backup.getStatus().then(setBackupStatus);
  }

  async function handleReceiptSave(larguraMm) {
    setReceiptLargura(larguraMm);
    await window.pdv.print.updateReceiptConfig({ larguraMm, rodapeTexto: receiptRodape, imprimirAutomatico: receiptAutoPrint });
    setReceiptSaved(true);
    setTimeout(() => setReceiptSaved(false), 2000);
  }

  async function handleReceiptRodapeSave(e) {
    e.preventDefault();
    await window.pdv.print.updateReceiptConfig({ larguraMm: receiptLargura, rodapeTexto: receiptRodape, imprimirAutomatico: receiptAutoPrint });
    setReceiptSaved(true);
    setTimeout(() => setReceiptSaved(false), 2000);
  }

  async function handleAutoPrintToggle(checked) {
    setReceiptAutoPrint(checked);
    await window.pdv.print.updateReceiptConfig({ larguraMm: receiptLargura, rodapeTexto: receiptRodape, imprimirAutomatico: checked });
  }

  async function handleCheckUpdate() {
    setUpdateBusy(true);
    await window.pdv.update.check();
    setTimeout(async () => {
      setUpdateStatus(await window.pdv.update.getStatus());
      setUpdateBusy(false);
    }, 1500);
  }

  async function handleDownloadUpdate() {
    setUpdateBusy(true);
    const result = await window.pdv.update.download();
    setUpdateBusy(false);
    if (!result.ok) return setUpdateStatus((s) => ({ ...s, erro: result.error }));
    setUpdateStatus(await window.pdv.update.getStatus());
  }

  async function handleInstallUpdate() {
    if (!confirm('O app vai fechar e reabrir já atualizado. Continuar?')) return;
    await window.pdv.update.install();
  }

  function handleToggleSom(checked) {
    setSomLigado(checked);
    setBeepEnabled(checked);
    if (checked) playBeep();
  }

  async function handleShowRestoreList() {
    const list = await window.pdv.backup.list();
    setBackupList(Array.isArray(list) ? list : []);
    setShowRestoreList(true);
  }

  async function handleRestore(nomeArquivo) {
    const confirmado = confirm(
      `Restaurar o backup "${nomeArquivo}"?\n\nISSO SUBSTITUI TODOS OS DADOS ATUAIS (vendas, estoque, clientes) pelos ` +
      `dados desse backup, sem volta. O app vai reiniciar sozinho em seguida.`
    );
    if (!confirmado) return;
    setRestoring(true);
    const result = await window.pdv.backup.restore({ nomeArquivo });
    if (!result.ok) {
      setRestoring(false);
      setBackupMsg(result.error);
    }
    // se deu certo, o app reinicia sozinho — não precisa fazer mais nada aqui
  }

  return (
    <div className="screen">
      <h1>Configurações</h1>

      <section className="settings-section">
        <h2>Backup</h2>
        <p className="screen-hint">
          Cópia automática do banco de dados, uma vez por dia (usa a API nativa de backup do
          SQLite — segura mesmo com o app em uso). Guarda os últimos 30 dias localmente.
          Configurar uma pasta secundária (pendrive, OneDrive, Google Drive) é fortemente
          recomendado — sem isso, o único lugar onde os dados existem é este computador.
        </p>
        {backupStatus && (
          <div className="pdv-number-badge" style={{ background: backupStatus.ultimoBackupOk ? undefined : 'var(--color-danger)' }}>
            {backupStatus.ultimoBackupEm
              ? `Último backup: ${new Date(backupStatus.ultimoBackupEm + 'Z').toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} ${backupStatus.ultimoBackupOk ? '(OK)' : '(FALHOU)'}`
              : 'Nenhum backup feito ainda'}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          <button className="btn-primary" onClick={handleBackupNow} disabled={backupRunning}>
            {backupRunning ? 'Fazendo backup...' : 'Fazer backup agora'}
          </button>
          <button className="btn-secondary" onClick={handleChooseSecondaryFolder}>
            {backupStatus?.pastaSecundaria ? 'Trocar pasta secundária' : 'Escolher pasta secundária'}
          </button>
          <button className="btn-secondary" onClick={() => window.pdv.backup.openFolder()}>Abrir pasta de backups</button>
          <button className="btn-secondary" onClick={handleShowRestoreList}>Restaurar backup</button>
        </div>
        {backupStatus?.pastaSecundaria && (
          <p className="screen-hint" style={{ marginBottom: 0 }}>Pasta secundária: {backupStatus.pastaSecundaria}</p>
        )}
        {backupMsg && <p className={backupMsg.includes('sucesso') ? 'io-message' : 'modal-error'}>{backupMsg}</p>}

        {showRestoreList && (
          <div className="modal-overlay">
            <div className="modal-card modal-card-wide">
              <h2>Restaurar backup</h2>
              <p className="screen-hint">
                Isso substitui todos os dados atuais pelos do backup escolhido — sem volta. O app
                reinicia sozinho depois de restaurar.
              </p>
              {backupList.length === 0 ? (
                <p className="empty-state">Nenhum backup encontrado ainda.</p>
              ) : (
                <ul className="payment-list" style={{ maxHeight: 280, overflowY: 'auto' }}>
                  {backupList.map((b) => (
                    <li key={b.nome} className="payment-list-item">
                      <span>
                        {new Date(b.criadoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
                        {' — '}{(b.tamanhoBytes / 1024).toFixed(0)} KB
                      </span>
                      <button className="btn-link-danger" onClick={() => handleRestore(b.nome)} disabled={restoring}>
                        {restoring ? 'Restaurando...' : 'Restaurar este'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button className="btn-secondary" style={{ marginTop: 16 }} onClick={() => setShowRestoreList(false)} disabled={restoring}>
                Fechar
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="settings-section">
        <h2>Preferências do PDV</h2>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox" style={{ width: 'auto' }}
            checked={somLigado}
            onChange={(e) => handleToggleSom(e.target.checked)}
          />
          Tocar som ao adicionar produto ao carrinho
        </label>
      </section>

      <section className="settings-section">
        <h2>Recibo</h2>
        <p className="screen-hint">
          Formato usado ao imprimir o recibo depois de uma venda. Escolha conforme a impressora da loja.
        </p>
        <div className="profile-cards">
          {[
            { valor: 80, label: 'Térmica 80mm', desc: 'Mais comum em PDV' },
            { valor: 58, label: 'Térmica 58mm', desc: 'Impressoras portáteis/compactas' },
            { valor: 210, label: 'Folha A4', desc: 'Impressora comum' },
          ].map((opt) => (
            <button
              key={opt.valor}
              className={`profile-card ${receiptLargura === opt.valor ? 'profile-card-active' : ''}`}
              onClick={() => handleReceiptSave(opt.valor)}
            >
              <strong>{opt.label}</strong>
              <span>{opt.desc}</span>
            </button>
          ))}
        </div>
        {receiptSaved && <p className="io-message">Formato de recibo salvo.</p>}

        <form className="inline-form" onSubmit={handleReceiptRodapeSave} style={{ marginTop: 14 }}>
          <label style={{ flex: 1 }}>Rodapé do recibo (opcional — telefone, horário, etc.)
            <input
              value={receiptRodape} onChange={(e) => setReceiptRodape(e.target.value)}
              placeholder="Ex: (81) 3333-4444 — Seg a Sáb, 8h às 20h"
            />
          </label>
          <button className="btn-secondary" type="submit">Salvar rodapé</button>
        </form>

        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <input
            type="checkbox" style={{ width: 'auto' }}
            checked={receiptAutoPrint}
            onChange={(e) => handleAutoPrintToggle(e.target.checked)}
          />
          Imprimir automaticamente ao finalizar a venda
        </label>
      </section>

      <section className="settings-section">
        <h2>Atualização do app</h2>
        <p className="screen-hint">
          Versão instalada: <strong>{updateStatus?.versaoAtual || '—'}</strong>
        </p>
        <div className="update-actions">
          <button className="btn-secondary" onClick={handleCheckUpdate} disabled={updateBusy || updateStatus?.checking}>
            {updateStatus?.checking ? 'Verificando...' : 'Verificar atualização'}
          </button>
          {updateStatus?.disponivel && !updateStatus?.baixado && (
            <button className="btn-primary" onClick={handleDownloadUpdate} disabled={updateStatus?.baixando}>
              {updateStatus?.baixando ? `Baixando... ${updateStatus.progresso}%` : `Baixar versão ${updateStatus.versaoDisponivel}`}
            </button>
          )}
          {updateStatus?.baixado && (
            <button className="btn-primary" onClick={handleInstallUpdate}>Reiniciar e instalar agora</button>
          )}
        </div>
        {updateStatus && !updateStatus.checking && !updateStatus.disponivel && !updateStatus.erro && (
          <p className="io-message">Você já está na versão mais recente.</p>
        )}
        {updateStatus?.erro && (
          <p className="modal-error">
            {updateStatus.erro}
            <br />
            <span className="screen-hint" style={{ margin: 0 }}>
              {updateStatus.erro.includes('404')
                ? 'Erro 404: o repositório de releases precisa ser PÚBLICO (repositório privado sempre dá 404 nessa verificação), ou ainda não tem nenhuma versão publicada nele. Veja o README (seção "Atualização automática").'
                : 'Se a mensagem falar de "owner"/"repo", a publicação de atualizações ainda não foi configurada — veja o README (seção "Atualização automática") pra configurar.'}
            </span>
          </p>
        )}
      </section>

      <ProfileManager />

      <section className="settings-section">
        <h2>Loja / local</h2>
        <form className="inline-form" onSubmit={handleLocationSave}>
          <label>
            Nome da loja
            <input value={locationName} onChange={(e) => setLocationName(e.target.value)} />
          </label>
          <button className="btn-primary" type="submit">Salvar</button>
        </form>
      </section>

      <section className="settings-section">
        <h2>Fiscal (NFC-e) — em preparação</h2>
        <p className="screen-hint">
          <strong>A emissão de NFC-e ainda não está implementada.</strong> Isso exige CNPJ com
          Inscrição Estadual ativa e certificado digital (A1/A3) reais para desenvolver e testar
          contra o ambiente de homologação da SEFAZ do seu estado. O que você preencher aqui fica
          guardado e pronto para quando a emissão for implementada — nada é enviado a lugar
          nenhum ainda.
        </p>
        <form className="product-form" onSubmit={handleFiscalSave}>
          <div className="form-grid">
            <label>CNPJ
              <input value={fiscalForm.cnpj} onChange={(e) => setFiscalForm({ ...fiscalForm, cnpj: e.target.value })} placeholder="00.000.000/0000-00" />
            </label>
            <label>Inscrição Estadual
              <input value={fiscalForm.inscricaoEstadual} onChange={(e) => setFiscalForm({ ...fiscalForm, inscricaoEstadual: e.target.value })} />
            </label>
            <label>Razão social
              <input value={fiscalForm.razaoSocial} onChange={(e) => setFiscalForm({ ...fiscalForm, razaoSocial: e.target.value })} />
            </label>
            <label>Nome fantasia
              <input value={fiscalForm.nomeFantasia} onChange={(e) => setFiscalForm({ ...fiscalForm, nomeFantasia: e.target.value })} />
            </label>
            <label>Regime tributário
              <select value={fiscalForm.regimeTributario} onChange={(e) => setFiscalForm({ ...fiscalForm, regimeTributario: e.target.value })}>
                <option value="">Selecione...</option>
                <option value="simples_nacional">Simples Nacional</option>
                <option value="mei">MEI</option>
                <option value="lucro_presumido">Lucro Presumido</option>
                <option value="lucro_real">Lucro Real</option>
              </select>
            </label>
            <label>UF (estado)
              <select value={fiscalForm.uf} onChange={(e) => setFiscalForm({ ...fiscalForm, uf: e.target.value })}>
                <option value="">Selecione...</option>
                {UFS.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
              </select>
            </label>
            <label>Ambiente
              <select value={fiscalForm.ambiente} onChange={(e) => setFiscalForm({ ...fiscalForm, ambiente: e.target.value })}>
                <option value="homologacao">Homologação (testes)</option>
                <option value="producao">Produção</option>
              </select>
            </label>
            <label>Caminho do certificado (.pfx/.p12)
              <input
                value={fiscalForm.certificadoPath}
                onChange={(e) => setFiscalForm({ ...fiscalForm, certificadoPath: e.target.value })}
                placeholder={fiscal?.temCertificadoConfigurado ? '(já configurado)' : 'C:\\caminho\\certificado.pfx'}
              />
            </label>
            <label>Senha do certificado
              <input
                type="password"
                value={fiscalForm.certificadoSenha}
                onChange={(e) => setFiscalForm({ ...fiscalForm, certificadoSenha: e.target.value })}
                placeholder={fiscal?.temCertificadoConfigurado ? '•••••• (já configurada)' : ''}
              />
            </label>
            <label>CSC ID
              <input value={fiscalForm.cscId} onChange={(e) => setFiscalForm({ ...fiscalForm, cscId: e.target.value })} />
            </label>
            <label>CSC Token
              <input
                type="password"
                value={fiscalForm.cscToken}
                onChange={(e) => setFiscalForm({ ...fiscalForm, cscToken: e.target.value })}
                placeholder={fiscal?.temCscConfigurado ? '•••••• (já configurado)' : ''}
              />
            </label>
          </div>
          <div>
            <button className="btn-primary" type="submit" disabled={fiscalSaving}>
              {fiscalSaving ? 'Salvando...' : 'Salvar configuração fiscal'}
            </button>
          </div>
        </form>
        {fiscalSaved && <p className="io-message">Configuração fiscal salva.</p>}
      </section>

      <section className="settings-section">
        <h2>Pagamento (Pix)</h2>
        <p className="screen-hint">
          Cadastre sua chave Pix para gerar o QR Code de cobrança direto no PDV. Não há
          integração bancária — o recebimento é conferido manualmente pelo operador.
        </p>
        <form className="inline-form" onSubmit={handlePixSave}>
          <label>Tipo de chave
            <select value={pixForm.pixTipoChave} onChange={(e) => setPixForm({ ...pixForm, pixTipoChave: e.target.value })}>
              <option value="cpf">CPF</option>
              <option value="cnpj">CNPJ</option>
              <option value="email">E-mail</option>
              <option value="telefone">Telefone</option>
              <option value="aleatoria">Chave aleatória</option>
            </select>
          </label>
          <label>Chave Pix
            <input value={pixForm.pixChave} onChange={(e) => setPixForm({ ...pixForm, pixChave: e.target.value })} placeholder="chave, CPF/CNPJ, e-mail ou telefone" />
          </label>
          <label>Nome do recebedor
            <input value={pixForm.pixNomeRecebedor} onChange={(e) => setPixForm({ ...pixForm, pixNomeRecebedor: e.target.value })} maxLength={25} />
          </label>
          <label>Cidade
            <input value={pixForm.pixCidade} onChange={(e) => setPixForm({ ...pixForm, pixCidade: e.target.value })} maxLength={15} />
          </label>
          <button className="btn-primary" type="submit" disabled={pixSaving}>
            {pixSaving ? 'Salvando...' : 'Salvar chave Pix'}
          </button>
        </form>
        {pixSaved && <p className="io-message">Chave Pix salva.</p>}
      </section>

      <section className="settings-section">
        <h2>Programa de fidelidade</h2>
        <p className="screen-hint">
          Clientes vinculados a uma venda acumulam pontos automaticamente. Pontos podem ser
          resgatados como desconto na hora do pagamento.
        </p>
        <form className="inline-form" onSubmit={handleLoyaltySave}>
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={loyaltyForm.ativado} onChange={(e) => setLoyaltyForm({ ...loyaltyForm, ativado: e.target.checked })} style={{ width: 'auto' }} />
            Ativar fidelidade
          </label>
          <label>1 ponto a cada R$
            <input type="number" step="0.5" value={loyaltyForm.reaisPorPonto} onChange={(e) => setLoyaltyForm({ ...loyaltyForm, reaisPorPonto: Number(e.target.value) })} />
          </label>
          <label>Valor de cada ponto no resgate (R$)
            <input type="number" step="0.01" value={loyaltyForm.valorResgatePonto} onChange={(e) => setLoyaltyForm({ ...loyaltyForm, valorResgatePonto: Number(e.target.value) })} />
          </label>
          <button className="btn-primary" type="submit" disabled={loyaltySaving}>
            {loyaltySaving ? 'Salvando...' : 'Salvar'}
          </button>
        </form>
        {loyaltySaved && <p className="io-message">Configuração de fidelidade salva.</p>}
      </section>

      <section className="settings-section">
        <h2>Sincronização entre PDVs (opcional)</h2>
        <p className="screen-hint">
          <strong>Fase 1 do roadmap de múltiplos PDVs.</strong> Quando ativado, todo PDV com o
          mesmo CNPJ (configurado em Fiscal) recebe um número automático (PDV001, PDV002...) via
          Firebase. Sem isso configurado, o app continua 100% local, como sempre foi — nada muda.
        </p>
        {pdvStatus?.numeroPdv && (
          <div className="pdv-number-badge">Este terminal é o <strong>{pdvStatus.numeroPdv}</strong></div>
        )}
        <form className="product-form" onSubmit={handleSyncSave}>
          <div className="form-grid">
            <label>API Key
              <input value={syncForm.apiKey} onChange={(e) => setSyncForm({ ...syncForm, apiKey: e.target.value })} />
            </label>
            <label>Auth Domain
              <input value={syncForm.authDomain} onChange={(e) => setSyncForm({ ...syncForm, authDomain: e.target.value })} placeholder="seu-projeto.firebaseapp.com" />
            </label>
            <label>Project ID
              <input value={syncForm.projectId} onChange={(e) => setSyncForm({ ...syncForm, projectId: e.target.value })} />
            </label>
            <label>App ID
              <input value={syncForm.appId} onChange={(e) => setSyncForm({ ...syncForm, appId: e.target.value })} />
            </label>
          </div>
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={syncForm.ativado} onChange={(e) => setSyncForm({ ...syncForm, ativado: e.target.checked })} style={{ width: 'auto' }} />
            Ativar sincronização entre PDVs
          </label>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn-primary" type="submit" disabled={syncSaving}>
              {syncSaving ? 'Salvando...' : 'Salvar configuração'}
            </button>
            <button type="button" className="btn-secondary" onClick={handleRegisterPdv} disabled={registrando || !syncForm.ativado}>
              {registrando ? 'Registrando...' : 'Registrar este PDV'}
            </button>
          </div>
        </form>
        {registroErro && <p className="modal-error">{registroErro}</p>}
        {syncSaved && <p className="io-message">Configuração de sincronização salva.</p>}
      </section>

      <section className="settings-section">
        <h2>IA (opcional)</h2>
        <p className="screen-hint">
          Usa a API Gemini para ler receitas/notas anexadas às vendas e extrair os dados
          automaticamente. Nunca é obrigatório e nunca bloqueia uma venda. Gere uma chave
          gratuita em <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a>.
        </p>
        <form className="product-form" onSubmit={handleAiSave}>
          <div className="form-grid">
            <label>
              Chave da API Gemini
              <input
                type="password"
                value={aiApiKey}
                onChange={(e) => setAiApiKey(e.target.value)}
                placeholder={aiSettings?.temChaveConfigurada ? '•••••••••••• (já configurada)' : 'Cole sua chave aqui'}
              />
            </label>
            <label>
              Modelo
              <input value={aiModelo} onChange={(e) => setAiModelo(e.target.value)} />
            </label>
          </div>
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={aiAtivado} onChange={(e) => setAiAtivado(e.target.checked)} style={{ width: 'auto' }} />
            Ativar extração por IA nos anexos de venda
          </label>
          <div>
            <button className="btn-primary" type="submit" disabled={aiSaving}>
              {aiSaving ? 'Salvando...' : 'Salvar configuração de IA'}
            </button>
          </div>
        </form>
        {aiSaved && <p className="io-message">Configuração de IA salva.</p>}
      </section>

      {saved && <p className="io-message">Configuração salva.</p>}
    </div>
  );
}
