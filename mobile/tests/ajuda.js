import { Banco } from '../src/db/banco.js';
import { criarDriverSqlJs } from '../src/db/driverSqlJs.js';
import { migrar } from '../src/db/schema.js';
import { definirContexto, carregarRelogioMax, definirRelogioDoDispositivo } from '../src/services/base.js';
import { criarUsuario } from '../src/services/usuarios.js';
import { salvarProduto } from '../src/services/produtos.js';
import { abrirCaixa } from '../src/services/caixa.js';

export async function bancoNovo() {
  const banco = new Banco(await criarDriverSqlJs());
  await banco.exec('PRAGMA foreign_keys = ON');
  await migrar(banco);
  definirContexto({ dispositivoId: 'disp-teste', prefixoVenda: 'MT', modoTerminal: false, servidorNome: null });
  definirRelogioDoDispositivo(() => Date.now());
  carregarRelogioMax(0);
  return banco;
}

/** Banco com admin (PIN 1111), gerente (2222), operador (3333), 2 produtos e caixa aberto com R$ 50. */
export async function lojaPronta() {
  const db = await bancoNovo();
  const admin = await criarUsuario(db, { nome: 'Dona', papel: 'admin', pin: '1111' });
  const gerente = await criarUsuario(db, { nome: 'Gerente', papel: 'gerente', pin: '2222' });
  const operador = await criarUsuario(db, { nome: 'Caixa', papel: 'operador', pin: '3333' });
  const coca = await salvarProduto(db, { nome: 'Coca-Cola Lata', precoCentavos: 550, codigoBarras: '7894900011517', estoqueInicialMil: 10000 }, admin);
  const queijo = await salvarProduto(db, { nome: 'Queijo Coalho', precoCentavos: 5490, unidade: 'kg', estoqueInicialMil: 4200 }, admin);
  const caixaId = await abrirCaixa(db, { valorAberturaCentavos: 5000 }, operador);
  return { db, admin, gerente, operador, coca, queijo, caixaId };
}
