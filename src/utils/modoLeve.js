// "Modo leve" da interface -- pensado pra máquina de entrada (Celeron,
// 4 GB de RAM). Não desliga nenhuma função: só tira transições/animações
// de CSS, que custam redesenho constante numa placa de vídeo integrada
// fraca. 'auto' (padrão) liga sozinho quando o processo principal detecta
// hardware de entrada (ver electron/services/hardwareService.js).

const CHAVE = 'gerenciaai:modoLeve'; // 'auto' | 'ligado' | 'desligado'

export function lerPreferenciaModoLeve() {
  try {
    const v = localStorage.getItem(CHAVE);
    return v === 'ligado' || v === 'desligado' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export async function aplicarModoLeve() {
  const pref = lerPreferenciaModoLeve();
  let ativo = pref === 'ligado';
  if (pref === 'auto') {
    try {
      const perfil = await window.pdv.system.getPerfilDesempenho();
      ativo = !!perfil?.modoLeveAutomatico;
    } catch {
      ativo = false;
    }
  }
  document.documentElement.classList.toggle('modo-leve', ativo);
  return ativo;
}

export function gravarPreferenciaModoLeve(valor) {
  try { localStorage.setItem(CHAVE, valor); } catch { /* sem armazenamento: vale só nesta sessão */ }
  return aplicarModoLeve();
}
