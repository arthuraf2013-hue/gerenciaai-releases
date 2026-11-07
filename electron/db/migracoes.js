/**
 * Migrações VERSIONADAS do banco (ERP, terceira leva em diante).
 *
 * Até aqui o banco evoluía só por schema.sql (CREATE ... IF NOT EXISTS) +
 * adicionarColunaSeFaltando em database.js -- aditivo e idempotente, mas
 * sem registro do que foi aplicado nem caminho de volta. Daqui pra frente,
 * cada mudança de banco entra como uma migração numerada:
 *
 *   - `up(db)`   aplica (precisa ser idempotente: o banco pode já ter parte
 *                da mudança, ex. instalação que recebeu um build de teste);
 *   - `down(db)` desfaz (usado por suporte/testes; nunca automático);
 *   - tudo dentro de UMA transação por migração, e a versão aplicada fica
 *     em `schema_migrations` (com data), então nunca roda duas vezes.
 *
 * Regras (as mesmas do resto do banco): datas pelo NOW_SYNCED(), dinheiro
 * em reais arredondados (REAL), nada destrutivo no `up`. O schema.sql NÃO
 * repete o que está aqui -- a migração é a única fonte dessas tabelas e
 * colunas (assim o `down` é honesto: o que ele remove não volta sozinho).
 */

