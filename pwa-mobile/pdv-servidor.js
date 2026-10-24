import { auth, db, firestoreFns as F } from './firebase-config.js';

/**
 * Comunicação do PDV móvel com o "servidor" da loja -- o GerenciaAI
 * aberto no computador, através do Firestore (o celular nunca fala direto
 * com o SQLite). Lado de lá: electron/services/pdvMobileSyncService.js
 * (vendas) e pdvMobileConsultaService.js (consultas).
 */

const VERSAO_APP = 'pdv-movel-1';

// Se o computador não republicar a config há mais que isto, consideramos o
// servidor fora do ar (desktop fechado, sem internet) e não deixamos
// finalizar venda -- ela ficaria esperando sem ninguém processar.
const SERVIDOR_SILENCIOSO_MS = 90 * 1000;

function caminhoLoja(installId, ...resto) {
  return ['installations', installId, ...resto];
}

/** Escuta a config publicada pelo desktop (config_mobile/pdv). Devolve
 * a função de parar. `aoMudar({ config, doServidor, erro })`. */
function observarConfig(installId, aoMudar) {
  return F.onSnapshot(
    F.doc(db, ...caminhoLoja(installId, 'config_mobile', 'pdv')),
    { includeMetadataChanges: true },
    (snap) => {
      aoMudar({
        config: snap.exists() ? snap.data() : null,
        // fromCache = este celular não está conectado ao Firestore agora.
        doServidor: !snap.metadata.fromCache,
      });
    },
    (erro) => aoMudar({ config: null, doServidor: false, erro })
  );
}

function idadeDoServidorMs(config) {
  const ms = config?.atualizadoEm?.toMillis ? config.atualizadoEm.toMillis() : 0;
  return ms ? Date.now() - ms : Infinity;
}

function servidorRespondendo(config) {
  return idadeDoServidorMs(config) < SERVIDOR_SILENCIOSO_MS;
}

/** Pedido/resposta (consultas_pdv). Rejeita com Error amigável em
 * timeout/erro. Começa a escutar ANTES da escrita confirmar no servidor
 * (setDoc só resolve depois do ack, e a resposta do desktop pode chegar
 * antes disso). */
function consultar(installId, tipo, parametros = {}, { timeoutMs = 15000 } = {}) {
  const ref = F.doc(F.collection(db, ...caminhoLoja(installId, 'consultas_pdv')));
  return new Promise((resolve, reject) => {
    let terminado = false;
    let parar = () => {};
    const terminar = (fn, valor) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(timer);
      parar();
      fn(valor);
    };
    const timer = setTimeout(
      () => terminar(reject, new Error('O computador da loja não respondeu a tempo. Confira se o GerenciaAI está aberto e com internet.')),
      timeoutMs
    );
    parar = F.onSnapshot(ref, (snap) => {
      const d = snap.data();
      if (d?.status === 'respondida') terminar(resolve, d.resultado);
      else if (d?.status === 'erro') terminar(reject, new Error(d.erro || 'O computador recusou a consulta.'));
    }, (err) => terminar(reject, traduzirErro(err)));

    F.setDoc(ref, {
      dispositivoUid: auth.currentUser.uid, status: 'novo', tipo, ...parametros, criadoEm: F.serverTimestamp(),
    }).catch((err) => terminar(reject, traduzirErro(err)));
  });
}

// Mesmo prazo de pdvMobileGestaoService.VALIDADE_PEDIDO_MS no computador:
// pedido mais velho que isto é descartado lá, então aqui dá pra dizer com
// certeza "não foi aplicado".
const VALIDADE_PEDIDO_GESTAO_MS = 10 * 60 * 1000;

/**
 * Pedido de gestão de produto (gestao_pdv): detalhe, preço, estoque,
 * cadastro. Diferente de `consultar`, aqui MUDA dado -- então, se o
 * computador demorar, não dá pra dizer "falhou": a resposta ainda pode
 * chegar. Rejeita com `err.semResposta = true` depois de `timeoutMs` e
 * continua escutando até o prazo do computador acabar; o resultado tardio
 * vai pra `aoResponderDepois({ resultado } | { erro })`.
 */
function pedirGestao(installId, tipo, parametros = {}, { timeoutMs = 20000, aoResponderDepois } = {}) {
  const ref = F.doc(F.collection(db, ...caminhoLoja(installId, 'gestao_pdv')));
  return new Promise((resolve, reject) => {
    let respondeu = false;
    let atrasado = false;
    let parar = () => {};
    const encerrar = () => { clearTimeout(timer); clearTimeout(prazo); parar(); };
    const timer = setTimeout(() => {
      if (respondeu) return;
      atrasado = true;
      const err = new Error(tipo === 'detalhe'
        ? 'O computador da loja não respondeu a tempo. Confira se o GerenciaAI está aberto e com internet.'
        : 'O computador da loja ainda não confirmou. Se ele responder nos próximos minutos, a alteração vale; depois de 10 minutos ela é descartada. Confira o produto antes de repetir.');
      err.semResposta = true;
      if (tipo === 'detalhe') { encerrar(); reject(err); return; }
      reject(err);
    }, timeoutMs);
    const prazo = setTimeout(() => {
      if (respondeu) return;
      encerrar();
      if (atrasado) aoResponderDepois?.({ erro: 'O computador não respondeu em 10 minutos: a alteração foi descartada.' });
    }, VALIDADE_PEDIDO_GESTAO_MS + 60000);

    const responder = (saida) => {
      if (respondeu) return;
      respondeu = true;
      encerrar();
      if (atrasado) { aoResponderDepois?.(saida); return; }
      if (saida.erro) reject(new Error(saida.erro));
      else resolve(saida.resultado);
    };
    parar = F.onSnapshot(ref, (snap) => {
      const d = snap.data();
      if (d?.status === 'respondida') responder({ resultado: d.resultado });
      else if (d?.status === 'erro') responder({ erro: d.erro || 'O computador recusou a alteração.' });
    }, (err) => {
      if (respondeu) return;
      respondeu = true;
      encerrar();
      if (!atrasado) reject(traduzirErro(err));
      else aoResponderDepois?.({ erro: `Perdi o acompanhamento da alteração (${traduzirErro(err).message}). Confira o produto antes de repetir.` });
    });

    F.setDoc(ref, {
      dispositivoUid: auth.currentUser.uid, status: 'novo', tipo, ...parametros, criadoEm: F.serverTimestamp(),
    }).catch((err) => {
      // Gravação recusada = o pedido nunca chegou ao computador.
      if (respondeu) return;
      respondeu = true;
      encerrar();
      if (!atrasado) reject(traduzirErro(err));
      else aoResponderDepois?.({ erro: `A alteração não foi enviada: ${traduzirErro(err).message}` });
    });
  });
}

