const test = require('node:test');
const assert = require('node:assert/strict');
const cliente = require('../electron/services/lanClienteService');

// Varredura da rede pelo caixa: quais endereços entram.
const iface = (address, netmask, extra = {}) => ({ address, netmask, family: 'IPv4', internal: false, ...extra });

test('rede /24: todos os 253 vizinhos, sem este computador nem rede/broadcast', () => {
  const lista = cliente.enderecosDaRede({ eth: [iface('192.168.0.15', '255.255.255.0')] });
  assert.equal(lista.length, 253);
  assert.ok(lista.includes('192.168.0.1'));
  assert.ok(lista.includes('192.168.0.254'));
  assert.ok(!lista.includes('192.168.0.15'));
  assert.ok(!lista.includes('192.168.0.0') && !lista.includes('192.168.0.255'));
});

test('rede /23 entra inteira; rede grande demais cai para a faixa /24 deste computador', () => {
  assert.equal(cliente.enderecosDaRede({ eth: [iface('10.0.1.20', '255.255.254.0')] }).length, 509);
  const grande = cliente.enderecosDaRede({ eth: [iface('10.20.30.40', '255.255.0.0')] });
  assert.equal(grande.length, 253);
  assert.ok(grande.every((ip) => ip.startsWith('10.20.30.')));
});

test('ignora loopback, IPv6 e endereço automático (169.254)', () => {
  const lista = cliente.enderecosDaRede({
    lo: [iface('127.0.0.1', '255.0.0.0', { internal: true })],
    v6: [{ address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false }],
    apipa: [iface('169.254.10.2', '255.255.0.0')],
  });
  assert.deepEqual(lista, []);
});

test('varredura sem ninguém respondendo devolve vazio, sem travar', async () => {
  const r = await cliente.varrerRede('g-x', { enderecos: ['127.0.0.1'], porta: 1, timeoutMs: 300 });
  assert.deepEqual(r, []);
});

test('procurar e sincronizar: recusa fora de grupo e no servidor', async () => {
  const { db } = require('./helpers/testDb').freshTestDb();
  const s = require('../electron/services/lanSincronizarService');
  assert.match((await s.procurarESincronizar()).error, /não está em um grupo/);
  db.prepare("UPDATE sync_state SET grupo_sincronizacao_id = 'g1', servidor_do_grupo = 1 WHERE id = 'default'").run();
  assert.match((await s.procurarESincronizar()).error, /é o servidor/);
});
