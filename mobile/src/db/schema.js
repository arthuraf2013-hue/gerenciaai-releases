// Schema do PDV mobile autônomo, em migrações numeradas (PRAGMA
// user_version). Regra: migração publicada NUNCA muda -- correção é
// sempre uma migração nova no fim da lista.
//
// Decisões que valem pra tabela nenhuma fugir delas:
// - Dinheiro em CENTAVOS inteiros (`*_centavos`). Sem float em valor:
//   0,1 + 0,2 não pode virar 0,30000000000000004 num fechamento de caixa.
// - Quantidade em MILÉSIMOS inteiros (`qtd_mil`): 1 un = 1000, 0,750 kg
//   = 750. Mesmo motivo.
// - ID = UUID gerado no aparelho; datas em ISO 8601 UTC. Pensado pra
//   migração futura pro GerenciaAI do computador: importar duas vezes não
//   duplica nada (mesmo ID), e `dispositivo_id` diz de qual celular cada
//   registro veio.
// - Estoque é LIVRO (movimentos_estoque) + saldo em cache
//   (produtos.estoque_mil) atualizado na MESMA transação. O livro é a
//   verdade auditável; o cache é pra tela não somar tudo a cada toque.
//   Mesma ideia pro fiado (fiado_lancamentos + clientes.saldo_fiado_centavos).

