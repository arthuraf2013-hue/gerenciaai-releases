// Licença do PDV mobile autônomo -- mesmo modelo do GerenciaAI do
// computador (electron/services/licenseService.js), controlado pela
// mesma Central:
//
//   bloqueio imediato (painel)      -> BLOQUEADO na hora (total)
//   congelada (painel)              -> AVISO por 2 dias, depois SOMENTE
//                                      LEITURA (parcial: consulta, relatório
//                                      e backup seguem; vender não)
//   3 dias sem falar com o servidor -> BLOQUEADO até conectar
//   relógio do aparelho voltou atrás-> BLOQUEADO até validar online
//
// Bloquear o cliente inteiro na Central (botão "Bloquear tudo") marca
// cada instalação dele -- celulares inclusive, porque cada celular é uma
// instalação comum em `installations/`.
import {
  agoraMs, agoraDoDispositivoMs, relogioMax, carregarRelogioMax, sincronizarRelogioComServidor,
  TOLERANCIA_RELOGIO_MS, lerConfig, gravarConfig, novoId, ErroDeNegocio, definirContexto, auditar, AGORA_SERVIDOR,
} from './base.js';
import { criarUsuario } from './usuarios.js';
import { definirGuardaDeVenda } from './vendas.js';

export const TIPO_INSTALACAO = 'pdv_mobile_autonomo';
export const CARENCIA_CONGELADA_DIAS = 2;
export const LIMITE_SEM_INTERNET_DIAS = 3;
export const AVISO_SEM_INTERNET_DIAS = 2;
export const BACKUP_FREQUENCIA_PADRAO_H = 1;
export const BACKUP_RETENCAO_PADRAO_DIAS = 30;
export const BACKUP_RETENCAO_MAX_DIAS = 30;
const DIA = 86400000;
const INTERVALO_PING_MS = 2 * 60 * 1000;
const INTERVALO_VERIFICACAO_MS = 6 * 60 * 60 * 1000;

const GRAVIDADE = { ok: 0, aviso: 1, somente_leitura: 2, bloqueado: 3 };

/**
 * Decide o estado SÓ com o que está guardado no aparelho -- funciona 100%
 * offline. Função pura (testável sem rede nem relógio de verdade).
 */
export function calcularStatus(estado, { agoraDispositivoMs, relogioMaxMs }) {
  if (!estado?.ativado) return { status: 'nao_ativado', podeVender: false };
  const candidatos = [];

  if (estado.bloqueioImediato) {
    candidatos.push({ status: 'bloqueado', motivo: 'bloqueio_imediato', mensagem: estado.motivoBloqueio || null });
  }
  if (agoraDispositivoMs < relogioMaxMs - TOLERANCIA_RELOGIO_MS) {
    candidatos.push({ status: 'bloqueado', motivo: 'relogio_atrasado' });
  }
  const agora = Math.max(agoraDispositivoMs, relogioMaxMs);
  const diasSemContato = (agora - (estado.ultimoContatoOkMs || 0)) / DIA;
  if (diasSemContato >= LIMITE_SEM_INTERNET_DIAS) {
    candidatos.push({ status: 'bloqueado', motivo: 'sem_internet' });
  }
  if (estado.congeladaDesdeMs) {
    const dias = (agora - estado.congeladaDesdeMs) / DIA;
    candidatos.push(dias >= CARENCIA_CONGELADA_DIAS
      ? { status: 'somente_leitura', motivo: 'congelada' }
      : { status: 'aviso', motivo: 'congelada', horasRestantes: Math.max(0, Math.ceil((CARENCIA_CONGELADA_DIAS - dias) * 24)) });
  }

  const pior = candidatos.sort((a, b) => GRAVIDADE[b.status] - GRAVIDADE[a.status])[0] || { status: 'ok' };
  const resultado = { ...pior, podeVender: GRAVIDADE[pior.status] <= GRAVIDADE.aviso };
  if (diasSemContato >= AVISO_SEM_INTERNET_DIAS && diasSemContato < LIMITE_SEM_INTERNET_DIAS) {
    resultado.alertaSemInternetHoras = Math.max(1, Math.ceil((LIMITE_SEM_INTERNET_DIAS - diasSemContato) * 24));
  }
  if (estado.mensagemPersonalizada) resultado.mensagemDoPainel = estado.mensagemPersonalizada;
  return resultado;
}

function limitar(n, min, max, padrao) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : padrao;
}

/**
 * Aplica o documento da instalação vindo do servidor no estado local.
 * Função pura. `servidorMs` = horário confiável do servidor (ou null se
 * este snapshot não trouxe um); `agoraLocalMs` = relógio confiável do
 * aparelho, usado como início da carência quando não há horário do servidor.
 */
