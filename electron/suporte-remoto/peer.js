/* eslint-disable no-undef */
/**
 * WebRTC do lado do CLIENTE (computador da loja), rodando numa janela
 * oculta do Electron (ver electron/services/suporteRemotoService.js).
 *
 * Esta janela:
 *   - captura a tela (getDisplayMedia -> o processo principal auto-escolhe
 *     a tela via setDisplayMediaRequestHandler, sem picker);
 *   - abre a conexão WebRTC (P2P, cifrada DTLS/SRTP) e o canal de dados;
 *   - manda a oferta e os candidatos ICE pro processo principal (que
 *     repassa pro Firestore), e recebe a resposta/ICE do técnico de volta;
 *   - repassa cada mensagem do canal de dados pro processo principal, que
 *     é quem confere o código e executa shell/correção/arquivo. Esta
 *     janela NUNCA decide nada sensível sozinha.
 *
 * A captura de tela só começa quando esta janela é criada -- e ela só é
 * criada depois que o cliente autoriza (ou com o acesso não supervisionado
 * ligado de propósito). Ver o fluxo em suporteRemotoService.aceitarConexao.
 */
(function () {
  let pc = null;
  let canal = null;
  const api = window.suportePeer;

  function avisarMain(evento, extra) { api.evento({ evento, ...(extra || {}) }); }

  async function iniciar({ iceServers }) {
    try {
      pc = new RTCPeerConnection({ iceServers: iceServers || [] });

      pc.onicecandidate = (e) => {
        if (e.candidate) api.enviarSinal({ tipo: 'ice', candidato: e.candidate.toJSON() });
      };
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'failed' || s === 'disconnected' || s === 'closed') avisarMain('desconectou', { estado: s });
      };

      // Canal de dados (quem faz a oferta cria o canal; o técnico recebe
      // via ondatachannel). É por aqui que trafega código, shell, arquivo
      // e área de transferência -- cifrado.
      canal = pc.createDataChannel('suporte', { ordered: true });
      canal.binaryType = 'arraybuffer';
      canal.onopen = () => avisarMain('canal_aberto');
      canal.onclose = () => avisarMain('desconectou', { estado: 'canal_fechado' });
      canal.onmessage = (ev) => {
        try { api.mensagemDoCanal(JSON.parse(ev.data)); }
        catch { /* mensagem malformada -- ignora */ }
      };

      // Captura de tela e adiciona ao peer (entra na oferta como vídeo).
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      } catch (err) {
        avisarMain('desconectou', { estado: 'sem_captura', erro: String(err && err.message || err) });
        return;
      }
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      // Se o cliente parar o compartilhamento pela UI do sistema, encerra.
      stream.getVideoTracks().forEach((t) => { t.onended = () => avisarMain('desconectou', { estado: 'captura_encerrada' }); });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      api.enviarSinal({ tipo: 'offer', sdp: pc.localDescription });
    } catch (err) {
      avisarMain('desconectou', { estado: 'erro', erro: String(err && err.message || err) });
    }
  }

  async function sinalRemoto(d) {
    if (!pc) return;
    try {
      if (d.tipo === 'answer' && d.sdp && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
      } else if (d.tipo === 'ice' && Array.isArray(d.candidatos)) {
        for (const c of d.candidatos) {
          try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* candidato repetido/ordem */ }
        }
      }
    } catch (err) {
      avisarMain('desconectou', { estado: 'erro_sinal', erro: String(err && err.message || err) });
    }
  }

  function enviarPeloCanal(msg) {
    try { if (canal && canal.readyState === 'open') canal.send(JSON.stringify(msg)); } catch { /* fechando */ }
  }

  api.aoIniciar(iniciar);
  api.aoSinalRemoto(sinalRemoto);
  api.aoEnviarCanal(enviarPeloCanal);
})();
