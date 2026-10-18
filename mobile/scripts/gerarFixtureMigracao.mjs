// Gera os backups de exemplo usados nos testes da migração do lado do
// computador (tests/pdvMobileMigracao.test.js, na raiz do repositório).
// Usa o PRÓPRIO código do app (mesmas regras de venda/estoque/fiado e o
// mesmo gerarDump do backup de verdade), então o teste do desktop sempre
// importa exatamente o formato que o celular produz.
//
//   node scripts/gerarFixtureMigracao.mjs
//
// Gera ../tests/fixtures/pdv-mobile-backup-1.json (primeira importação),
// pdv-mobile-backup-2.json (o mesmo celular depois de mais um dia de uso)
// e pdv-mobile-terminal-eventos.json (o mesmo celular virando TERMINAL do
// computador logo depois da primeira importação: o "atraso" -- tudo o que
// está no backup 2 e não estava no 1 -- e mais vendas já como terminal),
// usado em tests/pdvMobileTerminal.test.js.
import { writeFileSync, mkdirSync } from 'node:fs';
import { Banco } from '../src/db/banco.js';
import { criarDriverSqlJs } from '../src/db/driverSqlJs.js';
import { migrar } from '../src/db/schema.js';
import { definirContexto, carregarRelogioMax, definirRelogioDoDispositivo } from '../src/services/base.js';
import { criarUsuario } from '../src/services/usuarios.js';
import { salvarProduto, movimentarEstoque } from '../src/services/produtos.js';
import { salvarCliente, receberFiado } from '../src/services/clientes.js';
import { abrirCaixa, fecharCaixa, movimentarCaixa } from '../src/services/caixa.js';
import { finalizarVenda, cancelarVenda } from '../src/services/vendas.js';
import { gerarDump } from '../src/services/backup.js';
import { enfileirarDesdeCorte, VERSAO_EVENTO } from '../src/services/terminal.js';

const INSTALL = '7f3a9c1e-5b2d-4e8f-a1c0-9d8e7f6a5b4c';
const H = 3600000;
let agora = Date.UTC(2026, 9, 10, 12, 0, 0); // 10/10/2026 09:00 em Brasília
definirRelogioDoDispositivo(() => agora);
carregarRelogioMax(0);
definirContexto({ dispositivoId: INSTALL, prefixoVenda: 'M7F3A' });
const passar = (ms) => { agora += ms; };

const db = new Banco(await criarDriverSqlJs());
await db.exec('PRAGMA foreign_keys = ON');
await migrar(db);

const dona = await criarUsuario(db, { nome: 'Dona Lia', papel: 'admin', pin: '1111' });
const gerente = await criarUsuario(db, { nome: 'Rui', papel: 'gerente', pin: '2222' });
const caixa = await criarUsuario(db, { nome: 'Bia', papel: 'operador', pin: '3333' });

const coca = await salvarProduto(db, { nome: 'Coca-Cola Lata 350ml', precoCentavos: 550, custoCentavos: 320, codigoBarras: '7894900011517', estoqueInicialMil: 48000, estoqueMinimoMil: 12000, categoria: 'Bebidas' }, dona);
const pao = await salvarProduto(db, { nome: 'Pão Francês', precoCentavos: 1690, unidade: 'kg', estoqueInicialMil: 12500, categoria: 'Padaria' }, dona);
const cafe = await salvarProduto(db, { nome: 'Café Pilão 250g', precoCentavos: 1749, codigoBarras: '7896089012345', estoqueInicialMil: 10000 }, dona);
const recarga = await salvarProduto(db, { nome: 'Recarga de celular', precoCentavos: 2000, controlaEstoque: false }, dona);
const maria = await salvarCliente(db, { nome: 'Maria das Graças', telefone: '(81) 99999-4321', documento: '529.982.247-25', limiteFiadoCentavos: 30000 }, dona);
const joao = await salvarCliente(db, { nome: 'João Pedro', telefone: '81988887777' }, dona);

// Dia 1: caixa completo, fechado.
await abrirCaixa(db, { valorAberturaCentavos: 10000 }, caixa);
passar(H);
await finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 2000 }, { produtoId: pao, qtdMil: 750 }], pagamentos: [{ metodo: 'dinheiro', valorCentavos: 2368, recebidoCentavos: 5000 }] }, caixa);
passar(H);
await finalizarVenda(db, { itens: [{ produtoId: cafe, qtdMil: 2000 }], descontoCentavos: 700, pinGerenteDesconto: '2222', pagamentos: [{ metodo: 'pix', valorCentavos: 2798 }] }, caixa);
passar(H);
await finalizarVenda(db, { itens: [{ produtoId: recarga, qtdMil: 1000 }, { produtoId: coca, qtdMil: 1000 }], clienteId: maria, pagamentos: [{ metodo: 'fiado', valorCentavos: 2550 }] }, caixa);
passar(H);
const cancelada = await finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 6000 }], pagamentos: [{ metodo: 'debito', valorCentavos: 3300 }] }, caixa);
await cancelarVenda(db, { vendaId: cancelada.id, motivo: 'Cliente desistiu', pinGerente: '2222' }, caixa);
passar(H);
await finalizarVenda(db, { itens: [{ produtoId: pao, qtdMil: 1250 }], clienteId: joao, pagamentos: [{ metodo: 'credito', valorCentavos: 1000 }, { metodo: 'fiado', valorCentavos: 1113 }] }, caixa);
await movimentarCaixa(db, { tipo: 'sangria', valorCentavos: 2000, motivo: 'Pagamento do gás' }, gerente);
passar(H);
await fecharCaixa(db, { valorContadoCentavos: 10368, observacao: 'ok' }, gerente);

