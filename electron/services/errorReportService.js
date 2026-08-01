/**
 * Reporta erros não tratados (crash do processo principal, erro de
 * JS não capturado no renderer) pro Firestore — assim o Arthur vê
 * antes do cliente ligar reclamando. Só manda mensagem + stack trace
 * (texto técnico, sem dado de venda/cliente) + contexto de qual tela
 * — nunca dado de negócio.
 *
 * Limitado a no máximo 5 relatos por sessão (o app fica aberto o dia
 * inteiro) — sem isso, um erro que entra em loop (ex: um efeito do
 * React que falha e tenta de novo sem parar) inundaria o Firestore em
 * segundos.
 */

const LIMITE_POR_SESSAO = 5;
let contadorNaSessao = 0;

function truncar(texto, tamanho) {
  if (!texto) return null;
  return String(texto).slice(0, tamanho);
}

async function reportarErro({ mensagem, stack, contexto }) {
  if (contadorNaSessao >= LIMITE_POR_SESSAO) return; // já reportou demais nessa sessão, não insiste

  try {
    contadorNaSessao++;
    const licenseService = require('./licenseService');
    const pdvRegistryService = require('./pdvRegistryService');
    const { collection, addDoc, serverTimestamp } = require('firebase/firestore');
    const firestore = licenseService.getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();
    const { app } = require('electron');

    await addDoc(collection(firestore, 'erros_reportados'), {
      installationId: installId,
      mensagem: truncar(mensagem, 300),
      stack: truncar(stack, 2000),
      contexto: contexto || 'desconhecido',
      versaoApp: app?.getVersion ? app.getVersion() : null,
      criadoEm: serverTimestamp(),
    });
  } catch (err) {
    // Nunca deixa o reporte de erro virar ele mesmo um erro que trava
    // alguma coisa — só desiste silenciosamente (sem internet, regra
    // do Firestore ainda não publicada, etc.).
    console.error('[errorReportService] não conseguiu reportar o erro:', err.message);
  }
}

module.exports = { reportarErro };
