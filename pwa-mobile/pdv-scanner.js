import { icon } from './icons.js';
import { escapeHtml } from './pdv-util.js';

/**
 * Leitura de código de barras pela câmera do celular -- BarcodeDetector
 * (nativo no Chrome do Android, sem biblioteca nenhuma). Onde não existe
 * (iPhone/Safari, navegadores antigos), quem chama cai pra digitação do
 * código -- e leitor de código Bluetooth/USB continua funcionando sempre,
 * porque ele "digita" no campo de busca e manda Enter.
 */

const FORMATOS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'];

function cameraDisponivel() {
  return 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
}

/** Abre a câmera em tela cheia. `onCodigo(codigo)` é chamado a cada
 * leitura; em modo contínuo a câmera continua aberta (ignora o mesmo
 * código repetido por 1,5 s). Devolve a função de fechar. */
async function abrirScanner({ onCodigo, continuo = false }) {
  let suportados = FORMATOS;
  try {
    const nativos = await window.BarcodeDetector.getSupportedFormats();
    suportados = FORMATOS.filter((f) => nativos.includes(f));
  } catch { /* usa a lista toda */ }
  const detector = new window.BarcodeDetector({ formats: suportados.length ? suportados : FORMATOS });

  const tela = document.createElement('div');
  tela.className = 'scanner-tela';
  tela.innerHTML = `
    <video playsinline muted></video>
    <div class="scanner-mira" aria-hidden="true"></div>
    <div class="scanner-topo">
      <button class="btn-icone scanner-fechar" aria-label="Fechar câmera">${icon('fechar', 24)}</button>
      <label class="scanner-continuo"><input type="checkbox" ${continuo ? 'checked' : ''}> Leitura contínua</label>
    </div>
    <p class="scanner-dica">Aponte para o código de barras</p>
  `;
  document.body.appendChild(tela);
  const video = tela.querySelector('video');
  const dica = tela.querySelector('.scanner-dica');
  const chkContinuo = tela.querySelector('.scanner-continuo input');

  let stream = null;
  let ativo = true;
  let ultimo = { codigo: null, em: 0 };

  const fechar = () => {
    if (!ativo) return;
    ativo = false;
    stream?.getTracks().forEach((t) => t.stop());
    tela.remove();
  };
  tela.querySelector('.scanner-fechar').addEventListener('click', fechar);

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    dica.innerHTML = `Não foi possível abrir a câmera${err?.name === 'NotAllowedError' ? ' (permissão negada — libere a câmera nas configurações do navegador)' : ''}.`;
    return fechar;
  }

  const ler = async () => {
    if (!ativo) return;
    try {
      if (video.readyState >= 2) {
        const achados = await detector.detect(video);
        const codigo = achados[0]?.rawValue?.trim();
        if (codigo && !(codigo === ultimo.codigo && Date.now() - ultimo.em < 1500)) {
          ultimo = { codigo, em: Date.now() };
          dica.textContent = `Lido: ${codigo}`;
          onCodigo(codigo);
          if (!chkContinuo.checked) { fechar(); return; }
        }
      }
    } catch { /* quadro ruim -- tenta o próximo */ }
    setTimeout(ler, 180);
  };
  ler();
  return fechar;
}

/** Fallback: digitar o código (navegador sem câmera/BarcodeDetector). */
function pedirCodigoDigitado({ onCodigo, abrirSheet }) {
  const { el, fechar } = abrirSheet(`
    <h2>Digitar código</h2>
    <p class="subtexto">${escapeHtml(cameraDisponivel() ? '' : 'Este navegador não lê código pela câmera. Digite o código (ou use um leitor Bluetooth no campo de busca).')}</p>
    <input id="codigo-digitado" class="campo" inputmode="numeric" autocomplete="off" placeholder="Código de barras ou SKU" />
    <button id="btn-ok-codigo" class="btn-primario">Adicionar</button>
    <button id="btn-cancelar-codigo" class="btn-secundario">Cancelar</button>
  `);
  const input = el.querySelector('#codigo-digitado');
  input.focus();
  const confirmar = () => {
    const c = input.value.trim();
    if (!c) return;
    fechar();
    onCodigo(c);
  };
  el.querySelector('#btn-ok-codigo').addEventListener('click', confirmar);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmar(); });
  el.querySelector('#btn-cancelar-codigo').addEventListener('click', fechar);
}

export { cameraDisponivel, abrirScanner, pedirCodigoDigitado };
