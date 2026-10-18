import { AGORA_SERVIDOR } from '../src/services/base.js';
import { criarTerminalEmMemoria } from '../src/services/terminalMemoria.js';

/** Nuvem em memória com o mesmo contrato de src/services/nuvem.js. `relogioServidor` controla a "hora do servidor". */
export function nuvemFalsa({ relogioServidor = () => Date.now() } = {}) {
  const instalacoes = new Map();
  const backups = new Map(); // installId -> Map(nome -> meta)
  const arquivos = new Map();
  const ativacoes = new Map();
  const ouvintes = new Map();
  let offline = false;
  const chamadas = [];

  const conv = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === AGORA_SERVIDOR ? relogioServidor() : v]));
  const checarRede = () => { if (offline) throw new Error('Sem resposta do servidor (sem internet?)'); };
  const notificar = (id) => {
    const dados = instalacoes.get(id);
    for (const cb of ouvintes.get(id) || []) cb({ dados: dados ? { ...dados, ultimoPingMs: dados.ultimoPing ?? null } : null, pendente: false, doCache: false });
  };

  const terminal = criarTerminalEmMemoria({ checarRede: () => checarRede() });

  return {
    ...terminal.metodos,
    // controle do teste
    computador: terminal.computador,
    instalacoes, backups, arquivos, ativacoes, chamadas,
    ficarOffline(v = true) { offline = v; },
    painelAltera(id, campos) { instalacoes.set(id, { ...instalacoes.get(id), ...campos }); notificar(id); },
    falharUpload: false,

    async lerAtivacao(codigo) { checarRede(); const a = ativacoes.get(codigo); return a ? { ...a } : null; },
    async resgatarAtivacao(codigo, installId) {
      checarRede();
      const a = ativacoes.get(codigo);
      if (!a || a.usado) throw new Error('permission-denied');
      ativacoes.set(codigo, { ...a, usado: true, usadoPorInstallId: installId });
    },
    async criarInstalacao(id, dados) {
      checarRede();
      const t = relogioServidor();
      instalacoes.set(id, { ...instalacoes.get(id), ...conv(dados), criadoEm: t, ultimoContato: t, ultimoPing: t });
      notificar(id);
      return t;
    },
    async lerInstalacao(id) { checarRede(); return instalacoes.get(id) ? { ...instalacoes.get(id) } : null; },
    async atualizarInstalacao(id, campos) { checarRede(); instalacoes.set(id, { ...instalacoes.get(id), ...conv(campos) }); notificar(id); },
    async ping(id, extras) { checarRede(); instalacoes.set(id, { ...instalacoes.get(id), ...conv(extras), ultimoPing: relogioServidor() }); notificar(id); },
    escutarInstalacao(id, cb) {
      if (!ouvintes.has(id)) ouvintes.set(id, new Set());
      ouvintes.get(id).add(cb);
      return () => ouvintes.get(id).delete(cb);
    },
    async enviarArquivo(caminho, bytes) {
      checarRede();
      if (this.falharUpload) throw new Error('upload falhou');
      arquivos.set(caminho, bytes); chamadas.push(['upload', caminho]);
    },
    async baixarArquivo(caminho) { checarRede(); if (!arquivos.has(caminho)) throw new Error('storage/object-not-found'); return arquivos.get(caminho); },
    async registrarBackup(id, nome, meta) {
      checarRede();
      if (!backups.has(id)) backups.set(id, new Map());
      backups.get(id).set(nome, conv(meta));
    },
    async listarBackups(id) {
      checarRede();
      return [...(backups.get(id) || new Map()).values()].map((b) => ({ id: b.nomeArquivo, ...b })).sort((a, b) => b.criadoEmMs - a.criadoEmMs);
    },
    async apagarBackup(id, b) { checarRede(); arquivos.delete(b.caminhoStorage); backups.get(id)?.delete(b.nomeArquivo); chamadas.push(['apagar', b.nomeArquivo]); },
  };
}