// Dia 2 (parte): caixa aberto, mais uma venda.
passar(20 * H);
await abrirCaixa(db, { valorAberturaCentavos: 5000 }, caixa);
passar(H);
const vendaQueSeraCancelada = await finalizarVenda(db, { itens: [{ produtoId: cafe, qtdMil: 1000 }], pagamentos: [{ metodo: 'dinheiro', valorCentavos: 1749 }] }, caixa);
passar(10 * 60000);

const nomeNegocio = 'Mercadinho Boa Vista';
const dump1 = await gerarDump(db, { installId: INSTALL });
dump1.nomeNegocio = nomeNegocio;

// Depois da primeira importação: o celular segue vendendo (até virar terminal).
passar(2 * H);
await finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 3000 }], clienteId: maria, pagamentos: [{ metodo: 'fiado', valorCentavos: 1650 }] }, caixa);
passar(H);
await receberFiado(db, { clienteId: maria, valorCentavos: 2000, metodo: 'pix' }, caixa);
await cancelarVenda(db, { vendaId: vendaQueSeraCancelada.id, motivo: 'Produto vencido', pinGerente: '2222' }, caixa);
await movimentarEstoque(db, { produtoId: cafe, modo: 'entrada', qtdMil: 24000, motivo: 'NF 4512' }, dona);
const queijo = await salvarProduto(db, { nome: 'Queijo Coalho', precoCentavos: 5490, unidade: 'kg', estoqueInicialMil: 4200 }, dona);
const ana = await salvarCliente(db, { nome: 'Ana Clara' }, dona);
passar(H);
await finalizarVenda(db, { itens: [{ produtoId: queijo, qtdMil: 500 }, { produtoId: cafe, qtdMil: 1000 }], clienteId: ana, pagamentos: [{ metodo: 'fiado', valorCentavos: 4494 }] }, caixa);
passar(10 * 60000);
const dump2 = await gerarDump(db, { installId: INSTALL });
dump2.nomeNegocio = nomeNegocio;

// Vira terminal do computador que importou o backup 1.
const atraso = await db.transacao((tx) => enfileirarDesdeCorte(tx, dump1.geradoEmMs));
definirContexto({ modoTerminal: true, servidorNome: 'Caixa do balcão' });
passar(H);
const cocaComputador = coca; // veio no catálogo do computador com o mesmo id
const vendaTerminal = await finalizarVenda(db, { itens: [{ produtoId: cocaComputador, qtdMil: 4000 }, { produtoId: queijo, qtdMil: 250 }], pagamentos: [{ metodo: 'dinheiro', valorCentavos: 3573, recebidoCentavos: 5000 }] }, caixa);
passar(10 * 60000);
const carla = await salvarCliente(db, { nome: 'Carla Souza', documento: '111.444.777-35' }, caixa);
await finalizarVenda(db, { itens: [{ produtoId: pao, qtdMil: 1000 }], clienteId: carla, pagamentos: [{ metodo: 'fiado', valorCentavos: 1690 }] }, caixa);
passar(10 * 60000);
await receberFiado(db, { clienteId: joao, valorCentavos: 1113, metodo: 'dinheiro' }, caixa);
await cancelarVenda(db, { vendaId: vendaTerminal.id, motivo: 'Troco errado, refeita', pinGerente: '2222' }, caixa);
const eventos = (await db.all('SELECT * FROM sync_saida ORDER BY criado_em_ms, rowid')).map((e) => ({
  id: e.id, tipo: e.tipo, versao: VERSAO_EVENTO, refId: e.ref_id, criadoEmMs: e.criado_em_ms, dadosJson: e.dados,
}));

const destino = new URL('../../tests/fixtures/', import.meta.url);
mkdirSync(destino, { recursive: true });
writeFileSync(new URL('pdv-mobile-backup-1.json', destino), JSON.stringify(dump1, null, 1));
writeFileSync(new URL('pdv-mobile-backup-2.json', destino), JSON.stringify(dump2, null, 1));
writeFileSync(new URL('pdv-mobile-terminal-eventos.json', destino), JSON.stringify({
  installId: INSTALL, corteMs: dump1.geradoEmMs, geradoBackup2EmMs: dump2.geradoEmMs, eventosDoAtraso: atraso, eventos,
}, null, 1));
console.log('fixtures gravadas em', destino.pathname, `(${eventos.length} eventos, ${atraso} do atraso)`);
