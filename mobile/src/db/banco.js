// Camada fina por cima do SQLite -- o mesmo código de regra de negócio
// roda no celular (driver nativo do @capacitor-community/sqlite) e no
// navegador/testes (driver sql.js), porque os dois falam esta mesma
// interface assíncrona:
//
//   driver.exec(sql)            -> várias instruções, sem retorno
//   driver.run(sql, params)     -> { changes }
//   driver.all(sql, params)     -> [ { coluna: valor } ]
//
// Uma conexão só, e o driver nativo é assíncrono: duas operações
// disparadas "ao mesmo tempo" podiam se intercalar e uma leitura de
// fora cair no meio da transação de outra (vendo dado ainda não
// confirmado, ou pior, sendo desfeita junto num ROLLBACK). Por isso TUDO
// passa por uma fila única. Dentro de `transacao(fn)`, use só o `tx`
// recebido -- chamar `banco.*` lá dentro esperaria a própria transação
// terminar (trava). Os serviços recebem "db" e funcionam tanto com o
// Banco quanto com um Tx, porque os dois têm a mesma cara.

function normalizarParams(params) {
  if (!params) return [];
  return params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
}

class Consultas {
  async get(sql, params) {
    const linhas = await this.all(sql, params);
    return linhas[0];
  }

  async valor(sql, params) {
    const linha = await this.get(sql, params);
    return linha ? Object.values(linha)[0] : undefined;
  }
}

export class Tx extends Consultas {
  constructor(driver) {
    super();
    this.driver = driver;
  }

  exec(sql) { return this.driver.exec(sql); }
  run(sql, params) { return this.driver.run(sql, normalizarParams(params)); }
  all(sql, params) { return this.driver.all(sql, normalizarParams(params)); }
  // Transação aninhada = a mesma transação (SQLite não aninha BEGIN).
  transacao(fn) { return fn(this); }
}

export class Banco extends Consultas {
  #fila = Promise.resolve();

  constructor(driver) {
    super();
    this.driver = driver;
    this.aoAlterar = null; // callback opcional (driver web persiste depois de escrever)
  }

  #enfileirar(fn) {
    const p = this.#fila.then(() => fn());
    this.#fila = p.catch(() => {});
    return p;
  }

  exec(sql) {
    return this.#enfileirar(async () => { await this.driver.exec(sql); this.#alterou(); });
  }

  run(sql, params) {
    return this.#enfileirar(async () => {
      const r = await this.driver.run(sql, normalizarParams(params));
      this.#alterou();
      return r;
    });
  }

  all(sql, params) {
    return this.#enfileirar(() => this.driver.all(sql, normalizarParams(params)));
  }

  transacao(fn) {
    return this.#enfileirar(async () => {
      await this.driver.exec('BEGIN IMMEDIATE');
      try {
        const resultado = await fn(new Tx(this.driver));
        await this.driver.exec('COMMIT');
        this.#alterou();
        return resultado;
      } catch (err) {
        try { await this.driver.exec('ROLLBACK'); } catch { /* conexão já sem transação */ }
        throw err;
      }
    });
  }

  /** Roda `fn` com acesso exclusivo à conexão, sem abrir transação (restauração de backup precisa mexer em PRAGMA fora de transação). */
  exclusivo(fn) {
    return this.#enfileirar(async () => {
      const r = await fn(new Tx(this.driver));
      this.#alterou();
      return r;
    });
  }

  #alterou() {
    if (this.aoAlterar) {
      try { this.aoAlterar(); } catch { /* persistência é melhor esforço */ }
    }
  }

  close() { return this.#enfileirar(() => this.driver.close()); }
}
