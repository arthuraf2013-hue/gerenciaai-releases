// Driver do celular: SQLite nativo do Android via
// @capacitor-community/sqlite, arquivo em disco no armazenamento interno
// do app (o sistema não apaga, diferente do armazenamento do navegador).
//
// `transaction = false` em todas as chamadas: quem controla transação é
// o Banco (BEGIN/COMMIT explícitos) -- se o plugin abrisse a dele em cada
// comando, um BEGIN nosso viraria transação aninhada e daria erro.

const NOME_BANCO = 'gerenciaai';

export async function criarDriverCapacitor() {
  const { CapacitorSQLite, SQLiteConnection } = await import('@capacitor-community/sqlite');
  const sqlite = new SQLiteConnection(CapacitorSQLite);

  const consistencia = await sqlite.checkConnectionsConsistency().catch(() => null);
  const existe = (await sqlite.isConnection(NOME_BANCO, false)).result;
  const conn = consistencia?.result && existe
    ? await sqlite.retrieveConnection(NOME_BANCO, false)
    : await sqlite.createConnection(NOME_BANCO, false, 'no-encryption', 1, false);
  await conn.open();

  return {
    tipo: 'capacitor',
    async exec(sql) { await conn.execute(sql, false); },
    async run(sql, params) {
      const r = await conn.run(sql, params, false);
      return { changes: r?.changes?.changes ?? 0 };
    },
    async all(sql, params) {
      const r = await conn.query(sql, params);
      return r?.values ?? [];
    },
    async close() {
      await conn.close();
      await sqlite.closeConnection(NOME_BANCO, false);
    },
  };
}