export const MIGRACOES = [
  // 1 -- estrutura inicial
  `
  CREATE TABLE config (
    chave TEXT PRIMARY KEY,
    valor TEXT
  );

  CREATE TABLE usuarios (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    papel TEXT NOT NULL CHECK (papel IN ('admin', 'gerente', 'operador')),
    pin_hash TEXT NOT NULL,
    pin_salt TEXT NOT NULL,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL,
    dispositivo_id TEXT
  );

  CREATE TABLE produtos (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    nome_busca TEXT NOT NULL,
    codigo_barras TEXT UNIQUE,
    categoria TEXT,
    unidade TEXT NOT NULL DEFAULT 'un' CHECK (unidade IN ('un', 'kg')),
    preco_centavos INTEGER NOT NULL CHECK (preco_centavos >= 0),
    custo_centavos INTEGER NOT NULL DEFAULT 0 CHECK (custo_centavos >= 0),
    estoque_mil INTEGER NOT NULL DEFAULT 0,
    estoque_minimo_mil INTEGER NOT NULL DEFAULT 0,
    controla_estoque INTEGER NOT NULL DEFAULT 1,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL,
    atualizado_em TEXT NOT NULL,
    dispositivo_id TEXT
  );
  CREATE INDEX idx_produtos_busca ON produtos(ativo, nome_busca);

  CREATE TABLE movimentos_estoque (
    id TEXT PRIMARY KEY,
    produto_id TEXT NOT NULL REFERENCES produtos(id),
    tipo TEXT NOT NULL CHECK (tipo IN ('inicial', 'entrada', 'ajuste', 'venda', 'cancelamento_venda')),
    qtd_mil INTEGER NOT NULL,
    motivo TEXT,
    venda_id TEXT,
    usuario_id TEXT,
    criado_em TEXT NOT NULL,
    dispositivo_id TEXT
  );
  CREATE INDEX idx_mov_produto ON movimentos_estoque(produto_id, criado_em);

  CREATE TABLE clientes (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    nome_busca TEXT NOT NULL,
    telefone TEXT,
    documento TEXT,
    saldo_fiado_centavos INTEGER NOT NULL DEFAULT 0,
    limite_fiado_centavos INTEGER,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL,
    atualizado_em TEXT NOT NULL,
    dispositivo_id TEXT
  );
  CREATE INDEX idx_clientes_busca ON clientes(ativo, nome_busca);

  CREATE TABLE caixas (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('aberto', 'fechado')),
    aberto_por TEXT NOT NULL,
    aberto_em TEXT NOT NULL,
    valor_abertura_centavos INTEGER NOT NULL DEFAULT 0,
    fechado_por TEXT,
    fechado_em TEXT,
    valor_esperado_centavos INTEGER,
    valor_contado_centavos INTEGER,
    observacao TEXT,
    dispositivo_id TEXT
  );
  -- No máximo UM caixa aberto por vez (índice parcial único).
  CREATE UNIQUE INDEX idx_um_caixa_aberto ON caixas(status) WHERE status = 'aberto';

  CREATE TABLE caixa_movimentos (
    id TEXT PRIMARY KEY,
    caixa_id TEXT NOT NULL REFERENCES caixas(id),
    tipo TEXT NOT NULL CHECK (tipo IN ('sangria', 'suprimento')),
    valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
    motivo TEXT,
    usuario_id TEXT NOT NULL,
    criado_em TEXT NOT NULL,
    dispositivo_id TEXT
  );

  CREATE TABLE vendas (
    id TEXT PRIMARY KEY,
    numero TEXT NOT NULL UNIQUE,
    caixa_id TEXT NOT NULL REFERENCES caixas(id),
    operador_id TEXT NOT NULL,
    cliente_id TEXT REFERENCES clientes(id),
    status TEXT NOT NULL CHECK (status IN ('finalizada', 'cancelada')),
    subtotal_centavos INTEGER NOT NULL,
    desconto_centavos INTEGER NOT NULL DEFAULT 0,
    total_centavos INTEGER NOT NULL,
    troco_centavos INTEGER NOT NULL DEFAULT 0,
    desconto_autorizado_por TEXT,
    criado_em TEXT NOT NULL,
    cancelada_em TEXT,
    cancelada_por TEXT,
    motivo_cancelamento TEXT,
    dispositivo_id TEXT
  );
  CREATE INDEX idx_vendas_data ON vendas(criado_em);
  CREATE INDEX idx_vendas_caixa ON vendas(caixa_id);

  CREATE TABLE venda_itens (
    id TEXT PRIMARY KEY,
    venda_id TEXT NOT NULL REFERENCES vendas(id),
    produto_id TEXT NOT NULL REFERENCES produtos(id),
    nome TEXT NOT NULL,
    unidade TEXT NOT NULL,
    preco_unit_centavos INTEGER NOT NULL,
    qtd_mil INTEGER NOT NULL CHECK (qtd_mil > 0),
    total_centavos INTEGER NOT NULL
  );
  CREATE INDEX idx_itens_venda ON venda_itens(venda_id);
  CREATE INDEX idx_itens_produto ON venda_itens(produto_id);

  CREATE TABLE pagamentos (
    id TEXT PRIMARY KEY,
    venda_id TEXT NOT NULL REFERENCES vendas(id),
    metodo TEXT NOT NULL CHECK (metodo IN ('dinheiro', 'credito', 'debito', 'pix', 'fiado')),
    valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
    recebido_centavos INTEGER
  );
  CREATE INDEX idx_pag_venda ON pagamentos(venda_id);

  CREATE TABLE fiado_lancamentos (
    id TEXT PRIMARY KEY,
    cliente_id TEXT NOT NULL REFERENCES clientes(id),
    tipo TEXT NOT NULL CHECK (tipo IN ('compra', 'pagamento', 'estorno')),
    valor_centavos INTEGER NOT NULL,
    metodo TEXT,
    venda_id TEXT,
    caixa_id TEXT,
    usuario_id TEXT,
    criado_em TEXT NOT NULL,
    dispositivo_id TEXT
  );
  CREATE INDEX idx_fiado_cliente ON fiado_lancamentos(cliente_id, criado_em);
  CREATE INDEX idx_fiado_caixa ON fiado_lancamentos(caixa_id);

  CREATE TABLE auditoria (
    id TEXT PRIMARY KEY,
    acao TEXT NOT NULL,
    detalhes TEXT,
    usuario_id TEXT,
    criado_em TEXT NOT NULL
  );
  CREATE INDEX idx_auditoria_data ON auditoria(criado_em);
  `,

  // 2 -- modo TERMINAL (celular vinculado ao GerenciaAI de um computador,
  // ver services/terminal.js): fila de saída dos fatos que o computador
  // precisa receber. Cada linha é um retrato IMUTÁVEL do fato no momento
  // em que aconteceu (a venda como foi, com itens, pagamentos e
  // movimentos), gravado na MESMA transação da venda -- se a venda
  // existe aqui, o evento dela existe também, com ou sem internet.
  // Fica FORA do backup (é do aparelho, como a licença).
  `
  CREATE TABLE sync_saida (
    id TEXT PRIMARY KEY,
    tipo TEXT NOT NULL CHECK (tipo IN ('venda', 'venda_cancelada', 'fiado_pagamento', 'cliente', 'estoque')),
    ref_id TEXT NOT NULL,
    dados TEXT NOT NULL,
    criado_em TEXT NOT NULL,
    criado_em_ms INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'enviado', 'aplicado', 'ignorado', 'erro')),
    erro TEXT,
    resultado TEXT,
    tentativas INTEGER NOT NULL DEFAULT 0,
    enviado_em TEXT,
    confirmado_em TEXT
  );
  CREATE INDEX idx_sync_saida_status ON sync_saida(status, criado_em_ms);
  CREATE INDEX idx_sync_saida_ref ON sync_saida(ref_id);
  `,
];

export const VERSAO_SCHEMA = MIGRACOES.length;

// Ordem que respeita as chaves estrangeiras -- usada pelo backup
// (restaura pais antes de filhos) e pela futura migração pro desktop.
export const TABELAS_EM_ORDEM = [
  'config', 'usuarios', 'produtos', 'clientes', 'caixas', 'caixa_movimentos',
  'vendas', 'venda_itens', 'pagamentos', 'movimentos_estoque', 'fiado_lancamentos', 'auditoria',
];

export async function migrar(banco) {
  const atual = Number(await banco.valor('PRAGMA user_version')) || 0;
  if (atual > VERSAO_SCHEMA) {
    throw new Error(`O banco deste aparelho é de uma versão mais nova do app (schema ${atual}, app conhece até ${VERSAO_SCHEMA}). Atualize o app.`);
  }
  for (let v = atual; v < VERSAO_SCHEMA; v++) {
    await banco.transacao(async (tx) => {
      await tx.exec(MIGRACOES[v]);
      await tx.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
