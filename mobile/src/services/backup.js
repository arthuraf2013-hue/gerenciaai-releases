// Backup automático na nuvem do PDV mobile autônomo.
//
// Usa a MESMA infraestrutura do backup do computador (backupService.js):
// arquivo no Storage em `backups/{installId}/{arquivo}` + registro em
// `installations/{installId}/backups/{arquivo}`. Por isso a aba Backups
// da Central já lista, pede backup agora (`backupSolicitadoEm`) e manda
// restaurar (`restaurarBackupSolicitado`) um celular igual faz com um
// computador.
//
// Formato: JSON lógico (tabela -> colunas + linhas) compactado em gzip --
// não o arquivo .db cru. Motivos: (1) o plugin nativo não expõe o
// arquivo de forma portável; (2) restaurar por nome de coluna aguenta
// backup de uma versão anterior do app (coluna nova ganha o padrão); (3)
// é o formato que a futura importação no GerenciaAI do computador vai ler
// (ver FORMATO/VERSAO_FORMATO -- mudança incompatível = versão nova).
//
// Frequência e retenção vêm da Central (backupFrequenciaHoras,
// backupRetencaoDias), aplicadas pela licença no estado local.
import { TABELAS_EM_ORDEM, VERSAO_SCHEMA } from '../db/schema.js';
import { agoraMs, lerConfig, gravarConfig, ErroDeNegocio, AGORA_SERVIDOR } from './base.js';

export const FORMATO = 'gerenciaai-pdv-mobile-backup';
export const VERSAO_FORMATO = 1;
const HORA = 3600000;
const DIA = 24 * HORA;
export const HORAS_COM_TODOS_OS_BACKUPS = 48;
const ESPERA_APOS_FALHA_MS = 10 * 60 * 1000;
const INTERVALO_AGENDADOR_MS = 5 * 60 * 1000;

// Config que é DO APARELHO e nunca vem de um backup (restaurar não pode
// trocar a identidade/licença do celular nem o estado do próprio backup).
const CONFIG_LOCAL = new Set([
  'licenca', 'relogio_max_ms', 'instalacao_pendente', 'backup_estado',
  // modo terminal (services/terminal.js): é a relação DESTE aparelho com o computador
  'terminal_catalogo', 'terminal_backlog_feito', 'terminal_desde_ms', 'terminal_ultimo_envio_ms', 'terminal_saiu_em_ms',
]);

export async function gerarDump(db, { installId }) {
  // Numa transação só: com a fila única do Banco, nenhuma venda entra no
  // meio da leitura -- o arquivo é um retrato coerente (estoque do
  // produto e vendas do mesmo instante). O horário é o do retrato: tudo
  // com data até ele está no arquivo (a migração pro computador e o modo
  // terminal usam isso como corte).
  return db.transacao(async (tx) => {
    const geradoEmMs = agoraMs();
    const tabelas = {};
    for (const nome of TABELAS_EM_ORDEM) {
      const colunas = (await tx.all(`PRAGMA table_info(${nome})`)).map((c) => c.name);
      const filtro = nome === 'config' ? `WHERE chave NOT IN (${[...CONFIG_LOCAL].map(() => '?').join(', ')})` : '';
      const linhas = await tx.all(`SELECT ${colunas.join(', ')} FROM ${nome} ${filtro} ORDER BY rowid`, nome === 'config' ? [...CONFIG_LOCAL] : []);
      tabelas[nome] = { colunas, linhas: linhas.map((l) => colunas.map((c) => l[c])) };
    }
    return { formato: FORMATO, versaoFormato: VERSAO_FORMATO, versaoSchema: VERSAO_SCHEMA, installId, geradoEmMs, tabelas };
  });
}

export async function hashDosDados(dump) {
  const bytes = new TextEncoder().encode(JSON.stringify(dump.tabelas));
  const h = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function processarStream(bytes, stream) {
  const resposta = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await resposta.arrayBuffer());
}
export function compactar(texto) {
  return processarStream(new TextEncoder().encode(texto), new CompressionStream('gzip'));
}
export async function descompactar(bytes) {
  return new TextDecoder().decode(await processarStream(bytes, new DecompressionStream('gzip')));
}

