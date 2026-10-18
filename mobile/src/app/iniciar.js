// Liga tudo na ordem certa: banco -> migrações -> licença -> backup -> terminal.
import { Banco } from '../db/banco.js';
import { migrar } from '../db/schema.js';
import { ServicoLicenca } from '../services/licenca.js';
import { ServicoBackup } from '../services/backup.js';
import { ServicoTerminal } from '../services/terminal.js';
import { abrirDriver, ehNativo, aoVoltarProApp, aoMudarRede } from './plataforma.js';
import { gravarConfig, relogioMax } from '../services/base.js';

export const VERSAO_APP = __VERSAO_APP__;

export async function iniciarServicos() {
  const { driver, persistir } = await abrirDriver();
  const db = new Banco(driver);
  if (persistir) db.aoAlterar = persistir;
  await db.exec('PRAGMA foreign_keys = ON');
  await migrar(db);

  // No celular, sempre a nuvem de verdade. No navegador, a simulada (nada
  // sai do aparelho) -- a não ser que a URL peça `?nuvem=real` (teste
  // contra o Firebase de verdade a partir do navegador).
  const usarNuvemReal = ehNativo() || new URLSearchParams(location.search).get('nuvem') === 'real';
  const nuvem = usarNuvemReal
    ? (await import('../services/nuvem.js')).criarNuvemFirebase()
    : (await import('../services/nuvemDemo.js')).criarNuvemDemo();

  const licenca = new ServicoLicenca({ db, nuvem, versaoApp: VERSAO_APP, plataforma: ehNativo() ? 'android' : 'web' });
  await licenca.carregar();
  const backup = new ServicoBackup({ db, nuvem, licenca, aoRestaurar: () => location.reload() });
  // Terminal de um computador (decidido na Central): liga/desliga sozinho
  // conforme a licença muda.
  const terminal = new ServicoTerminal({ db, nuvem, licenca });

  const ligarSincronizacao = () => {
    licenca.iniciarSincronizacao();
    backup.iniciar();
    terminal.iniciar().catch((err) => console.error('[terminal] não iniciou', err));
  };
  if (licenca.estado?.ativado) ligarSincronizacao();

  await aoVoltarProApp(() => {
    if (!licenca.estado?.ativado) return;
    licenca.ping().catch(() => {});
    licenca.verificar().catch(() => {});
    backup.verificarAgendado().catch(() => {});
    if (terminal.ativo) terminal.enviarPendentes().catch(() => {});
  });
  // Indo pro segundo plano: grava o maior horário já visto (o Android pode
  // matar o app lá atrás sem aviso, e a proteção do relógio depende disso).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && licenca.estado?.ativado) gravarConfig(db, 'relogio_max_ms', relogioMax()).catch(() => {});
  });
  await aoMudarRede((conectado) => {
    licenca.online = conectado;
    if (conectado && licenca.estado?.ativado) {
      licenca.ping().catch(() => {});
      backup.verificarAgendado().catch(() => {});
      terminal.enviarPendentes().catch(() => {});
    }
  });

  const servicos = { db, nuvem, licenca, backup, terminal, ligarSincronizacao, demo: !!nuvem.demo };
  // Só na demonstração do navegador: deixa simular ações da Central pelo
  // console (ex.: __pdvDemo.nuvem.simularPainel(id, { ativo: false })).
  if (servicos.demo) window.__pdvDemo = servicos;
  return servicos;
}
