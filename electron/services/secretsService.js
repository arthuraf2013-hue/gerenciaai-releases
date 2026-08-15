/**
 * safeStorage usa o cofre de credenciais do próprio sistema operacional
 * (DPAPI no Windows, Keychain no mac, libsecret no Linux) — a chave de
 * criptografia nunca fica no nosso banco nem no nosso código, é do SO.
 * Isso significa que o valor criptografado só abre na MESMA máquina/
 * usuário que gravou — o que é o comportamento certo aqui (a chave da
 * API de IA e a senha do certificado não precisam "viajar" entre PCs).
 *
 * 'electron' é carregado sob demanda -- ver comentário em attachmentService.js.
 */
function getSafeStorage() {
  return require('electron').safeStorage;
}

function isAvailable() {
  const safeStorage = getSafeStorage();
  return !!safeStorage && safeStorage.isEncryptionAvailable();
}

/** Retorna string base64 pronta para guardar numa coluna TEXT do SQLite.
 * Se a criptografia do SO não estiver disponível (raro, mas acontece em
 * alguns Linux sem keyring configurado), guarda em texto puro mesmo —
 * melhor funcionar sem a proteção extra do que travar o app inteiro. */
function encrypt(plainText) {
  if (!plainText) return null;
  if (!isAvailable()) return plainText;
  return getSafeStorage().encryptString(plainText).toString('base64');
}

function decrypt(storedValue) {
  if (!storedValue) return null;
  if (!isAvailable()) return storedValue;
  try {
    return getSafeStorage().decryptString(Buffer.from(storedValue, 'base64'));
  } catch {
    // Valor foi gravado antes de existir criptografia (texto puro) —
    // devolve como está em vez de quebrar.
    return storedValue;
  }
}

module.exports = { isAvailable, encrypt, decrypt };
