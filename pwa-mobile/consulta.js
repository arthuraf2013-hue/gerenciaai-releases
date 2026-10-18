import { auth, db, firestoreFns } from './firebase-config.js';
import { icon } from './icons.js';
import * as painelLoja from './painel-loja.js';

const ROTULO_PAPEL = {
  operador: 'Operador de caixa', gerente: 'Gerente', admin: 'Administrador',
  garcom: 'Garçom', suporte: 'Suporte',
};

const ROTULO_TIPO_DISPOSITIVO = { garcom: 'Garçom', consulta: 'Consulta remota', pdv: 'PDV móvel' };

function formatarRelativo(ms) {
  if (!ms) return '';
  const segundos = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (segundos < 60) return `há ${segundos}s`;
  const minutos = Math.floor(segundos / 60);
  if (minutos < 60) return `há ${minutos} min`;
  return `há ${Math.floor(minutos / 60)} h`;
}

/** Tela de consulta remota (Adm/Gerente). O painel da loja em si (resumo
 * do dia, por terminal do grupo, histórico hoje/7/30 dias com gráficos,
 * mesas e pedidos) é o componente compartilhado `painel-loja.js` -- o
 * MESMO que o PDV móvel mostra na aba "Painel" quando a loja libera.
 * Aqui ficam só as seções exclusivas da gestão: usuários e dispositivos
 * pareados (gestao_usuarios exige dispositivo tipo 'consulta' nas regras). */
