/**
 * Redefine o PIN do usuário admin para "0000" (o padrão de fábrica),
 * marcando como temporário para o app pedir a troca no próximo login.
 *
 * Uso:
 *   1. Feche o GerenciaAI completamente (o arquivo do banco não pode
 *      estar em uso).
 *   2. Na pasta do projeto (onde tem node_modules), rode:
 *        node reset-admin-pin.js
 *
 * Não precisa saber o PIN atual — é para isso que ele existe.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const candidates = [
  path.join(os.homedir(), 'AppData', 'Roaming', 'gerenciaai', 'gerenciaai.sqlite3'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'GerenciaAI', 'gerenciaai.sqlite3'),
  // Linux/Mac, caso um dia rode fora do Windows:
  path.join(os.homedir(), '.config', 'gerenciaai', 'gerenciaai.sqlite3'),
];

const dbPath = candidates.find((p) => fs.existsSync(p));

if (!dbPath) {
  console.error('Não encontrei o banco em nenhum destes caminhos:');
  candidates.forEach((p) => console.error('  ' + p));
  console.error('\nSe o app já rodou pelo menos uma vez, edite este script e adicione o caminho certo em "candidates".');
  process.exit(1);
}

console.log('Banco encontrado em:', dbPath);

const db = new Database(dbPath);
const admin = db.prepare(`SELECT * FROM users WHERE role = 'admin' ORDER BY criado_em ASC LIMIT 1`).get();

if (!admin) {
  console.error('Nenhum usuário admin encontrado nesse banco.');
  process.exit(1);
}

const novoPinHash = bcrypt.hashSync('0000', 10);
db.prepare(
  `UPDATE users SET pin_hash = ?, pin_temporario = 1, tentativas_falhas = 0, bloqueado_ate = NULL WHERE id = ?`
).run(novoPinHash, admin.id);

console.log(`\nPIN do usuário "${admin.nome}" (admin) redefinido para 0000.`);
console.log('Abra o app normalmente — ele vai pedir para você trocar esse PIN assim que entrar.');
