// Nuvem SIMULADA, só pro modo navegador (demonstração/preview): nada sai
// do aparelho. Código de ativação de demonstração: DEMO2026.
import { AGORA_SERVIDOR } from './base.js';
import { criarTerminalEmMemoria } from './terminalMemoria.js';

export function criarNuvemDemo() {
  const instalacoes = new Map();
  const backups = new Map();
  const arquivos = new Map();
  const ouvintes = new Map();
  const ativacoes = new Map([['DEMO2026', { clienteId: 'cliente-demo', usado: false, expiraEmMs: Date.now() + 365 * 86400000 }]]);
  const conv = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === AGORA_SERVIDOR ? Date.now() : v]));
  const notificar = (id) => {
    const dados = instalacoes.get(id);
    for (const cb of ouvintes.get(id) || []) setTimeout(() => cb({ dados: dados ? { ...dados, ultimoPingMs: dados.ultimoPing } : null, pendente: false, doCache: false }), 0);
  };
  const demora = () => new Promise((r) => setTimeout(r, 250));
  const terminal = criarTerminalEmMemoria({ adiar: (fn) => setTimeout(fn, 0) });
  const nuvem = {
    ...terminal.metodos,
    /** Só demonstração: o "computador" ao qual o celular é terminal (publicarCatalogo, confirmarTodos...). */
    computador: terminal.computador,
    demo: true,
    async lerAtivacao(c) { await demora(); return ativacoes.get(c) ? { ...ativacoes.get(c) } : null; },
    async resgatarAtivacao(c, installId) { ativacoes.set(c, { ...ativacoes.get(c), usado: true, usadoPorInstallId: installId }); },
    async criarInstalacao(id, dados) {
      await demora();
      const t = Date.now();
      instalacoes.set(id, { ...instalacoes.get(id), ...conv(dados), criadoEm: t, ultimoContato: t, ultimoPing: t });
      notificar(id);
      return t;
    },
    async lerInstalacao(id) {
      // Em demonstração o "servidor" não lembra entre recargas -- recria.
      if (!instalacoes.has(id)) return { ativo: true, bloqueioImediato: false };
      return { ...instalacoes.get(id) };
    },
    async atualizarInstalacao(id, campos) { instalacoes.set(id, { ...instalacoes.get(id), ...conv(campos) }); notificar(id); },
    async ping(id, extras) { instalacoes.set(id, { ...instalacoes.get(id), ...conv(extras), ultimoPing: Date.now() }); notificar(id); },
    escutarInstalacao(id, cb) {
      if (!ouvintes.has(id)) ouvintes.set(id, new Set());
      ouvintes.get(id).add(cb);
      return () => ouvintes.get(id).delete(cb);
    },
    async enviarArquivo(caminho, bytes) { await demora(); arquivos.set(caminho, bytes); },
    async baixarArquivo(caminho) { return arquivos.get(caminho); },
    async registrarBackup(id, nome, meta) { if (!backups.has(id)) backups.set(id, new Map()); backups.get(id).set(nome, conv(meta)); },
    async listarBackups(id) { return [...(backups.get(id) || new Map()).values()].map((b) => ({ id: b.nomeArquivo, ...b })); },
    async apagarBackup(id, b) { arquivos.delete(b.caminhoStorage); backups.get(id)?.delete(b.nomeArquivo); },
    /** Só demonstração: simula ações da Central. */
    simularPainel(id, campos) { instalacoes.set(id, { ...instalacoes.get(id), ...campos }); notificar(id); },
  };
  return nuvem;
}