export function aplicarDadosDoServidor(estado, dados, servidorMs, agoraLocalMs = servidorMs) {
  const ativo = dados.ativo !== false;
  return {
    ...estado,
    clienteId: dados.clienteId ?? estado.clienteId ?? null,
    nomeNegocio: dados.nomeNegocio || estado.nomeNegocio,
    bloqueioImediato: dados.bloqueioImediato === true,
    motivoBloqueio: dados.motivoBloqueio || null,
    mensagemPersonalizada: dados.mensagemPersonalizada || null,
    // Primeira vez que vê "congelada" marca o início da carência; se o
    // painel reativar, zera. Igual ao desktop.
    congeladaDesdeMs: ativo ? null : (estado.congeladaDesdeMs || servidorMs || agoraLocalMs),
    backupFrequenciaHoras: limitar(dados.backupFrequenciaHoras, 1, 24, BACKUP_FREQUENCIA_PADRAO_H),
    backupRetencaoDias: limitar(dados.backupRetencaoDias, 1, BACKUP_RETENCAO_MAX_DIAS, BACKUP_RETENCAO_PADRAO_DIAS),
    ultimoContatoOkMs: servidorMs ? Math.max(estado.ultimoContatoOkMs || 0, servidorMs) : estado.ultimoContatoOkMs,
    // Modo de operação vem SEMPRE do documento (a Central é quem decide).
    // Terminal só vale com o computador indicado; sem ele, autônomo.
    ...modoDoDocumento(dados),
    migradoCorteMs: Number(dados.migradoCorteMs) || estado.migradoCorteMs || null,
    migradoParaNome: dados.migradoParaNome || estado.migradoParaNome || null,
  };
}

function modoDoDocumento(dados) {
  const terminal = dados.modoOperacao === 'terminal' && typeof dados.servidorInstallId === 'string' && dados.servidorInstallId.length > 0;
  return terminal
    ? { modoOperacao: 'terminal', servidorInstallId: dados.servidorInstallId, servidorNome: dados.servidorNome || dados.migradoParaNome || 'computador' }
    : { modoOperacao: 'autonomo', servidorInstallId: null, servidorNome: null };
}