function mount(root, { loja, lojas, onTrocarLoja, onParearOutra, onEsquecerLoja }) {
  let ultimaAtualizacaoMs = null;
  let usuarios = []; // [{id, nome, role, ativo}] -- installations/{id}/gestao_usuarios/atual
  let dispositivos = []; // [{id (uid), tipo, nomeDispositivo, ativo, vinculoUserId}] -- installations/{id}/dispositivos

  root.innerHTML = `
    <div class="app-shell">
      <header class="topo">
        <div>
          <div class="nome-loja">${escapeHtml(loja.nomeNegocio)}</div>
          <div class="subtexto">${escapeHtml(loja.vinculoNome)} · <span id="tempo-atualizacao">--</span></div>
        </div>
        <button id="btn-menu-topo" class="btn-icone" aria-label="Menu">${icon('menu')}</button>
      </header>
      <div id="menu-topo" class="menu-suspenso" hidden></div>
      <div id="conteudo-consulta">
        <div id="painel-loja"></div>
        <div id="gestao-extra"></div>
      </div>
    </div>
  `;

  montarMenuTopo();

  const desmontarPainel = painelLoja.mount(root.querySelector('#painel-loja'), {
    loja,
    aoAtualizar: (ms) => { ultimaAtualizacaoMs = ms; atualizarTempoRelativo(); },
  });

  function montarMenuTopo() {
    const btnMenu = root.querySelector('#btn-menu-topo');
    const menu = root.querySelector('#menu-topo');
    let itensTroca = '';
    if (lojas.length > 1) {
      itensTroca = lojas
        .filter((l) => l.installId !== loja.installId)
        .map((l) => `<button class="item-menu" data-trocar="${escapeHtml(l.installId)}">Trocar pra ${escapeHtml(l.nomeNegocio)}</button>`)
        .join('');
    }
    menu.innerHTML = `
      ${itensTroca}
      <button class="item-menu" id="btn-renomear-dispositivo">Renomear este celular</button>
      <button class="item-menu" id="btn-parear-outra">Parear outra loja</button>
      <button class="item-menu item-menu-perigo" id="btn-esquecer">Esquecer esta loja neste celular</button>
    `;
    btnMenu.addEventListener('click', () => { menu.hidden = !menu.hidden; });
    menu.querySelectorAll('[data-trocar]').forEach((b) => b.addEventListener('click', () => onTrocarLoja(b.dataset.trocar)));
    menu.querySelector('#btn-renomear-dispositivo').addEventListener('click', renomearDispositivo);
    menu.querySelector('#btn-parear-outra').addEventListener('click', onParearOutra);
    menu.querySelector('#btn-esquecer').addEventListener('click', () => {
      if (confirm('Isso só remove essa loja da lista deste celular -- não afeta o acesso no servidor. Continuar?')) onEsquecerLoja();
    });
  }

  /** Ver comentário equivalente em garcom.js -- mesmo padrão, mesma
   * regra do Firestore (o próprio celular só pode alterar
   * ultimoAcesso/nomeDispositivo no seu doc de dispositivo). */
  async function renomearDispositivo() {
    const sugestao = `${loja.vinculoNome || 'Celular'} — ${navigator.platform || 'celular'}`;
    const novoNome = prompt('Nome deste celular (aparece pro gerente em Configurações → Celular):', sugestao);
    if (novoNome === null) return;
    const nome = novoNome.trim();
    if (!nome) return;
    try {
      await firestoreFns.updateDoc(
        firestoreFns.doc(db, 'installations', loja.installId, 'dispositivos', auth.currentUser.uid),
        { nomeDispositivo: nome }
      );
    } catch (err) {
      console.error('[consulta] falha ao renomear dispositivo', err);
      alert('Não foi possível salvar agora. Confira sua internet e tente de novo.');
    }
  }

  function renderGestao() {
    const div = root.querySelector('#gestao-extra');
    div.innerHTML = `
      <h2 class="titulo-secao">Usuários (${usuarios.length})</h2>
      <div class="lista-pedidos-andamento">
        ${usuarios.length === 0 ? '<p class="estado-vazio">Nenhum usuário cadastrado.</p>' : usuarios.map((u) => `
          <div class="cartao-pedido">
            <div>
              <div>${escapeHtml(u.nome)}</div>
              <div class="subtexto">${escapeHtml(ROTULO_PAPEL[u.role] || u.role)}</div>
            </div>
            <span class="pilula ${u.ativo ? 'status-ok' : 'status-erro'}">${u.ativo ? 'Ativo' : 'Inativo'}</span>
          </div>
        `).join('')}
      </div>

      <h2 class="titulo-secao">Dispositivos pareados (${dispositivos.length})</h2>
      <div class="lista-pedidos-andamento">
        ${dispositivos.length === 0 ? '<p class="estado-vazio">Nenhum dispositivo pareado.</p>' : dispositivos.map((d) => `
          <div class="cartao-pedido">
            <div>
              <div>${escapeHtml(d.nomeDispositivo || 'Celular')}</div>
              <div class="subtexto">${escapeHtml(ROTULO_TIPO_DISPOSITIVO[d.tipo] || d.tipo)} · ${escapeHtml(nomeDoVinculo(d.vinculoUserId))}</div>
            </div>
            <span class="pilula ${d.ativo ? 'status-ok' : 'status-erro'}">${d.ativo ? 'Ativo' : 'Desconectado'}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  /** Nome de exibição de um vinculoUserId cruzando com gestao_usuarios
   * (o doc de dispositivos só guarda o id). "—" se ainda não chegou. */
  function nomeDoVinculo(vinculoUserId) {
    const usuario = usuarios.find((u) => u.id === vinculoUserId);
    return usuario ? usuario.nome : '—';
  }

  function atualizarTempoRelativo() {
    const el = root.querySelector('#tempo-atualizacao');
    if (el) el.textContent = ultimaAtualizacaoMs ? `atualizado ${formatarRelativo(ultimaAtualizacaoMs)}` : 'conectando...';
  }
  const intervaloRelativo = setInterval(atualizarTempoRelativo, 1000);

  // Lista de funcionários -- ver userStatusSyncService.js (regra restrita a
  // dispositivo tipo 'consulta'); publicada a cada ~60 s pelo desktop.
  const pararEscutaUsuarios = firestoreFns.onSnapshot(
    firestoreFns.doc(db, 'installations', loja.installId, 'gestao_usuarios', 'atual'),
    (snap) => {
      usuarios = snap.exists() ? (snap.data().usuarios || []) : [];
      renderGestao();
    },
    (err) => console.error('[consulta] escuta de usuários falhou', err)
  );

  // Dispositivos pareados -- leitura aberta nas regras.
  const pararEscutaDispositivos = firestoreFns.onSnapshot(
    firestoreFns.collection(db, 'installations', loja.installId, 'dispositivos'),
    (snap) => {
      dispositivos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderGestao();
    },
    (err) => console.error('[consulta] escuta de dispositivos pareados falhou', err)
  );

  firestoreFns.setDoc(
    firestoreFns.doc(db, 'installations', loja.installId, 'dispositivos', auth.currentUser.uid),
    { ultimoAcesso: firestoreFns.serverTimestamp() },
    { merge: true }
  ).catch(() => {});

  renderGestao();

  return () => {
    desmontarPainel();
    pararEscutaUsuarios();
    pararEscutaDispositivos();
    clearInterval(intervaloRelativo);
  };
}

function escapeHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

export { mount };
