import { auth, db, authFns, firestoreFns } from './firebase-config.js';
import { adicionarOuAtualizarLoja } from './store.js';

/**
 * Tela de pareamento -- troca o código de 6 dígitos gerado em
 * Configurações (desktop) por um vínculo permanente. Ver
 * electron/services/pairingService.js e firestore.rules (comentado lá o
 * porquê de cada regra) pro lado de trás disto.
 *
 * IMPORTANTE pra quem for publicar isto: a busca do código usa uma
 * collectionGroup query (o celular não sabe o installId da loja de
 * antemão) -- isso EXIGE um índice de collection group publicado
 * (ver firestore.indexes.json na raiz do repo:
 * `firebase deploy --only firestore:indexes`). Sem isso, a busca falha
 * com um erro do tipo "query requires an index" na primeira vez que
 * alguém tentar parear.
 */
function mount(root, { onPareado }) {
  root.innerHTML = `
    <div class="tela-pareamento">
      <div class="logo-pareamento">GerenciaAI</div>
      <h1>Parear celular</h1>
      <p class="subtitulo">Peça pro gerente gerar um código em <strong>Configurações → Celular</strong> e digite os 6 números abaixo.</p>
      <form id="form-codigo" autocomplete="off">
        <input id="input-codigo" inputmode="numeric" pattern="[0-9]*" maxlength="6"
               placeholder="000000" aria-label="Código de pareamento" />
        <button type="submit" id="btn-parear" class="btn-primario">Continuar</button>
      </form>
      <p id="msg-erro" class="msg-erro" hidden></p>
      <div id="confirmacao" hidden></div>
    </div>
  `;

  const input = root.querySelector('#input-codigo');
  const form = root.querySelector('#form-codigo');
  const btn = root.querySelector('#btn-parear');
  const msgErro = root.querySelector('#msg-erro');
  const confirmacaoEl = root.querySelector('#confirmacao');

  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
  });
  input.focus();

  function mostrarErro(texto) {
    msgErro.textContent = texto;
    msgErro.hidden = false;
  }
  function limparErro() {
    msgErro.hidden = true;
  }

  let pareamentoEncontrado = null;

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    limparErro();
    confirmacaoEl.hidden = true;
    const codigo = input.value.trim();
    if (codigo.length !== 6) {
      mostrarErro('Digite os 6 números do código.');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Procurando...';
    try {
      if (!auth.currentUser) {
        await authFns.signInAnonymously(auth);
      }

      // Diagnóstico: força buscar um token novo (em vez de confiar no
      // que já está em memória/persistido) e loga tudo que dá pra saber
      // sobre a sessão ANTES de disparar a consulta -- se o uid vier
      // vazio, ou isAnonymous vier false, ou a busca do token falhar
      // aqui, o problema é a sessão de autenticação, não a regra do
      // Firestore em si. Ver console do navegador (F12 -> Console).
      console.log('[pairing][diag] auth.currentUser antes da consulta:', {
        uid: auth.currentUser?.uid,
        isAnonymous: auth.currentUser?.isAnonymous,
        emulator: auth.currentUser ? null : 'SEM USUÁRIO -- signInAnonymously não deixou ninguém logado',
      });
      if (auth.currentUser) {
        try {
          const token = await auth.currentUser.getIdToken(/* forceRefresh */ true);
          console.log('[pairing][diag] token novo obtido com sucesso, tamanho:', token.length);
        } catch (tokenErr) {
          console.error('[pairing][diag] getIdToken(forceRefresh) FALHOU -- problema é a sessão de auth, não a regra:', tokenErr);
        }
      }

      const q = firestoreFns.query(
        firestoreFns.collectionGroup(db, 'pareamentos'),
        firestoreFns.where('codigo', '==', codigo)
      );
      console.log('[pairing][diag] disparando collectionGroup query, codigo =', JSON.stringify(codigo));
      const snap = await firestoreFns.getDocs(q);
      console.log('[pairing][diag] getDocs OK, docs encontrados:', snap.size);
      if (snap.empty) {
        mostrarErro('Código não encontrado. Confira os números ou peça um código novo.');
        return;
      }

      const docSnap = snap.docs[0];
      const dados = docSnap.data();

      if (dados.usado) {
        mostrarErro('Esse código já foi usado. Peça um código novo pro gerente.');
        return;
      }
      const expiraEmMs = dados.expiraEm?.toMillis ? dados.expiraEm.toMillis() : 0;
      if (expiraEmMs && expiraEmMs < Date.now()) {
        mostrarErro('Esse código expirou (validade de 10 minutos). Peça um código novo.');
        return;
      }

      pareamentoEncontrado = { ref: docSnap.ref, dados };
      renderConfirmacao(dados);
    } catch (err) {
      console.error('[pairing] falha ao buscar código', err);
      // Mostra o código de erro de verdade (permission-denied,
      // unauthenticated, failed-precondition, unavailable...) na
      // própria tela -- sem isso, toda falha aqui vira a mesma
      // mensagem genérica e cada rodada de diagnóstico exige pedir
      // pra alguém abrir o F12/console remoto de novo. Com o código
      // na tela, dá pra ler direto de um print de celular.
      const detalhe = err?.code ? ` (código: ${err.code})` : '';
      mostrarErro(`Não foi possível conectar agora${detalhe}. Confira sua internet e tente de novo.`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Continuar';
    }
  });

  function renderConfirmacao(dados) {
    const tipoLabel = dados.tipo === 'garcom' ? 'Garçom (lançar pedidos)' : 'Consulta remota (ver dados da loja)';
    confirmacaoEl.hidden = false;
    confirmacaoEl.innerHTML = `
      <div class="card-confirmacao">
        <p><strong>${escapeHtml(dados.nomeNegocio || 'Loja')}</strong></p>
        <p class="linha-vinculo">Entrar como <strong>${escapeHtml(dados.vinculoNome || '')}</strong> — ${tipoLabel}</p>
        <button id="btn-confirmar" class="btn-primario">Confirmar e entrar</button>
        <button id="btn-cancelar" class="btn-secundario">Cancelar</button>
      </div>
    `;
    confirmacaoEl.querySelector('#btn-cancelar').addEventListener('click', () => {
      pareamentoEncontrado = null;
      confirmacaoEl.hidden = true;
      input.value = '';
      input.focus();
    });
    confirmacaoEl.querySelector('#btn-confirmar').addEventListener('click', confirmarPareamento);
  }

  async function confirmarPareamento() {
    if (!pareamentoEncontrado) return;
    const btnConfirmar = confirmacaoEl.querySelector('#btn-confirmar');
    btnConfirmar.disabled = true;
    btnConfirmar.textContent = 'Entrando...';
    limparErro();

    const { ref: pareamentoRef, dados } = pareamentoEncontrado;
    const uid = auth.currentUser.uid;
    const deviceRef = firestoreFns.doc(db, 'installations', dados.installId, 'dispositivos', uid);

    try {
      // As DUAS escritas (marcar o código usado + criar o dispositivo)
      // andam juntas numa transação: as regras do Firestore conferem o
      // estado ANTERIOR à transação em ambas (ver comentário em
      // firestore.rules), então ou as duas passam, ou nenhuma passa --
      // nunca fica um código "gasto" sem um dispositivo de verdade.
      await firestoreFns.runTransaction(db, async (tx) => {
        const pSnap = await tx.get(pareamentoRef);
        if (!pSnap.exists() || pSnap.data().usado) {
          throw new Error('CODIGO_JA_USADO');
        }
        tx.update(pareamentoRef, {
          usado: true, usadoPorUid: uid, usadoEm: firestoreFns.serverTimestamp(),
        });
        tx.set(deviceRef, {
          tipo: dados.tipo, vinculoUserId: dados.vinculoUserId, pareamentoCodigo: dados.codigo,
          nomeDispositivo: `${dados.vinculoNome || 'Celular'} — ${navigator.platform || 'celular'}`,
          ativo: true, ultimoAcesso: firestoreFns.serverTimestamp(),
        });
      });

      // Lista pessoal (dono de rede pode ter várias lojas no mesmo
      // celular/uid) -- documento próprio do uid, só ele mexe nele.
      const listaRef = firestoreFns.doc(db, 'dispositivos_pareados', uid);
      await firestoreFns.setDoc(listaRef, {
        lojas: firestoreFns.arrayUnion({
          installId: dados.installId, nomeNegocio: dados.nomeNegocio || 'Loja',
          tipo: dados.tipo, vinculoUserId: dados.vinculoUserId, vinculoNome: dados.vinculoNome || '',
        }),
      }, { merge: true });

      adicionarOuAtualizarLoja({
        installId: dados.installId, nomeNegocio: dados.nomeNegocio || 'Loja', tipo: dados.tipo,
        vinculoUserId: dados.vinculoUserId, vinculoNome: dados.vinculoNome || '', deviceUid: uid,
      });

      onPareado();
    } catch (err) {
      console.error('[pairing] falha ao confirmar pareamento', err);
      if (err.message === 'CODIGO_JA_USADO') {
        mostrarErro('Esse código acabou de ser usado por outro celular. Peça um código novo.');
      } else {
        mostrarErro('Não foi possível concluir agora. Confira sua internet e tente de novo.');
      }
      btnConfirmar.disabled = false;
      btnConfirmar.textContent = 'Confirmar e entrar';
    }
  }

  return () => {}; // nada pra desmontar (sem listener em tempo real nesta tela)
}

function escapeHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

export { mount };