const SQL_TABELA = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    versao      INTEGER PRIMARY KEY,
    nome        TEXT NOT NULL,
    aplicada_em TEXT NOT NULL DEFAULT (NOW_SYNCED())
  );`;

function colunas(db, tabela) {
  return db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
}
function addColuna(db, tabela, coluna, definicao) {
  if (!colunas(db, tabela).includes(coluna)) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
}
function dropColuna(db, tabela, coluna) {
  if (colunas(db, tabela).includes(coluna)) db.exec(`ALTER TABLE ${tabela} DROP COLUMN ${coluna}`);
}

// Naturezas de operação semeadas (código fixo, editáveis só pela migração
// seguinte). CFOP dentro do estado / para outro estado, sem e com ST já
// retida. Fonte: tabela CFOP (Convênio s/nº 1970 + Ajustes SINIEF) --
// ver docs/ERP-FISCAL-RULES.md §2. finalidade = finNFe (1 normal, 4 devolução).
const NATUREZAS = [
  // codigo, nome, tipo, finalidade, interno, interestadual, interno ST, interestadual ST
  ['venda_revenda', 'Venda de mercadoria comprada de terceiros', 'saida', 1, '5102', '6102', '5405', '6404'],
  ['venda_producao', 'Venda de produção própria', 'saida', 1, '5101', '6101', null, null],
  ['venda_nao_contribuinte_outra_uf', 'Venda a consumidor final não contribuinte de outra UF', 'saida', 1, null, '6108', null, null],
  ['devolucao_compra', 'Devolução de compra ao fornecedor', 'saida', 4, '5202', '6202', '5411', '6411'],
  ['devolucao_venda', 'Devolução de venda (entrada do cliente)', 'entrada', 4, '1202', '2202', '1411', '2411'],
  ['transferencia', 'Transferência entre filiais', 'saida', 1, '5152', '6152', '5409', '6409'],
  ['remessa_conserto', 'Remessa para conserto ou reparo', 'saida', 1, '5915', '6915', null, null],
  ['retorno_conserto', 'Retorno de conserto ou reparo (entrada)', 'entrada', 1, '1916', '2916', null, null],
  ['bonificacao', 'Bonificação, doação ou brinde', 'saida', 1, '5910', '6910', null, null],
  ['compra_revenda', 'Compra para revenda (entrada)', 'entrada', 1, '1102', '2102', '1403', '2403'],
  ['outra_saida', 'Outra saída não especificada', 'saida', 1, '5949', '6949', null, null],
];

const MIGRACOES = [
  {
    versao: 1,
    nome: 'erp-terceira-leva: caixa, baixa parcial, contabilidade, naturezas, auditoria imutável',
    up(db) {
      // Simples Nacional: anexo da atividade principal + folha (fator R).
      addColuna(db, 'erp_config', 'anexo_simples', "TEXT DEFAULT 'I'");
      addColuna(db, 'erp_config', 'folha_12_meses', 'REAL');
      // Desconto que o operador pode dar sem autorização (% da venda).
      addColuna(db, 'security_config', 'limite_desconto_operador', 'REAL');
      // Fiado: limite por cliente e bloqueio.
      addColuna(db, 'customers', 'limite_fiado', 'REAL');
      addColuna(db, 'customers', 'fiado_bloqueado', 'INTEGER NOT NULL DEFAULT 0');
      // Caixa: conferência por forma de pagamento no fechamento.
      addColuna(db, 'cash_sessions', 'conferencia_json', 'TEXT');
      // Baixa com juros/multa/desconto e baixa parcial (o saldo vira outra conta).
      for (const t of ['receivables', 'expenses']) {
        addColuna(db, t, 'juros', 'REAL');
        addColuna(db, t, 'multa', 'REAL');
        addColuna(db, t, 'desconto', 'REAL');
        addColuna(db, t, 'parcial_de_id', 'TEXT');
      }
      addColuna(db, 'expenses', 'valor_original', 'REAL');
      // Auditoria com antes/depois.
      addColuna(db, 'audit_log', 'entidade', 'TEXT');
      addColuna(db, 'audit_log', 'entidade_id', 'TEXT');
      addColuna(db, 'audit_log', 'dados_antes', 'TEXT');
      addColuna(db, 'audit_log', 'dados_depois', 'TEXT');

      db.exec(`
        CREATE TABLE IF NOT EXISTS cash_movements (
          id               TEXT PRIMARY KEY,
          cash_session_id  TEXT NOT NULL REFERENCES cash_sessions(id),
          tipo             TEXT NOT NULL CHECK (tipo IN ('sangria','suprimento')),
          valor            REAL NOT NULL CHECK (valor > 0),
          motivo           TEXT,
          operador_id      TEXT NOT NULL REFERENCES users(id),
          autorizado_por_id TEXT REFERENCES users(id),
          criado_em        TEXT NOT NULL DEFAULT (NOW_SYNCED())
        );
        CREATE INDEX IF NOT EXISTS idx_cash_movements_sessao ON cash_movements(cash_session_id);

        -- Lançamentos contábeis manuais (partidas dobradas, um par por linha).
        -- Nunca se apaga nem altera: corrige-se com estorno (linha inversa).
        CREATE TABLE IF NOT EXISTS journal_entries (
          id             TEXT PRIMARY KEY,
          location_id    TEXT NOT NULL REFERENCES locations(id),
          data           TEXT NOT NULL,            -- AAAA-MM-DD
          debito         TEXT NOT NULL,            -- chave do plano (accounting_map)
          credito        TEXT NOT NULL,
          valor          REAL NOT NULL CHECK (valor > 0),
          historico      TEXT NOT NULL,
          estorno_de_id  TEXT REFERENCES journal_entries(id),
          operador_id    TEXT NOT NULL REFERENCES users(id),
          criado_em      TEXT NOT NULL DEFAULT (NOW_SYNCED()),
          CHECK (debito <> credito)
        );
        CREATE INDEX IF NOT EXISTS idx_journal_entries_data ON journal_entries(location_id, data);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_estorno ON journal_entries(estorno_de_id) WHERE estorno_de_id IS NOT NULL;

        -- Mês contábil fechado: guarda a foto dos lançamentos e trava
        -- alterações com data no mês (despesas, contas a receber, manuais).
        CREATE TABLE IF NOT EXISTS accounting_periods (
          location_id     TEXT NOT NULL REFERENCES locations(id),
          competencia     TEXT NOT NULL,           -- AAAA-MM
          fechado_em      TEXT NOT NULL DEFAULT (NOW_SYNCED()),
          fechado_por_id  TEXT NOT NULL REFERENCES users(id),
          snapshot_json   TEXT NOT NULL,
          PRIMARY KEY (location_id, competencia)
        );

        CREATE TABLE IF NOT EXISTS natureza_operacao (
          codigo                  TEXT PRIMARY KEY,
          nome                    TEXT NOT NULL,
          tipo                    TEXT NOT NULL CHECK (tipo IN ('entrada','saida')),
          finalidade              INTEGER NOT NULL DEFAULT 1,
          cfop_interno            TEXT,
          cfop_interestadual      TEXT,
          cfop_interno_st         TEXT,
          cfop_interestadual_st   TEXT,
          fonte                   TEXT NOT NULL DEFAULT 'Tabela CFOP (Convênio s/nº 1970) e Ajustes SINIEF'
        );

        -- Auditoria e lançamentos são só de inclusão.
        CREATE TRIGGER IF NOT EXISTS trg_audit_log_sem_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'A auditoria não pode ser alterada.'); END;
        CREATE TRIGGER IF NOT EXISTS trg_audit_log_sem_delete BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'A auditoria não pode ser apagada.'); END;
        CREATE TRIGGER IF NOT EXISTS trg_journal_entries_sem_update BEFORE UPDATE ON journal_entries
        BEGIN SELECT RAISE(ABORT, 'Lançamento contábil não se altera: faça um estorno.'); END;
        CREATE TRIGGER IF NOT EXISTS trg_journal_entries_sem_delete BEFORE DELETE ON journal_entries
        BEGIN SELECT RAISE(ABORT, 'Lançamento contábil não se apaga: faça um estorno.'); END;
        CREATE TRIGGER IF NOT EXISTS trg_cash_movements_sem_update BEFORE UPDATE ON cash_movements
        BEGIN SELECT RAISE(ABORT, 'Sangria/suprimento não se altera.'); END;
        CREATE TRIGGER IF NOT EXISTS trg_cash_movements_sem_delete BEFORE DELETE ON cash_movements
        BEGIN SELECT RAISE(ABORT, 'Sangria/suprimento não se apaga.'); END;
      `);
      const ins = db.prepare(
        `INSERT OR IGNORE INTO natureza_operacao (codigo, nome, tipo, finalidade, cfop_interno, cfop_interestadual, cfop_interno_st, cfop_interestadual_st)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const n of NATUREZAS) ins.run(...n);
    },
    down(db) {
      db.exec(`
        DROP TRIGGER IF EXISTS trg_audit_log_sem_update;
        DROP TRIGGER IF EXISTS trg_audit_log_sem_delete;
        DROP TRIGGER IF EXISTS trg_journal_entries_sem_update;
        DROP TRIGGER IF EXISTS trg_journal_entries_sem_delete;
        DROP TRIGGER IF EXISTS trg_cash_movements_sem_update;
        DROP TRIGGER IF EXISTS trg_cash_movements_sem_delete;
        DROP TABLE IF EXISTS natureza_operacao;
        DROP TABLE IF EXISTS accounting_periods;
        DROP TABLE IF EXISTS journal_entries;
        DROP TABLE IF EXISTS cash_movements;
      `);
      for (const c of ['dados_depois', 'dados_antes', 'entidade_id', 'entidade']) dropColuna(db, 'audit_log', c);
      dropColuna(db, 'expenses', 'valor_original');
      for (const t of ['receivables', 'expenses']) for (const c of ['parcial_de_id', 'desconto', 'multa', 'juros']) dropColuna(db, t, c);
      dropColuna(db, 'cash_sessions', 'conferencia_json');
      dropColuna(db, 'customers', 'fiado_bloqueado');
      dropColuna(db, 'customers', 'limite_fiado');
      dropColuna(db, 'security_config', 'limite_desconto_operador');
      dropColuna(db, 'erp_config', 'folha_12_meses');
      dropColuna(db, 'erp_config', 'anexo_simples');
    },
  },
  {
    versao: 2,
    nome: 'vitrine de demonstração: canal do pedido em bot_orders',
    // Pedido que chega por um canal com identificador próprio (hoje só a
    // vitrine de demonstração, ver vitrineDemoService.js). `canal_ref` é o
    // id do documento de origem: o índice único impede o mesmo pedido de
    // entrar duas vezes. `origem` continua no CHECK antigo ('manual') --
    // mudar o CHECK exigiria reconstruir a tabela.
    up(db) {
      addColuna(db, 'bot_orders', 'canal', 'TEXT');
      addColuna(db, 'bot_orders', 'canal_ref', 'TEXT');
      addColuna(db, 'bot_orders', 'vitrine_slug', 'TEXT');
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_orders_canal_ref ON bot_orders(canal, canal_ref) WHERE canal_ref IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_bot_orders_vitrine_slug ON bot_orders(vitrine_slug) WHERE vitrine_slug IS NOT NULL;
      `);
    },
    down(db) {
      db.exec(`
        DROP INDEX IF EXISTS idx_bot_orders_vitrine_slug;
        DROP INDEX IF EXISTS idx_bot_orders_canal_ref;
      `);
      for (const c of ['vitrine_slug', 'canal_ref', 'canal']) dropColuna(db, 'bot_orders', c);
    },
  },
  {
    versao: 3,
    nome: 'restaurante: mesas unidas e nomes das pessoas da comanda',
    up(db) {
      // Mesa unida aponta para a principal do grupo (ver tableService.juntarMesas).
      // Sem REFERENCES de propósito: o SQLite não deixa o down() remover uma
      // coluna citada numa chave estrangeira.
      addColuna(db, 'restaurant_tables', 'unida_a_mesa_id', 'TEXT');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_restaurant_tables_unida ON restaurant_tables(unida_a_mesa_id);
        CREATE TABLE IF NOT EXISTS sale_people (
          id        TEXT PRIMARY KEY,
          sale_id   TEXT NOT NULL REFERENCES sales(id),
          numero    INTEGER NOT NULL CHECK (numero >= 1),
          nome      TEXT,
          criado_em TEXT NOT NULL DEFAULT (NOW_SYNCED()),
          UNIQUE (sale_id, numero)
        );
      `);
    },
    down(db) {
      db.exec(`
        DROP TABLE IF EXISTS sale_people;
        DROP INDEX IF EXISTS idx_restaurant_tables_unida;
      `);
      dropColuna(db, 'restaurant_tables', 'unida_a_mesa_id');
    },
  },
  {
    versao: 4,
    nome: 'restaurante: mesas de cada venda guardadas para o histórico',
    up(db) {
      // Ao fechar a conta, a mesa limpa o sale_id -- sem isto a venda não
      // lembra de qual mesa veio. Foto tirada na finalização (saleService.
      // registrarMesasDaVenda), com a principal e as unidas.
      db.exec(`
        CREATE TABLE IF NOT EXISTS sale_mesas (
          id        TEXT PRIMARY KEY,
          sale_id   TEXT NOT NULL REFERENCES sales(id),
          table_id  TEXT,
          numero    TEXT NOT NULL,
          nome      TEXT,
          principal INTEGER NOT NULL DEFAULT 0,
          criado_em TEXT NOT NULL DEFAULT (NOW_SYNCED()),
          UNIQUE (sale_id, table_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sale_mesas_sale ON sale_mesas(sale_id);
      `);
    },
    down(db) {
      db.exec(`
        DROP INDEX IF EXISTS idx_sale_mesas_sale;
        DROP TABLE IF EXISTS sale_mesas;
      `);
    },
  },
  {
    versao: 5,
    nome: 'celular: comandos da mesa (garçom/operador) e chave para o PIN de autorização',
    up(db) {
      // Cada comando do celular (lançar itens, pessoas, mover, cancelar,
      // juntar, receber...) vale UMA vez: o resultado fica aqui, na mesma
      // transação do que ele mudou (ver mesaCelularService.js). Reentrega do
      // Firestore devolve o resultado guardado em vez de aplicar de novo.
      //
      // celular_chaves: par RSA gerado neste computador. A pública vai para o
      // celular, que cifra com ela o PIN do gerente antes de gravar no
      // Firestore; só este computador abre (a privada nunca sai daqui).
      db.exec(`
        CREATE TABLE IF NOT EXISTS mobile_comandos_mesa (
          id         TEXT PRIMARY KEY,
          device_id  TEXT NOT NULL,
          usuario_id TEXT,
          tipo       TEXT NOT NULL,
          table_id   TEXT,
          sale_id    TEXT,
          ok         INTEGER NOT NULL DEFAULT 0,
          resultado  TEXT,
          erro       TEXT,
          criado_em  TEXT NOT NULL DEFAULT (NOW_SYNCED())
        );
        CREATE INDEX IF NOT EXISTS idx_mobile_comandos_mesa_device ON mobile_comandos_mesa(device_id, criado_em);
        CREATE TABLE IF NOT EXISTS celular_chaves (
          id            TEXT PRIMARY KEY,
          chave_publica TEXT NOT NULL,
          chave_privada TEXT NOT NULL,
          criado_em     TEXT NOT NULL DEFAULT (NOW_SYNCED())
        );
      `);
    },
    down(db) {
      db.exec(`
        DROP INDEX IF EXISTS idx_mobile_comandos_mesa_device;
        DROP TABLE IF EXISTS mobile_comandos_mesa;
        DROP TABLE IF EXISTS celular_chaves;
      `);
    },
  },
  {
    versao: 6,
    nome: 'ficha do cliente: especificações do produto guardadas no item vendido',
    up(db) {
      // A ficha do cliente mostra, em cada compra, as especificações do
      // produto (grau e tipo de lente na ótica, tamanho e cor na loja de
      // roupas, lote na farmácia...). Elas moram em products.custom_fields,
      // que pode ser editado depois -- por isso o item vendido guarda uma
      // CÓPIA de como estavam na hora da venda. Mesmo jeito do custo
      // (trg_sale_items_custo): gatilho AFTER INSERT, vale para todo caminho
      // que cria item (balcão, mesa, celular, bot). '{}' = produto sem
      // especificação; NULL = item de antes desta migração (a ficha usa o
      // cadastro atual e avisa). Nada antigo é preenchido: não dá para saber
      // como o produto estava no dia.
      addColuna(db, 'sale_items', 'especificacoes_json', 'TEXT');
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_sale_items_especificacoes AFTER INSERT ON sale_items
        WHEN NEW.especificacoes_json IS NULL
        BEGIN
          UPDATE sale_items SET especificacoes_json = COALESCE(
            (SELECT CASE WHEN json_valid(custom_fields) THEN custom_fields ELSE '{}' END FROM products WHERE id = NEW.product_id),
            '{}')
          WHERE id = NEW.id;
        END;
      `);
    },
    down(db) {
      db.exec('DROP TRIGGER IF EXISTS trg_sale_items_especificacoes;');
      dropColuna(db, 'sale_items', 'especificacoes_json');
    },
  },
  {
    versao: 7,
    nome: 'pessoa da mesa vinculada a um cliente do cadastro',
    up(db) {
      // A pessoa da comanda (sale_people) pode ser um cliente cadastrado: o
      // consumo dela entra na ficha desse cliente (fichaClienteService), sem
      // mexer no cliente da VENDA (sales.customer_id, que é de quem paga:
      // fiado e pontos continuam nele). Ver tableService.vincularClientePessoa.
      addColuna(db, 'sale_people', 'customer_id', 'TEXT REFERENCES customers(id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sale_people_customer ON sale_people(customer_id);');
    },
    down(db) {
      db.exec('DROP INDEX IF EXISTS idx_sale_people_customer;');
      dropColuna(db, 'sale_people', 'customer_id');
    },
  },
  {
    versao: 8,
    nome: 'restaurante: impressora da cozinha, senhas e painel de chamada, pedido pelo QR da mesa, maquininha',
    up(db) {
      // ---- Impressora da cozinha (cozinhaService.js) ----
      // Separada da impressora do caixa (receipt_config). 'windows' = impressora
      // instalada (pelo nome); 'rede' = térmica ESC/POS em IP:porta, sem driver.
      // categorias_json NULL/[] = todo item vai pra cozinha.
      db.exec(`
        CREATE TABLE IF NOT EXISTS cozinha_impressao_config (
          id                 TEXT PRIMARY KEY DEFAULT 'default',
          ativa              INTEGER NOT NULL DEFAULT 0,
          tipo               TEXT NOT NULL DEFAULT 'windows' CHECK (tipo IN ('windows','rede')),
          impressora_windows TEXT,
          ip                 TEXT,
          porta              INTEGER NOT NULL DEFAULT 9100,
          largura_mm         INTEGER NOT NULL DEFAULT 80 CHECK (largura_mm IN (58,80)),
          codepage           TEXT NOT NULL DEFAULT 'cp860' CHECK (codepage IN ('cp860','cp850','sem_acento')),
          automatica         INTEGER NOT NULL DEFAULT 0,
          categorias_json    TEXT,
          copias             INTEGER NOT NULL DEFAULT 1 CHECK (copias BETWEEN 1 AND 3),
          cortar_papel       INTEGER NOT NULL DEFAULT 1,
          atualizado_por_id  TEXT REFERENCES users(id),
          atualizado_em      TEXT
        );
        -- Cada comanda que saiu (ou tentou sair) na cozinha, com o conteúdo
        -- exato: reimprimir sai igual, e a falha (impressora desligada) fica
        -- visível em vez de sumir.
        CREATE TABLE IF NOT EXISTS cozinha_impressoes (
          id            TEXT PRIMARY KEY,
          sale_id       TEXT,
          bot_order_id  TEXT,
          titulo        TEXT NOT NULL,
          conteudo_json TEXT NOT NULL,
          item_ids_json TEXT,
          status        TEXT NOT NULL CHECK (status IN ('impresso','falhou')),
          erro          TEXT,
          tentativas    INTEGER NOT NULL DEFAULT 1,
          criado_em     TEXT NOT NULL DEFAULT (NOW_SYNCED()),
          impresso_em   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_cozinha_impressoes_criado ON cozinha_impressoes(criado_em);
      `);

      // ---- Senhas e painel de chamada (chamadaService.js) ----
      // Numeração por dia LOCAL (timeService.hojeLocalISO). Uma senha por
      // venda do balcão e uma por pedido (Separação/vitrine) -- índices únicos.
      db.exec(`
        CREATE TABLE IF NOT EXISTS chamada_config (
          id                 TEXT PRIMARY KEY DEFAULT 'default',
          ativa              INTEGER NOT NULL DEFAULT 0,
          senha_no_balcao    INTEGER NOT NULL DEFAULT 0,
          painel_token       TEXT,
          modelo_json        TEXT,
          minutos_no_painel  INTEGER NOT NULL DEFAULT 15,
          ultimo_hash        TEXT,
          atualizado_por_id  TEXT REFERENCES users(id),
          atualizado_em      TEXT
        );
        CREATE TABLE IF NOT EXISTS chamadas (
          id             TEXT PRIMARY KEY,
          data_local     TEXT NOT NULL,
          numero         INTEGER NOT NULL,
          nome           TEXT,
          origem         TEXT NOT NULL CHECK (origem IN ('balcao','pedido','manual')),
          sale_id        TEXT,
          bot_order_id   TEXT,
          status         TEXT NOT NULL DEFAULT 'preparando' CHECK (status IN ('preparando','pronto','entregue','cancelada')),
          vezes_chamada  INTEGER NOT NULL DEFAULT 0,
          criado_por_id  TEXT,
          criado_em      TEXT NOT NULL DEFAULT (NOW_SYNCED()),
          pronto_em      TEXT,
          chamado_em     TEXT,
          entregue_em    TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_chamadas_dia_numero ON chamadas(data_local, numero);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_chamadas_sale ON chamadas(sale_id) WHERE sale_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_chamadas_pedido ON chamadas(bot_order_id) WHERE bot_order_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_chamadas_status ON chamadas(status, data_local);
      `);

      // ---- Pedido pela vitrine / QR da mesa (vitrinePedidoService.js) ----
      // pedidos_online: a página grava o pedido (o atendente confirma na
      // Separação) em vez de abrir o WhatsApp. qr_token: segredo de cada mesa
      // no link do QR (a página pública só recebe o hash, ver vitrineService).
      addColuna(db, 'vitrine_config', 'pedidos_online', 'INTEGER NOT NULL DEFAULT 0');
      addColuna(db, 'restaurant_tables', 'qr_token', 'TEXT');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tables_qr_token ON restaurant_tables(qr_token) WHERE qr_token IS NOT NULL;');
      // "Comer aqui" sem mesa (lanchonete): retira no balcão pela senha.
      addColuna(db, 'bot_orders', 'consumo_local', 'INTEGER NOT NULL DEFAULT 0');

      // ---- Maquininha integrada (maquininhaService.js) ----
      db.exec(`
        CREATE TABLE IF NOT EXISTS maquininha_config (
          id                   TEXT PRIMARY KEY DEFAULT 'default',
          ativa                INTEGER NOT NULL DEFAULT 0,
          provedor             TEXT NOT NULL DEFAULT 'mercadopago_point',
          usar_token_pix       INTEGER NOT NULL DEFAULT 1,
          token_enc            TEXT,
          terminal_id          TEXT,
          imprimir_no_terminal INTEGER NOT NULL DEFAULT 0,
          atualizado_por_id    TEXT REFERENCES users(id),
          atualizado_em        TEXT
        );
        CREATE TABLE IF NOT EXISTS maquininha_cobrancas (
          id                     TEXT PRIMARY KEY,
          sale_id                TEXT NOT NULL REFERENCES sales(id),
          provedor               TEXT NOT NULL,
          terminal_id            TEXT NOT NULL,
          valor                  REAL NOT NULL,
          tipo                   TEXT NOT NULL CHECK (tipo IN ('credito','debito','pix')),
          parcelas               INTEGER NOT NULL DEFAULT 1,
          status                 TEXT NOT NULL CHECK (status IN ('criando','pendente','pago','cancelado','expirado','falhou','estornado','pago_sem_venda','erro')),
          provedor_id            TEXT,
          provedor_pagamento_id  TEXT,
          -- Sem REFERENCES (igual pix_cobrancas): remover o pagamento não trava aqui.
          payment_id             TEXT,
          detalhes_json          TEXT,
          erro                   TEXT,
          cancelamento_pedido    INTEGER NOT NULL DEFAULT 0,
          ultima_consulta_ms     INTEGER,
          expira_em              TEXT NOT NULL,
          criado_por_id          TEXT REFERENCES users(id),
          criado_em              TEXT NOT NULL DEFAULT (NOW_SYNCED()),
          atualizado_em          TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_maquininha_cobrancas_status ON maquininha_cobrancas(status, expira_em);
        CREATE INDEX IF NOT EXISTS idx_maquininha_cobrancas_sale ON maquininha_cobrancas(sale_id);
      `);

      // ---- NFC-e: endereço da consulta por chave (infNFeSupl/urlChave) ----
      addColuna(db, 'fiscal_config', 'url_chave', 'TEXT');
    },
    down(db) {
      dropColuna(db, 'fiscal_config', 'url_chave');
      db.exec(`
        DROP INDEX IF EXISTS idx_maquininha_cobrancas_sale;
        DROP INDEX IF EXISTS idx_maquininha_cobrancas_status;
        DROP TABLE IF EXISTS maquininha_cobrancas;
        DROP TABLE IF EXISTS maquininha_config;
        DROP INDEX IF EXISTS idx_tables_qr_token;
        DROP INDEX IF EXISTS idx_chamadas_status;
        DROP INDEX IF EXISTS idx_chamadas_pedido;
        DROP INDEX IF EXISTS idx_chamadas_sale;
        DROP INDEX IF EXISTS idx_chamadas_dia_numero;
        DROP TABLE IF EXISTS chamadas;
        DROP TABLE IF EXISTS chamada_config;
        DROP INDEX IF EXISTS idx_cozinha_impressoes_criado;
        DROP TABLE IF EXISTS cozinha_impressoes;
        DROP TABLE IF EXISTS cozinha_impressao_config;
      `);
      dropColuna(db, 'bot_orders', 'consumo_local');
      dropColuna(db, 'restaurant_tables', 'qr_token');
      dropColuna(db, 'vitrine_config', 'pedidos_online');
    },
  },
  {
    versao: 9,
    nome: 'vitrine: pagamento antecipado por Pix no pedido do site',
    up(db) {
      // pix_online: a página oferece "pagar agora com Pix" (exige Pix
      // automático configurado). bot_orders.pagamento_online: '' = paga na
      // retirada / na conta da mesa; 'aguardando' = QR gerado, esperando o
      // cliente; 'pago'; 'expirado'. Pedido pago é aceito sozinho.
      addColuna(db, 'vitrine_config', 'pix_online', 'INTEGER NOT NULL DEFAULT 0');
      addColuna(db, 'bot_orders', 'pagamento_online', "TEXT NOT NULL DEFAULT ''");
      db.exec(`
        -- Cobrança Pix de um pedido do site (ainda não existe venda: a venda
        -- só nasce quando o pedido é concluído, ver botOrderService). Uma por
        -- pedido; o provedor/token são os do Pix automático.
        CREATE TABLE IF NOT EXISTS vitrine_pix_cobrancas (
          id                 TEXT PRIMARY KEY,
          bot_order_id       TEXT NOT NULL REFERENCES bot_orders(id),
          provedor           TEXT NOT NULL,
          provedor_id        TEXT,
          valor              REAL NOT NULL,
          status             TEXT NOT NULL CHECK (status IN ('criando','pendente','pago','cancelado','expirado','erro','estornar')),
          copia_e_cola       TEXT,
          valor_pago         REAL,
          expira_em          TEXT NOT NULL,
          pago_em            TEXT,
          ultima_consulta_ms INTEGER,
          erro               TEXT,
          criado_em          TEXT NOT NULL DEFAULT (NOW_SYNCED()),
          atualizado_em      TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_vitrine_pix_pedido ON vitrine_pix_cobrancas(bot_order_id);
        CREATE INDEX IF NOT EXISTS idx_vitrine_pix_status ON vitrine_pix_cobrancas(status, expira_em);
      `);
    },
    down(db) {
      db.exec(`
        DROP INDEX IF EXISTS idx_vitrine_pix_status;
        DROP INDEX IF EXISTS idx_vitrine_pix_pedido;
        DROP TABLE IF EXISTS vitrine_pix_cobrancas;
      `);
      dropColuna(db, 'bot_orders', 'pagamento_online');
      dropColuna(db, 'vitrine_config', 'pix_online');
    },
  },
];

function versoesAplicadas(db) {
  db.exec(SQL_TABELA);
  return new Set(db.prepare('SELECT versao FROM schema_migrations').all().map((r) => r.versao));
}

/** Aplica, em ordem, as migrações que faltam. Cada uma numa transação:
 * se falhar, nada dela fica e o erro sobe (o app não abre com banco pela metade). */
function aplicarMigracoes(db, lista = MIGRACOES) {
  const feitas = versoesAplicadas(db);
  const aplicadas = [];
  for (const m of [...lista].sort((a, b) => a.versao - b.versao)) {
    if (feitas.has(m.versao)) continue;
    db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (versao, nome) VALUES (?, ?)').run(m.versao, m.nome);
    })();
    aplicadas.push(m.versao);
  }
  return aplicadas;
}

/** Desfaz as migrações acima de `paraVersao` (mais nova primeiro). Só suporte/testes. */
function reverterMigracoes(db, paraVersao = 0, lista = MIGRACOES) {
  const feitas = versoesAplicadas(db);
  const revertidas = [];
  for (const m of [...lista].sort((a, b) => b.versao - a.versao)) {
    if (m.versao <= paraVersao || !feitas.has(m.versao)) continue;
    db.transaction(() => {
      m.down(db);
      db.prepare('DELETE FROM schema_migrations WHERE versao = ?').run(m.versao);
    })();
    revertidas.push(m.versao);
  }
  return revertidas;
}

module.exports = { MIGRACOES, NATUREZAS, aplicarMigracoes, reverterMigracoes, versoesAplicadas };
