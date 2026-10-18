// Driver sql.js (SQLite compilado pra WebAssembly) -- usado nos testes
// (Node) e no modo navegador (preview/demonstração). NUNCA no celular:
// lá o banco é o SQLite nativo (driverCapacitor.js), gravado em disco.

export async function criarDriverSqlJs({ initSqlJs, bytes = null, locateFile } = {}) {
  const init = initSqlJs || (await import('sql.js')).default;
  const SQL = await init(locateFile ? { locateFile } : undefined);
  const db = bytes ? new SQL.Database(bytes) : new SQL.Database();

  return {
    tipo: 'sqljs',
    async exec(sql) { db.exec(sql); },
    async run(sql, params) {
      db.run(sql, params);
      return { changes: db.getRowsModified() };
    },
    async all(sql, params) {
      const st = db.prepare(sql);
      try {
        if (params && params.length) st.bind(params);
        const linhas = [];
        while (st.step()) linhas.push(st.getAsObject());
        return linhas;
      } finally {
        st.free();
      }
    },
    exportar() { return db.export(); },
    async close() { db.close(); },
  };
}
