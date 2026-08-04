const { getDb } = require('../db/database');

function getConfig() {
  const db = getDb();
  return db.prepare('SELECT * FROM pos_display_config WHERE id = ?').get('default');
}

function updateConfig({ modoBusca, modoVendidosRecentes, qtdVendidosRecentes, tamanhoBlocos }) {
  const db = getDb();
  const atual = getConfig();
  db.prepare(
    `UPDATE pos_display_config SET modo_busca = ?, modo_vendidos_recentes = ?, qtd_vendidos_recentes = ?, tamanho_blocos = ? WHERE id = ?`
  ).run(
    modoBusca !== undefined ? modoBusca : atual.modo_busca,
    modoVendidosRecentes !== undefined ? modoVendidosRecentes : atual.modo_vendidos_recentes,
    qtdVendidosRecentes !== undefined ? qtdVendidosRecentes : atual.qtd_vendidos_recentes,
    tamanhoBlocos !== undefined ? tamanhoBlocos : atual.tamanho_blocos,
    'default'
  );
  return { ok: true };
}

module.exports = { getConfig, updateConfig };
