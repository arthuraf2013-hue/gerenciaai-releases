// Tudo que depende de "onde o app está rodando" fica aqui: no celular
// (Capacitor/Android) usa os recursos nativos; no navegador (preview,
// demonstração) cai num equivalente web. O resto do app não sabe a
// diferença.
import { Capacitor } from '@capacitor/core';
import { ErroDeNegocio } from '../services/base.js';

export const ehNativo = () => Capacitor.isNativePlatform();

const CHAVE_BANCO_WEB = 'gerenciaai-pdv-mobile:banco-demo';

function paraBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function deBase64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

/** Driver do banco + função que persiste (só no navegador; no celular o SQLite já grava em disco). */
export async function abrirDriver() {
  if (ehNativo()) {
    const { criarDriverCapacitor } = await import('../db/driverCapacitor.js');
    return { driver: await criarDriverCapacitor(), persistir: null };
  }
  const { criarDriverSqlJs } = await import('../db/driverSqlJs.js');
  let bytes = null;
  try {
    const salvo = localStorage.getItem(CHAVE_BANCO_WEB);
    if (salvo) bytes = deBase64(salvo);
  } catch { /* navegador sem armazenamento: começa vazio */ }
  const driver = await criarDriverSqlJs({ bytes, locateFile: (f) => `${import.meta.env.BASE_URL}${f}` });
  let t = null;
  const persistir = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      try { localStorage.setItem(CHAVE_BANCO_WEB, paraBase64(driver.exportar())); } catch { /* cheio/bloqueado: segue só em memória */ }
    }, 400);
  };
  return { driver, persistir };
}

export function apagarBancoDemo() {
  try { localStorage.removeItem(CHAVE_BANCO_WEB); } catch { /* ignore */ }
}

/** Lê um código de barras pela câmera. Devolve o texto, ou null se a pessoa cancelou. */
export async function lerCodigoDeBarras() {
  if (!ehNativo()) throw new ErroDeNegocio('Leitor pela câmera só no app do celular. Digite o código.', 'sem_camera');
  const { BarcodeScanner, BarcodeFormat } = await import('@capacitor-mlkit/barcode-scanning');
  const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
  if (!available) {
    // Primeiro uso: o Android baixa o leitor do Google Play (uma vez só).
    await BarcodeScanner.installGoogleBarcodeScannerModule();
    throw new ErroDeNegocio('Preparando o leitor de código pela primeira vez. Tente de novo em alguns segundos.', 'leitor_instalando');
  }
  try {
    const { barcodes } = await BarcodeScanner.scan({
      formats: [BarcodeFormat.Ean13, BarcodeFormat.Ean8, BarcodeFormat.UpcA, BarcodeFormat.UpcE, BarcodeFormat.Code128, BarcodeFormat.Code39, BarcodeFormat.Itf],
    });
    return barcodes?.[0]?.rawValue || null;
  } catch (err) {
    if (/cancel/i.test(err?.message || '')) return null;
    throw err;
  }
}

/** Compartilha texto (recibo) -- abre a escolha de app (WhatsApp, etc.). */
export async function compartilharTexto(texto, titulo = 'Recibo') {
  if (ehNativo()) {
    const { Share } = await import('@capacitor/share');
    await Share.share({ title: titulo, text: texto, dialogTitle: 'Enviar recibo' });
    return 'compartilhado';
  }
  if (navigator.share) {
    try { await navigator.share({ title: titulo, text: texto }); return 'compartilhado'; } catch { /* cancelou */ return 'cancelado'; }
  }
  await navigator.clipboard.writeText(texto);
  return 'copiado';
}

export function abrirWhatsApp(telefone, texto) {
  const numero = String(telefone || '').replace(/\D/g, '');
  const com55 = numero.length <= 11 ? `55${numero}` : numero;
  window.open(`https://wa.me/${com55}?text=${encodeURIComponent(texto)}`, '_blank');
}

/** Chama `fn` sempre que o app volta pro primeiro plano. */
export async function aoVoltarProApp(fn) {
  if (ehNativo()) {
    const { App } = await import('@capacitor/app');
    App.addListener('appStateChange', ({ isActive }) => { if (isActive) fn(); });
    return;
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') fn(); });
}

/** Chama `fn(conectado)` quando a rede muda. */
export async function aoMudarRede(fn) {
  if (ehNativo()) {
    const { Network } = await import('@capacitor/network');
    Network.addListener('networkStatusChange', (s) => fn(s.connected));
    fn((await Network.getStatus()).connected);
    return;
  }
  window.addEventListener('online', () => fn(true));
  window.addEventListener('offline', () => fn(false));
  fn(navigator.onLine);
}

/** Botão "voltar" do Android: `fn` devolve true se tratou (fechou um modal etc.). */
export async function aoApertarVoltar(fn) {
  if (!ehNativo()) return;
  const { App } = await import('@capacitor/app');
  App.addListener('backButton', () => { if (!fn()) App.minimizeApp(); });
}
