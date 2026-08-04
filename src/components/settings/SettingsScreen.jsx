import { useEffect, useState } from 'react';
import { useEscToClose } from '../../hooks/useEscToClose';
import { ProfileManager } from './ProfileManager';
import { isBeepEnabled, setBeepEnabled, playBeep } from '../../utils/sound';

const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

export function SettingsScreen() {
  const [aba, setAba] = useState('geral');
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
    cscId: '', cscToken: '', municipioCodigoIbge: '',
    endereco: { logradouro: '', numero: '', complemento: '', bairro: '', cep: '', municipio: '' },
  });
  const [fiscalSaving, setFiscalSaving] = useState(false);
  const [fiscalSaved, setFiscalSaved] = useState(false);
  const [selecionandoCertificado, setSelecionandoCertificado] = useState(false);

  const [pixForm, setPixForm] = useState({ pixChave: '', pixTipoChave: 'aleatoria', pixNomeRecebedor: '', pixCidade: '' });
  const [pixSaving, setPixSaving] = useState(false);
  const [pixSaved, setPixSaved] = useState(false);

  const [sincronizacaoAtiva, setSincronizacaoAtiva] = useState(false);

  const [loyaltyForm, setLoyaltyForm] = useState({ ativado: false, reaisPorPonto: 10, valorResgatePonto: 0.05 });
  const [loyaltySaving, setLoyaltySaving] = useState(false);
  const [loyaltySaved, setLoyaltySaved] = useState(false);

  const [backupStatus, setBackupStatus] = useState(null);
  const [receiptLargura, setReceiptLargura] = useState(80);
  const [receiptSaved, setReceiptSaved] = useState(false);
  const [receiptRodape, setReceiptRodape] = useState('');
  const [receiptAutoPrint, setReceiptAutoPrint] = useState(false);
  const [impressoras, setImpressoras] = useState([]);
  const [carregandoImpressoras, setCarregandoImpressoras] = useState(false);
  const [impressoraPadrao, setImpressoraPadrao] = useState('');
  const [impressoraSaved, setImpressoraSaved] = useState(false);
  const [testando, setTestando] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [balancaForm, setBalancaForm] = useState({ formato: 'peso_cod6', campo: 'peso' });
  const [formatosDisponiveis, setFormatosDisponiveis] = useState({});
  const [balancaFormatoSaved, setBalancaFormatoSaved] = useState(false);
  const [testeCodigoBarras, setTesteCodigoBarras] = useState('');
  const [testeResultado, setTesteResultado] = useState('');
  const [portasSeriais, setPortasSeriais] = useState([]);
  const [carregandoPortas, setCarregandoPortas] = useState(false);
  const [balancaHwForm, setBalancaHwForm] = useState({ porta: '', baudRate: 9600 });
  const [balancaHwSaved, setBalancaHwSaved] = useState(false);
  const [updateStatus, setUpdateStatus] = useState(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [somLigado, setSomLigado] = useState(isBeepEnabled());
  const [exigirAutorizacaoCancelamento, setExigirAutorizacaoCancelamento] = useState(true);
  const [exigirAutorizacaoDesconto, setExigirAutorizacaoDesconto] = useState(true);
  const [posDisplay, setPosDisplay] = useState({ modo_busca: 'lista', modo_vendidos_recentes: 'recente', qtd_vendidos_recentes: 12, tamanho_blocos: 'confortavel' });
  const [posDisplaySaved, setPosDisplaySaved] = useState(false);
  const [segurancaSaved, setSegurancaSaved] = useState(false);
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupMsg, setBackupMsg] = useState('');
  const [backupList, setBackupList] = useState([]);
  const [showRestoreList, setShowRestoreList] = useState(false);
  useEscToClose(() => setShowRestoreList(false), showRestoreList);
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
        cscId: f.csc_id || '', cscToken: '', municipioCodigoIbge: f.municipio_codigo_ibge || '',
        endereco: {
          logradouro: f.endereco?.logradouro || '', numero: f.endereco?.numero || '',
          complemento: f.endereco?.complemento || '', bairro: f.endereco?.bairro || '',
          cep: f.endereco?.cep || '', municipio: f.endereco?.municipio || '',
        },
      });
    });
    window.pdv.payment.getConfig().then((p) => {
      setPixForm({
        pixChave: p.pix_chave || '', pixTipoChave: p.pix_tipo_chave || 'aleatoria',
        pixNomeRecebedor: p.pix_nome_recebedor || '', pixCidade: p.pix_cidade || '',
      });
    });
    window.pdv.pdvRegistry.getStatus().then((s) => setSincronizacaoAtiva(s.sincronizacaoAtiva));
    window.pdv.loyalty.getConfig().then((l) => setLoyaltyForm({
      ativado: !!l.ativado, reaisPorPonto: l.reais_por_ponto, valorResgatePonto: l.valor_resgate_ponto,
    }));
    window.pdv.backup.getStatus().then(setBackupStatus);
    window.pdv.print.getReceiptConfig().then((c) => {
      setReceiptLargura(c.largura_mm);
      setReceiptRodape(c.rodape_texto || '');
      setReceiptAutoPrint(!!c.imprimir_automatico);
      setImpressoraPadrao(c.impressora_padrao || '');
    });
    window.pdv.update.getStatus().then(setUpdateStatus);
    window.pdv.weightBarcode.listFormatos().then(setFormatosDisponiveis);
    window.pdv.auth.getSecurityConfig().then((c) => {
      setExigirAutorizacaoCancelamento(c.exigir_autorizacao_cancelamento === 1);
      setExigirAutorizacaoDesconto(c.exigir_autorizacao_desconto === 1);
    });
    window.pdv.posDisplay.getConfig().then(setPosDisplay);
    window.pdv.weightBarcode.getConfig().then((c) => setBalancaForm({ formato: c.formato, campo: c.campo }));
    window.pdv.scaleHardware.getConfig().then((c) => setBalancaHwForm({ porta: c.porta || '', baudRate: c.baud_rate || 9600 }));
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

  async function handleSelectCertificado() {
    setSelecionandoCertificado(true);
    const result = await window.pdv.fiscal.selectCertificado();
    setSelecionandoCertificado(false);
    if (result.ok) setFiscalForm((prev) => ({ ...prev, certificadoPath: result.filePath }));
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

  async function handleListarImpressoras() {
    setCarregandoImpressoras(true);
    const list = await window.pdv.print.listPrinters();
    setCarregandoImpressoras(false);
    setImpressoras(Array.isArray(list) ? list : []);
  }

  async function handleSalvarImpressora(nome) {
    setImpressoraPadrao(nome);
    await window.pdv.print.updateReceiptConfig({
      larguraMm: receiptLargura, rodapeTexto: receiptRodape, imprimirAutomatico: receiptAutoPrint, impressoraPadrao: nome,
    });
    setImpressoraSaved(true);
    setTimeout(() => setImpressoraSaved(false), 2000);
  }

  async function handleTestarImpressao() {
    setTestando(true);
    setTestMsg('');
    const result = await window.pdv.print.testPage();
    setTestando(false);
    setTestMsg(result.ok ? 'Página de teste enviada.' : `Erro: ${result.error}`);
  }

  async function handleToggleAutorizacaoCancelamento(checked) {
    setExigirAutorizacaoCancelamento(checked);
    await window.pdv.auth.updateSecurityConfig({ exigirAutorizacaoCancelamento: checked });
    setSegurancaSaved(true);
    setTimeout(() => setSegurancaSaved(false), 2000);
  }

  async function handleToggleAutorizacaoDesconto(checked) {
    setExigirAutorizacaoDesconto(checked);
    await window.pdv.auth.updateSecurityConfig({ exigirAutorizacaoDesconto: checked });
    setSegurancaSaved(true);
    setTimeout(() => setSegurancaSaved(false), 2000);
  }

  async function handlePosDisplaySave(mudanca) {
    // Atualiza a tela na hora (não espera o backend confirmar), e
    // salva no banco em paralelo — resposta visual instantânea pra
    // quem está ajustando o select/número.
    setPosDisplay((prev) => ({
      ...prev,
      ...(mudanca.modoBusca !== undefined && { modo_busca: mudanca.modoBusca }),
      ...(mudanca.modoVendidosRecentes !== undefined && { modo_vendidos_recentes: mudanca.modoVendidosRecentes }),
      ...(mudanca.qtdVendidosRecentes !== undefined && { qtd_vendidos_recentes: mudanca.qtdVendidosRecentes }),
      ...(mudanca.tamanhoBlocos !== undefined && { tamanho_blocos: mudanca.tamanhoBlocos }),
    }));
    await window.pdv.posDisplay.updateConfig(mudanca);
    setPosDisplaySaved(true);
    setTimeout(() => setPosDisplaySaved(false), 2000);
  }

  async function handleSalvarBalancaFormato() {
    await window.pdv.weightBarcode.updateConfig(balancaForm);
    setBalancaFormatoSaved(true);
    setTimeout(() => setBalancaFormatoSaved(false), 2000);
  }

  async function handleTestarEtiqueta() {
    setTesteResultado('');
    const codigo = testeCodigoBarras.trim();
    const resultado = await window.pdv.weightBarcode.parse({ barcode: codigo });
    if (!resultado) {
      setTesteResultado('Não decodificou — confira se o código tem 13 dígitos e bate com o formato escolhido acima.');
      return;
    }
    if (resultado.pesoKg !== null) {
      setTesteResultado(`Decodificado: código da balança ${resultado.codigoBalanca}, peso ${resultado.pesoKg.toFixed(3)} kg.`);
    } else {
      setTesteResultado(`Decodificado: código da balança ${resultado.codigoBalanca}, preço total R$ ${resultado.precoTotal.toFixed(2)}.`);
    }
  }

  async function handleListarPortas() {
    setCarregandoPortas(true);
    const list = await window.pdv.scaleHardware.listPorts();
    setCarregandoPortas(false);
    setPortasSeriais(Array.isArray(list) ? list : []);
  }

  async function handleSalvarPortaBalanca(porta) {
    setBalancaHwForm((prev) => ({ ...prev, porta }));
    await window.pdv.scaleHardware.updateConfig({ porta, baudRate: balancaHwForm.baudRate });
    setBalancaHwSaved(true);
    setTimeout(() => setBalancaHwSaved(false), 2000);
  }

  async function handleSalvarBaudRate(baudRate) {
    setBalancaHwForm((prev) => ({ ...prev, baudRate }));
    await window.pdv.scaleHardware.updateConfig({ porta: balancaHwForm.porta, baudRate });
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

      <div className="settings-tabs">
        <button className={aba === 'geral' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('geral')}>Geral</button>
        <button className={aba === 'impressora' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('impressora')}>Impressora</button>
        <button className={aba === 'balanca' ? 'category-btn category-btn-active' : 'category-btn'} onClick={() => setAba('balanca')}>Balança</button>
      </div>

      {aba === 'geral' && (
      <>
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
        <h2>Segurança</h2>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox" style={{ width: 'auto' }}
            checked={exigirAutorizacaoCancelamento}
            onChange={(e) => handleToggleAutorizacaoCancelamento(e.target.checked)}
          />
          Exigir senha de gerente para cancelar item ou venda já paga
        </label>
        <p className="screen-hint" style={{ margin: '6px 0 0' }}>
          Ligado (padrão): depois que a venda já tem algum pagamento registrado, cancelar um item ou a
          venda inteira exige a senha de um gerente ou admin (nunca a do próprio operador do caixa).
          Desligado: qualquer operador cancela direto, sem pedir senha — o cancelamento continua sendo
          registrado no histórico normalmente, só sem exigir aprovação.
        </p>

        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 }}>
          <input
            type="checkbox" style={{ width: 'auto' }}
            checked={exigirAutorizacaoDesconto}
            onChange={(e) => handleToggleAutorizacaoDesconto(e.target.checked)}
          />
          Exigir senha de gerente para aplicar desconto manual
        </label>
        <p className="screen-hint" style={{ margin: '6px 0 0' }}>
          Ligado (padrão): aplicar um desconto manual (valor fixo ou porcentagem) exige a senha de um
          gerente ou admin. Desligado: qualquer operador aplica direto, sem pedir senha — continua
          registrado no histórico normalmente.
        </p>
        {segurancaSaved && <p className="io-message">Salvo.</p>}
      </section>

      <section className="settings-section">
        <h2>Personalização do PDV</h2>
        <p className="screen-hint">
          Só afeta esta máquina — cada terminal pode preferir um jeito diferente de exibir.
        </p>

        <label>
          Como mostrar os resultados da busca manual de produto
          <select value={posDisplay.modo_busca} onChange={(e) => handlePosDisplaySave({ modoBusca: e.target.value })}>
            <option value="lista">Lista (um abaixo do outro)</option>
            <option value="blocos">Blocos (grade, com miniatura)</option>
          </select>
        </label>

        <label style={{ marginTop: 12 }}>
          Ordem dos produtos em "Vendidos recentemente"
          <select value={posDisplay.modo_vendidos_recentes} onChange={(e) => handlePosDisplaySave({ modoVendidosRecentes: e.target.value })}>
            <option value="recente">Mais recente primeiro (reordena a cada venda)</option>
            <option value="frequente">Mais vendido primeiro (posição fixa, não pula)</option>
          </select>
        </label>
        <p className="screen-hint" style={{ margin: '6px 0 0' }}>
          "Mais recente" muda de posição toda vez que alguém vende qualquer coisa — o botão do produto
          favorito de quem opera o caixa pode pular de lugar no meio do expediente. "Mais vendido"
          olha os últimos 30 dias inteiros, então a posição fica bem mais estável — uma venda isolada
          quase nunca muda a ordem.
        </p>

        <label style={{ marginTop: 12 }}>
          Quantos produtos mostrar em "Vendidos recentemente"
          <input
            type="number" min="4" max="30" value={posDisplay.qtd_vendidos_recentes}
            onChange={(e) => handlePosDisplaySave({ qtdVendidosRecentes: Number(e.target.value) || 12 })}
            style={{ maxWidth: 100 }}
          />
        </label>

        <label style={{ marginTop: 12 }}>
          Tamanho dos blocos de produto
          <select value={posDisplay.tamanho_blocos} onChange={(e) => handlePosDisplaySave({ tamanhoBlocos: e.target.value })}>
            <option value="confortavel">Confortável (mais fácil de acertar o dedo/mouse)</option>
            <option value="compacto">Compacto (cabe mais produtos na tela)</option>
          </select>
        </label>
        {posDisplaySaved && <p className="io-message">Salvo.</p>}
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
            <label>Município
              <input
                value={fiscalForm.endereco.municipio}
                onChange={(e) => setFiscalForm({ ...fiscalForm, endereco: { ...fiscalForm.endereco, municipio: e.target.value } })}
                placeholder="Ex: Recife"
              />
            </label>
            <label>Código IBGE do município
              <input
                value={fiscalForm.municipioCodigoIbge}
                onChange={(e) => setFiscalForm({ ...fiscalForm, municipioCodigoIbge: e.target.value })}
                placeholder="Ex: 2611606 (7 dígitos — consulte no site do IBGE)"
              />
            </label>
            <label>Logradouro
              <input
                value={fiscalForm.endereco.logradouro}
                onChange={(e) => setFiscalForm({ ...fiscalForm, endereco: { ...fiscalForm.endereco, logradouro: e.target.value } })}
                placeholder="Ex: Rua das Flores"
              />
            </label>
            <label>Número
              <input
                value={fiscalForm.endereco.numero}
                onChange={(e) => setFiscalForm({ ...fiscalForm, endereco: { ...fiscalForm.endereco, numero: e.target.value } })}
              />
            </label>
            <label>Complemento (opcional)
              <input
                value={fiscalForm.endereco.complemento}
                onChange={(e) => setFiscalForm({ ...fiscalForm, endereco: { ...fiscalForm.endereco, complemento: e.target.value } })}
              />
            </label>
            <label>Bairro
              <input
                value={fiscalForm.endereco.bairro}
                onChange={(e) => setFiscalForm({ ...fiscalForm, endereco: { ...fiscalForm.endereco, bairro: e.target.value } })}
              />
            </label>
            <label>CEP
              <input
                value={fiscalForm.endereco.cep}
                onChange={(e) => setFiscalForm({ ...fiscalForm, endereco: { ...fiscalForm.endereco, cep: e.target.value } })}
                placeholder="00000-000"
              />
            </label>
            <label>Ambiente
              <select value={fiscalForm.ambiente} onChange={(e) => setFiscalForm({ ...fiscalForm, ambiente: e.target.value })}>
                <option value="homologacao">Homologação (testes)</option>
                <option value="producao">Produção</option>
              </select>
            </label>
            <label>Certificado digital (.pfx/.p12)
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  value={fiscalForm.certificadoPath}
                  readOnly
                  placeholder={fiscal?.temCertificadoConfigurado ? '(já configurado — clique em Selecionar pra trocar)' : 'Nenhum arquivo selecionado'}
                  style={{ flex: 1 }}
                />
                <button type="button" className="btn-secondary" onClick={handleSelectCertificado} disabled={selecionandoCertificado}>
                  {selecionandoCertificado ? 'Abrindo...' : 'Selecionar arquivo...'}
                </button>
              </div>
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
          Quando ativo, esse terminal soma no relatório consolidado do Painel junto com os outros
          PDVs do mesmo negócio. É configurado centralmente pelo suporte — não precisa mexer em
          nada aqui, só entrar em contato caso queira ativar ou tenha dúvida.
        </p>
        <div className="pdv-number-badge">
          {sincronizacaoAtiva ? (
            <>🔗 <strong>Sincronização ativa</strong> — este terminal está agrupado com outros PDVs.</>
          ) : (
            <>Sincronização não configurada para este terminal ainda.</>
          )}
        </div>
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
      </>
      )}

      {aba === 'impressora' && (
      <>
      <section className="settings-section">
        <h2>Formato do recibo</h2>
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
        <h2>Impressora padrão</h2>
        <p className="screen-hint">
          Sem uma impressora padrão escolhida, o sistema sempre pergunta qual usar (janela do
          Windows) — mais seguro, mas mais lento no dia a dia. Escolhendo uma aqui, imprime direto
          nela sem perguntar.
        </p>
        <button className="btn-secondary" onClick={handleListarImpressoras} disabled={carregandoImpressoras}>
          {carregandoImpressoras ? 'Buscando impressoras...' : 'Buscar impressoras instaladas'}
        </button>

        {impressoras.length > 0 && (
          <div className="profile-cards" style={{ marginTop: 12 }}>
            <button
              className={`profile-card ${!impressoraPadrao ? 'profile-card-active' : ''}`}
              onClick={() => handleSalvarImpressora('')}
            >
              <strong>Nenhuma</strong>
              <span>Sempre perguntar</span>
            </button>
            {impressoras.map((p) => (
              <button
                key={p.nome}
                className={`profile-card ${impressoraPadrao === p.nome ? 'profile-card-active' : ''}`}
                onClick={() => handleSalvarImpressora(p.nome)}
              >
                <strong>{p.nome}</strong>
                <span>{p.padraoDoSistema ? 'Padrão do Windows' : ''}</span>
              </button>
            ))}
          </div>
        )}
        {impressoraSaved && <p className="io-message">Impressora padrão salva.</p>}

        <div style={{ marginTop: 16 }}>
          <button className="btn-primary" onClick={handleTestarImpressao} disabled={testando}>
            {testando ? 'Enviando...' : 'Imprimir página de teste'}
          </button>
          {testMsg && <p className="io-message">{testMsg}</p>}
        </div>
      </section>
      </>
      )}

      {aba === 'balanca' && (
      <>
      <section className="settings-section">
        <h2>Etiqueta de peso variável</h2>
        <p className="screen-hint">
          Não existe um único formato de etiqueta — cada balança é configurada pelo fabricante/técnico
          de um jeito. Escolha o que bate com a etiqueta impressa pela sua balança (peça pra alguém
          escanear uma pra conferir se o valor decodificado aqui embaixo bate com o peso real).
        </p>
        <label>Formato da etiqueta
          <select value={balancaForm.formato} onChange={(e) => setBalancaForm({ ...balancaForm, formato: e.target.value })}>
            {Object.entries(formatosDisponiveis).map(([chave, info]) => (
              <option key={chave} value={chave}>{info.label}</option>
            ))}
          </select>
        </label>
        <label>O que os dígitos do meio representam
          <select value={balancaForm.campo} onChange={(e) => setBalancaForm({ ...balancaForm, campo: e.target.value })}>
            <option value="peso">Peso (a maioria das balanças usa isso)</option>
            <option value="preco_total">Preço total já calculado</option>
          </select>
        </label>
        <button className="btn-secondary" onClick={handleSalvarBalancaFormato}>Salvar</button>
        {balancaFormatoSaved && <p className="io-message">Salvo.</p>}

        <div style={{ marginTop: 16 }}>
          <label>Testar com um código de barras
            <input
              value={testeCodigoBarras}
              onChange={(e) => setTesteCodigoBarras(e.target.value)}
              placeholder="Escaneie ou digite os 13 dígitos de uma etiqueta"
            />
          </label>
          <button className="btn-secondary" onClick={handleTestarEtiqueta}>Testar</button>
          {testeResultado && (
            <p className={testeResultado.startsWith('Não') ? 'modal-error' : 'io-message'} style={{ marginTop: 8 }}>{testeResultado}</p>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h2>Balança digital (porta serial)</h2>
        <p className="screen-hint">
          Opcional — sem isso configurado, o PDV só aceita peso digitado manualmente ou lido da
          etiqueta impressa. <strong>Essa parte não foi testada contra uma balança real</strong> — teste
          com cuidado antes de confiar no dia a dia (ver BALANCA.md).
        </p>
        <button className="btn-secondary" onClick={handleListarPortas} disabled={carregandoPortas}>
          {carregandoPortas ? 'Buscando portas...' : 'Buscar portas seriais disponíveis'}
        </button>
        {portasSeriais.length > 0 && (
          <div className="profile-cards" style={{ marginTop: 12 }}>
            <button
              className={`profile-card ${!balancaHwForm.porta ? 'profile-card-active' : ''}`}
              onClick={() => handleSalvarPortaBalanca('')}
            >
              <strong>Nenhuma</strong>
              <span>Só manual/etiqueta</span>
            </button>
            {portasSeriais.map((p) => (
              <button
                key={p.caminho}
                className={`profile-card ${balancaHwForm.porta === p.caminho ? 'profile-card-active' : ''}`}
                onClick={() => handleSalvarPortaBalanca(p.caminho)}
              >
                <strong>{p.caminho}</strong>
                <span>{p.fabricante}</span>
              </button>
            ))}
          </div>
        )}
        {balancaHwSaved && <p className="io-message">Porta salva.</p>}

        <label style={{ marginTop: 12 }}>Velocidade (baud rate)
          <select value={balancaHwForm.baudRate} onChange={(e) => handleSalvarBaudRate(Number(e.target.value))}>
            {[1200, 2400, 4800, 9600, 19200, 38400].map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
      </section>
      </>
      )}

      {saved && <p className="io-message">Configuração salva.</p>}
    </div>
  );
}