/**
 * Substitui TODOS os dados pelos do backup, numa transação (ou entra
 * inteiro, ou nada muda). Restaura por nome de coluna: coluna que não
 * existe mais é ignorada, coluna nova fica com o padrão do schema.
 * A numeração de venda nunca anda pra trás (fica o maior dos dois), pra
 * um número já usado não ser reaproveitado.
 */
export async function restaurarDump(banco, dump) {
  if (!dump || dump.formato !== FORMATO) throw new ErroDeNegocio('Esse arquivo não é um backup do PDV mobile.', 'formato_invalido');
  if (dump.versaoFormato > VERSAO_FORMATO || dump.versaoSchema > VERSAO_SCHEMA) {
    throw new ErroDeNegocio('Esse backup é de uma versão mais nova do app. Atualize o app antes de restaurar.', 'backup_mais_novo');
  }
  await banco.exclusivo(async (tx) => {
    const seqAtual = Number(await lerConfig(tx, 'seq_venda', 0));
    await tx.exec('PRAGMA foreign_keys = OFF');
    await tx.exec('BEGIN IMMEDIATE');
    try {
      for (const nome of [...TABELAS_EM_ORDEM].reverse()) {
        if (nome === 'config') {
          await tx.run(`DELETE FROM config WHERE chave NOT IN (${[...CONFIG_LOCAL].map(() => '?').join(', ')})`, [...CONFIG_LOCAL]);
        } else {
          await tx.run(`DELETE FROM ${nome}`);
        }
      }
      for (const nome of TABELAS_EM_ORDEM) {
        const t = dump.tabelas?.[nome];
        if (!t) continue;
        const existentes = new Set((await tx.all(`PRAGMA table_info(${nome})`)).map((c) => c.name));
        const idx = t.colunas.map((c, i) => (existentes.has(c) ? i : -1)).filter((i) => i >= 0);
        if (idx.length === 0) continue;
        const cols = idx.map((i) => t.colunas[i]);
        const sql = `INSERT INTO ${nome} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
        for (const linha of t.linhas) {
          if (nome === 'config' && CONFIG_LOCAL.has(linha[t.colunas.indexOf('chave')])) continue;
          await tx.run(sql, idx.map((i) => linha[i]));
        }
      }
      const seqBackup = Number(await lerConfig(tx, 'seq_venda', 0));
      await gravarConfig(tx, 'seq_venda', Math.max(seqAtual, seqBackup));
      // Terminal: o backup trouxe produtos/estoque "de quando foi feito";
      // esquecer a versão do catálogo faz o do computador ser aplicado de
      // novo assim que o app reabrir.
      await tx.run(`DELETE FROM config WHERE chave = 'terminal_catalogo'`);
      const violacoes = await tx.all('PRAGMA foreign_key_check');
      if (violacoes.length) throw new ErroDeNegocio(`Backup inconsistente (${violacoes.length} referência(s) quebrada(s)). Nada foi alterado.`, 'backup_inconsistente');
      await tx.exec('COMMIT');
    } catch (err) {
      try { await tx.exec('ROLLBACK'); } catch { /* já sem transação */ }
      throw err;
    } finally {
      await tx.exec('PRAGMA foreign_keys = ON');
    }
  });
}

function diaLocal(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Retenção escalonada. Mantém: tudo das últimas 48 h; depois disso, o
 * mais recente de cada dia até `retencaoDias`; apaga o resto. O backup
 * mais recente de todos nunca é apagado (mesmo se um aparelho ficou sem
 * fazer backup por mais tempo que a retenção). Função pura.
 */
export function selecionarParaApagar(lista, { agoraMs: agora, retencaoDias }) {
  const ordenada = [...lista].filter((b) => Number.isFinite(b.criadoEmMs)).sort((a, b) => b.criadoEmMs - a.criadoEmMs);
  const janelaCompleta = Math.min(HORAS_COM_TODOS_OS_BACKUPS * HORA, retencaoDias * DIA);
  const diasJaGuardados = new Set();
  const apagar = [];
  ordenada.forEach((b, i) => {
    const idade = agora - b.criadoEmMs;
    if (i === 0) { diasJaGuardados.add(diaLocal(b.criadoEmMs)); return; }
    if (idade > retencaoDias * DIA) { apagar.push(b); return; }
    if (idade <= janelaCompleta) { diasJaGuardados.add(diaLocal(b.criadoEmMs)); return; }
    const dia = diaLocal(b.criadoEmMs);
    if (diasJaGuardados.has(dia)) apagar.push(b);
    else diasJaGuardados.add(dia);
  });
  return apagar;
}

function carimbo(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export class ServicoBackup {
  constructor({ db, nuvem, licenca, aoRestaurar = () => {} }) {
    this.db = db;
    this.nuvem = nuvem;
    this.licenca = licenca;
    this.aoRestaurar = aoRestaurar;
    this.rodando = null;
    this.timer = null;
    this.ouvintes = new Set();
  }

  aoMudar(fn) { this.ouvintes.add(fn); return () => this.ouvintes.delete(fn); }

  async estado() {
    return (await lerConfig(this.db, 'backup_estado', null)) || {};
  }

  async #gravarEstado(parcial) {
    const novo = { ...(await this.estado()), ...parcial };
    await gravarConfig(this.db, 'backup_estado', novo);
    for (const fn of this.ouvintes) { try { fn(novo); } catch { /* ignore */ } }
    return novo;
  }

  iniciar() {
    if (this.timer) return;
    this.licenca.aoReceberDadosDoServidor((dados) => this.processarDadosDoServidor(dados));
    this.timer = setInterval(() => this.verificarAgendado().catch(() => {}), INTERVALO_AGENDADOR_MS);
    this.verificarAgendado().catch(() => {});
  }

  parar() { clearInterval(this.timer); this.timer = null; }

  /** Chamado pelo agendador, ao voltar pro app e quando a internet volta. */
  async verificarAgendado() {
    const lic = this.licenca.estado;
    if (!lic?.ativado) return;
    const e = await this.estado();
    const agora = agoraMs();
    if (e.ultimaFalhaMs && agora - e.ultimaFalhaMs < ESPERA_APOS_FALHA_MS) return;
    const freqMs = (lic.backupFrequenciaHoras || 1) * HORA;
    const base = Math.max(e.ultimoEnvioMs || 0, e.ultimaVerificacaoMs || 0);
    if (agora - base >= freqMs - 60000) await this.fazerBackup({ motivo: 'agendado' });
  }

  /** Um backup por vez; quem chamar durante um backup espera o mesmo terminar. */
  fazerBackup(opcoes = {}) {
    if (!this.rodando) {
      this.rodando = this.#fazer(opcoes).finally(() => { this.rodando = null; });
    }
    return this.rodando;
  }

  async #fazer({ forcar = false, motivo = 'agendado' }) {
    const lic = this.licenca.estado;
    if (!lic?.ativado) throw new ErroDeNegocio('Aparelho não ativado.');
    const installId = lic.installId;
    const agora = agoraMs();
    try {
      const dump = await gerarDump(this.db, { installId });
      const hash = await hashDosDados(dump);
      const e = await this.estado();
      if (!forcar && hash === e.ultimoHash) {
        await this.#gravarEstado({ ultimaVerificacaoMs: agora, ultimaFalhaMs: null, ultimoErro: null });
        return { enviado: false, motivo: 'sem_alteracoes' };
      }
      const bytes = await compactar(JSON.stringify(dump));
      const sufixo = motivo === 'pre_restauracao' ? '-antes-de-restaurar' : motivo === 'solicitado' ? '-pedido' : '';
      const nomeArquivo = `mobile-${carimbo(agora)}${sufixo}.json.gz`;
      const caminhoStorage = `backups/${installId}/${nomeArquivo}`;
      await this.nuvem.enviarArquivo(caminhoStorage, bytes);
      await this.nuvem.registrarBackup(installId, nomeArquivo, {
        nomeArquivo, caminhoStorage, tamanhoBytes: bytes.length, criadoEm: AGORA_SERVIDOR, criadoEmMs: agora,
        formato: 'mobile-json-gz', versaoFormato: VERSAO_FORMATO, versaoSchema: VERSAO_SCHEMA, motivo,
      });
      await this.#gravarEstado({
        ultimoEnvioMs: agora, ultimaVerificacaoMs: agora, ultimoHash: hash, ultimoArquivo: nomeArquivo,
        ultimoTamanhoBytes: bytes.length, ultimaFalhaMs: null, ultimoErro: null,
      });
      this.nuvem.atualizarInstalacao(installId, {
        ultimoBackupNuvemEm: AGORA_SERVIDOR, ultimoBackupNuvemOk: true, ultimoBackupTamanhoBytes: bytes.length,
      }).catch(() => {});
      await this.#aplicarRetencao(installId).catch((err) => console.warn('[backup] retenção falhou (tenta de novo no próximo)', err));
      return { enviado: true, nomeArquivo, tamanhoBytes: bytes.length };
    } catch (err) {
      await this.#gravarEstado({ ultimaFalhaMs: agora, ultimoErro: String(err?.message || err) });
      this.nuvem.atualizarInstalacao(installId, { ultimoBackupNuvemOk: false, ultimoBackupNuvemErro: String(err?.message || err).slice(0, 300) }).catch(() => {});
      throw err;
    }
  }

  async #aplicarRetencao(installId) {
    const lista = await this.nuvem.listarBackups(installId);
    const apagar = selecionarParaApagar(lista, { agoraMs: agoraMs(), retencaoDias: this.licenca.estado.backupRetencaoDias || 30 });
    for (const b of apagar) await this.nuvem.apagarBackup(installId, b);
  }

  async processarDadosDoServidor(dados) {
    const e = await this.estado();
    // "Fazer backup agora" pedido na Central (mesmo campo do computador).
    if (typeof dados.backupSolicitadoEm === 'number' && dados.backupSolicitadoEm > (e.ultimaSolicitacaoMs || 0)) {
      await this.#gravarEstado({ ultimaSolicitacaoMs: dados.backupSolicitadoEm });
      await this.fazerBackup({ forcar: true, motivo: 'solicitado' }).catch(() => {});
    }
    const pedido = dados.restaurarBackupSolicitado;
    if (pedido?.caminhoStorage && pedido?.nomeArquivo) {
      const marcador = `${pedido.nomeArquivo}@${pedido.solicitadoEmMs || ''}`;
      if (e.ultimaRestauracao === marcador) return;
      await this.#gravarEstado({ ultimaRestauracao: marcador });
      await this.restaurarDaNuvem(pedido);
    }
  }

  /** Restaura um backup da nuvem. Antes, SEMPRE salva o estado atual (se não conseguir, não restaura -- nunca perde o que tem agora). */
  async restaurarDaNuvem({ caminhoStorage, nomeArquivo }) {
    const installId = this.licenca.estado.installId;
    try {
      try {
        await this.fazerBackup({ forcar: true, motivo: 'pre_restauracao' });
      } catch (err) {
        throw new Error(`não consegui salvar os dados atuais antes de restaurar (${err?.message || err}) -- restauração cancelada, nada foi alterado`);
      }
      const bytes = await this.nuvem.baixarArquivo(caminhoStorage);
      const dump = JSON.parse(await descompactar(bytes));
      await restaurarDump(this.db, dump);
      // Hash zerado: o próximo agendado sobe o estado restaurado.
      await this.#gravarEstado({ ultimoHash: null });
      await this.nuvem.atualizarInstalacao(installId, { restauracaoStatus: 'concluida', restauracaoArquivo: nomeArquivo, restauracaoConcluidaEm: AGORA_SERVIDOR });
      this.aoRestaurar();
    } catch (err) {
      await this.nuvem.atualizarInstalacao(installId, {
        restauracaoStatus: 'falhou', restauracaoErro: String(err?.message || err).slice(0, 300), restauracaoConcluidaEm: AGORA_SERVIDOR,
      }).catch(() => {});
      throw err;
    }
  }
}