/** Este celular pode mexer em produtos? Decide o computador (lista em
 * config_mobile/pdv, a mesma que a regra do Firestore confere). */
function gestaoLiberada(config) {
  const uid = auth.currentUser?.uid;
  return !!(uid && config?.gestaoProdutos === 'gestao' && Array.isArray(config?.gestaoLiberadaPara) && config.gestaoLiberadaPara.includes(uid));
}

function traduzirErro(err) {
  if (err?.code === 'permission-denied') {
    return new Error('Este celular não tem mais acesso a esta loja (desconectado pelo gerente ou módulo PDV móvel inativo).');
  }
  if (err?.code === 'unavailable') return new Error('Sem conexão com a internet.');
  return new Error(err?.message || 'Falha de comunicação.');
}

/** Gera o id da venda localmente (antes de enviar) -- é o que permite
 * guardar "venda em andamento" e retomar o acompanhamento se o app
 * fechar no meio, sem nunca reenviar em duplicidade. */
function novoIdVenda(installId) {
  return F.doc(F.collection(db, ...caminhoLoja(installId, 'vendas_mobile'))).id;
}

/** Envia a venda (um documento só). Resolve quando o servidor do
 * Firestore confirmar a gravação. */
function enviarVenda(installId, vendaId, dados) {
  return F.setDoc(F.doc(db, ...caminhoLoja(installId, 'vendas_mobile', vendaId)), {
    ...dados,
    dispositivoUid: auth.currentUser.uid,
    status: 'novo',
    criadoEm: F.serverTimestamp(),
    appVersao: VERSAO_APP,
  });
}

/** Acompanha o resultado. `aoMudar({ fase, dados })`, fase:
 * 'enviando' (só no celular ainda) | 'aguardando' (no servidor, desktop
 * ainda não processou) | 'finalizada' | 'pendente' | 'erro' | 'inexistente'. */
function observarVenda(installId, vendaId, aoMudar) {
  return F.onSnapshot(
    F.doc(db, ...caminhoLoja(installId, 'vendas_mobile', vendaId)),
    { includeMetadataChanges: true },
    (snap) => {
      if (!snap.exists()) { aoMudar({ fase: snap.metadata.fromCache ? 'enviando' : 'inexistente', dados: null }); return; }
      const d = snap.data();
      if (snap.metadata.hasPendingWrites) { aoMudar({ fase: 'enviando', dados: d }); return; }
      const fase = { novo: 'aguardando', finalizada: 'finalizada', pendente: 'pendente', erro: 'erro' }[d.status] || 'aguardando';
      aoMudar({ fase, dados: d });
    },
    (err) => aoMudar({ fase: 'erro-escuta', dados: null, erro: traduzirErro(err) })
  );
}

/** Últimas vendas DESTE celular (índice composto dispositivoUid +
 * criadoEm, ver firestore.indexes.json). */
function observarMinhasVendas(installId, aoMudar, { limite = 40 } = {}) {
  const q = F.query(
    F.collection(db, ...caminhoLoja(installId, 'vendas_mobile')),
    F.where('dispositivoUid', '==', auth.currentUser.uid),
    F.orderBy('criadoEm', 'desc'),
    F.limit(limite)
  );
  return F.onSnapshot(q, (snap) => aoMudar({ vendas: snap.docs.map((d) => ({ id: d.id, ...d.data() })) }),
    (err) => aoMudar({ vendas: null, erro: traduzirErro(err) }));
}

function observarStatusAoVivo(installId, aoMudar) {
  return F.onSnapshot(
    F.doc(db, ...caminhoLoja(installId, 'status_ao_vivo', 'atual')),
    (snap) => aoMudar(snap.exists() ? snap.data() : null),
    (err) => console.error('[pdv] escuta do catálogo falhou', err)
  );
}

/** "Visto por último" pro gerente em Configurações → Celular (único
 * campo, junto do nome, que o celular pode mexer no próprio vínculo). */
function registrarSinalDeVida(installId) {
  return F.setDoc(F.doc(db, ...caminhoLoja(installId, 'dispositivos', auth.currentUser.uid)),
    { ultimoAcesso: F.serverTimestamp() }, { merge: true }).catch(() => {});
}

function renomearDispositivo(installId, nome) {
  return F.updateDoc(F.doc(db, ...caminhoLoja(installId, 'dispositivos', auth.currentUser.uid)), { nomeDispositivo: nome });
}

export {
  observarConfig, servidorRespondendo, idadeDoServidorMs, consultar, pedirGestao, gestaoLiberada, novoIdVenda, enviarVenda, observarVenda,
  observarMinhasVendas, observarStatusAoVivo, registrarSinalDeVida, renomearDispositivo, traduzirErro,
};