export function normalizarCodigoAtivacao(codigo) {
  return String(codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export class ServicoLicenca {
  constructor({ db, nuvem, versaoApp, plataforma = 'android' }) {
    this.db = db;
    this.nuvem = nuvem;
    this.versaoApp = versaoApp;
    this.plataforma = plataforma;
    this.estado = null;
    this.ouvintes = new Set();
    this.ouvintesDadosServidor = new Set();
    this.timers = [];
    this.pararEscuta = null;
    this.ultimoNonce = null;
    this.online = false;
  }

  async carregar() {
    this.estado = await lerConfig(this.db, 'licenca', null);
    carregarRelogioMax(await lerConfig(this.db, 'relogio_max_ms', 0));
    if (this.estado?.installId) {
      definirContexto({
        dispositivoId: this.estado.installId,
        prefixoVenda: this.estado.prefixoVenda || 'M',
        // Já vale antes da rede: no terminal, cadastro de produto/estoque
        // fica travado desde o primeiro toque (ver services/terminal.js).
        modoTerminal: this.estado.modoOperacao === 'terminal' && !!this.estado.servidorInstallId,
        servidorNome: this.estado.modoOperacao === 'terminal' ? (this.estado.servidorNome || 'computador') : null,
      });
    }
    // A venda pergunta aqui antes de gravar (defesa extra: mesmo que uma
    // tela esqueça de checar, a regra de venda recusa).
    definirGuardaDeVenda(async () => {
      const s = this.status();
      if (!s.podeVender) throw new ErroDeNegocio(textoDoBloqueio(s), 'licenca');
    });
    return this.estado;
  }

  status() {
    return calcularStatus(this.estado, { agoraDispositivoMs: agoraDoDispositivoMs(), relogioMaxMs: relogioMax() });
  }

  aoMudar(fn) { this.ouvintes.add(fn); return () => this.ouvintes.delete(fn); }
  aoReceberDadosDoServidor(fn) { this.ouvintesDadosServidor.add(fn); return () => this.ouvintesDadosServidor.delete(fn); }
  #avisar() { const s = this.status(); for (const fn of this.ouvintes) { try { fn(s, this.estado); } catch { /* tela já desmontada */ } } }

  async #salvarEstado(novo) {
    this.estado = novo;
    await gravarConfig(this.db, 'licenca', novo);
    this.#avisar();
  }

  /** Ativação: só com internet e um código gerado na Central pro cliente. */
  async ativar({ codigo, nomeNegocio, adminNome, adminPin }) {
    if (this.estado?.ativado) throw new ErroDeNegocio('Este aparelho já está ativado.');
    const cod = normalizarCodigoAtivacao(codigo);
    if (cod.length < 8) throw new ErroDeNegocio('Digite o código de ativação completo (8 letras/números).');
    const nome = String(nomeNegocio || '').trim();
    if (!nome) throw new ErroDeNegocio('Informe o nome do negócio.');
    if (!String(adminNome || '').trim()) throw new ErroDeNegocio('Informe o nome do responsável.');
    if (!/^\d{4,8}$/.test(String(adminPin || ''))) throw new ErroDeNegocio('O PIN precisa ter de 4 a 8 números.');

    // Mesmo installId em todas as tentativas: se a ativação cair no meio
    // (código já resgatado, instalação ainda não criada), tentar de novo
    // reconhece o código como "nosso" em vez de dizer que já foi usado.
    let installId = await lerConfig(this.db, 'instalacao_pendente', null);
    if (!installId) {
      installId = novoId();
      await gravarConfig(this.db, 'instalacao_pendente', installId);
    }

    let ativacao;
    try {
      ativacao = await this.nuvem.lerAtivacao(cod);
    } catch (err) {
      throw new ErroDeNegocio('Sem conexão com o servidor. A ativação precisa de internet — confira e tente de novo.', 'sem_rede');
    }
    if (!ativacao) throw new ErroDeNegocio('Código não encontrado. Confira com quem te vendeu o sistema.', 'codigo_invalido');
    if (ativacao.usado && ativacao.usadoPorInstallId !== installId) throw new ErroDeNegocio('Esse código já foi usado em outro aparelho.', 'codigo_usado');
    if (!ativacao.usado && ativacao.expiraEmMs && ativacao.expiraEmMs < agoraMs()) throw new ErroDeNegocio('Esse código expirou. Peça um novo.', 'codigo_expirado');

    if (!ativacao.usado) await this.nuvem.resgatarAtivacao(cod, installId);

    const prefixoVenda = `M${installId.replace(/-/g, '').slice(0, 4).toUpperCase()}`;
    const servidorMs = await this.nuvem.criarInstalacao(installId, {
      tipo: TIPO_INSTALACAO,
      plataforma: this.plataforma,
      modoOperacao: 'autonomo',
      clienteId: ativacao.clienteId || null,
      nomeNegocio: nome,
      ativo: true,
      bloqueioImediato: false,
      versaoApp: this.versaoApp,
      prefixoVenda,
      backupFrequenciaHoras: BACKUP_FREQUENCIA_PADRAO_H,
      backupRetencaoDias: BACKUP_RETENCAO_PADRAO_DIAS,
      ativadoComCodigo: cod,
    });

    definirContexto({ dispositivoId: installId, prefixoVenda });
    if (servidorMs) sincronizarRelogioComServidor(servidorMs);
    await this.db.transacao(async (tx) => {
      const adminId = await criarUsuario(tx, { nome: adminNome, papel: 'admin', pin: adminPin });
      await gravarConfig(tx, 'licenca', {
        ativado: true, installId, prefixoVenda, clienteId: ativacao.clienteId || null, nomeNegocio: nome,
        ultimoContatoOkMs: servidorMs || agoraMs(), congeladaDesdeMs: null, bloqueioImediato: false,
        motivoBloqueio: null, mensagemPersonalizada: null,
        backupFrequenciaHoras: BACKUP_FREQUENCIA_PADRAO_H, backupRetencaoDias: BACKUP_RETENCAO_PADRAO_DIAS,
        ativadoEmMs: servidorMs || agoraMs(),
      });
      await gravarConfig(tx, 'relogio_max_ms', relogioMax());
      await tx.run(`DELETE FROM config WHERE chave = 'instalacao_pendente'`);
      await auditar(tx, 'aparelho_ativado', { installId, clienteId: ativacao.clienteId || null }, adminId);
    });
    this.estado = await lerConfig(this.db, 'licenca');
    this.iniciarSincronizacao();
    this.#avisar();
    return this.estado;
  }

  /** Liga escuta em tempo real, ping de presença e reconciliação periódica. Idempotente. */
  iniciarSincronizacao() {
    if (!this.estado?.ativado || this.pararEscuta) return;
    const id = this.estado.installId;
    this.pararEscuta = this.nuvem.escutarInstalacao(id, (snap) => this.#aoReceber(snap));
    const ping = () => this.ping().catch(() => {});
    ping();
    this.timers.push(setInterval(ping, INTERVALO_PING_MS));
    this.timers.push(setInterval(() => this.verificar().catch(() => {}), INTERVALO_VERIFICACAO_MS));
    // Grava o relógio máximo de tempos em tempos (se o app for morto, o
    // próximo início ainda lembra o horário mais alto já visto).
    this.timers.push(setInterval(() => { agoraMs(); gravarConfig(this.db, 'relogio_max_ms', relogioMax()).catch(() => {}); this.#avisar(); }, 60000));
    this.verificar().catch(() => {});
  }

  pararSincronizacao() {
    if (this.pararEscuta) { this.pararEscuta(); this.pararEscuta = null; }
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  async ping() {
    if (!this.estado?.ativado) return;
    const nonce = novoId();
    this.ultimoNonce = nonce;
    await this.nuvem.ping(this.estado.installId, { ultimoPingNonce: nonce, versaoApp: this.versaoApp });
    this.online = true;
  }

  /** Reconciliação: lê do servidor, recria o documento se tiver sumido (preservando bloqueio/congelamento), manda métricas. */
  async verificar() {
    if (!this.estado?.ativado) return;
    const id = this.estado.installId;
    const doc = await this.nuvem.lerInstalacao(id);
    if (!doc) {
      // Documento sumiu (apagado direto no Firestore). Diferente do
      // desktop antigo, NÃO volta "ativo e desbloqueado": recria com o
      // estado que o aparelho já conhecia.
      await this.nuvem.criarInstalacao(id, {
        tipo: TIPO_INSTALACAO, plataforma: this.plataforma,
        modoOperacao: this.estado.modoOperacao === 'terminal' ? 'terminal' : 'autonomo',
        servidorInstallId: this.estado.servidorInstallId || null, servidorNome: this.estado.servidorNome || null,
        clienteId: this.estado.clienteId, nomeNegocio: this.estado.nomeNegocio,
        ativo: !this.estado.congeladaDesdeMs, bloqueioImediato: !!this.estado.bloqueioImediato,
        motivoBloqueio: this.estado.motivoBloqueio || null, versaoApp: this.versaoApp, prefixoVenda: this.estado.prefixoVenda,
        backupFrequenciaHoras: this.estado.backupFrequenciaHoras, backupRetencaoDias: this.estado.backupRetencaoDias,
        recriadoPeloAparelho: true,
      });
    }
    const metricas = await this.#metricas();
    await this.nuvem.atualizarInstalacao(id, { ...metricas, versaoApp: this.versaoApp, ultimoContato: AGORA_SERVIDOR });
  }

  async #metricas() {
    const total = await this.db.valor(`SELECT COUNT(*) FROM vendas WHERE status = 'finalizada'`);
    const desde = new Date(agoraMs() - 30 * DIA).toISOString();
    const ult30 = await this.db.valor(`SELECT COUNT(*) FROM vendas WHERE status = 'finalizada' AND criado_em >= ?`, [desde]);
    return { totalVendasHistorico: total || 0, vendasUltimos30Dias: ult30 || 0, perfilAtivo: 'pdv_mobile' };
  }

  async #aoReceber({ dados, pendente, doCache }) {
    if (!dados || pendente || doCache) return;
    let servidorMs = null;
    // Só confia no horário quando é a confirmação do NOSSO último ping
    // (mesmo nonce): aí `ultimoPing` é a hora do servidor de agora há pouco.
    if (dados.ultimoPingNonce && dados.ultimoPingNonce === this.ultimoNonce && dados.ultimoPingMs) {
      servidorMs = dados.ultimoPingMs;
      sincronizarRelogioComServidor(servidorMs);
      await gravarConfig(this.db, 'relogio_max_ms', relogioMax());
    }
    const novo = aplicarDadosDoServidor(this.estado, dados, servidorMs, agoraMs());
    await this.#salvarEstado(novo);
    for (const fn of this.ouvintesDadosServidor) {
      try { await fn(dados); } catch (err) { console.error('[licenca] ouvinte de dados falhou', err); }
    }
  }
}

export function textoDoBloqueio(s) {
  switch (s.motivo) {
    case 'bloqueio_imediato': return s.mensagem || 'Este aparelho foi bloqueado. Entre em contato com o suporte.';
    case 'sem_internet': return `Conecte o celular à internet. Ele fica até ${LIMITE_SEM_INTERNET_DIAS} dias sem conexão e esse prazo acabou.`;
    case 'relogio_atrasado': return 'A data/hora do celular voltou para trás. Acerte o relógio (data e hora automáticas) e conecte à internet para validar.';
    case 'congelada': return s.status === 'aviso'
      ? `Licença congelada. Você ainda pode vender por ${s.horasRestantes} h — regularize com o suporte.`
      : 'Licença congelada: o app está só para consulta. Regularize com o suporte para voltar a vender.';
    default: return 'Não é possível vender agora.';
  }
}
