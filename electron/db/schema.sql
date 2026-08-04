-- ============================================================
-- Estoque PDV — schema base (genérico, extensível por perfil)
-- Estoque é tratado como LEDGER (livro-razão de movimentos),
-- nunca como um número mutável. O estoque atual de um produto
-- em um local é sempre SUM(quantidade) de stock_movements.
-- Isso resolve sincronização offline sem conflitos de escrita.
-- ============================================================

CREATE TABLE IF NOT EXISTS locations (
  id            TEXT PRIMARY KEY,
  nome          TEXT NOT NULL,
  tipo          TEXT DEFAULT 'loja',
  -- Identidade deste PDV para a numeração automática por CNPJ (Fase 1 do
  -- roadmap de múltiplos PDVs). device_uid é gerado uma única vez, local,
  -- independente do Firebase — garante que reregistrar não crie um PDV
  -- novo por engano. numero_pdv só é preenchido depois de registrado
  -- com sucesso (ex: "PDV001").
  device_uid    TEXT,
  numero_pdv    TEXT,
  ativo         INTEGER DEFAULT 1,
  criado_em     TEXT NOT NULL DEFAULT (NOW_SYNCED())
);

-- Usuários: operador de caixa vs gerente/admin.
-- pin_hash nunca é enviado ao renderer; toda verificação ocorre
-- no processo principal (Node), via authService.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  nome          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('operador','gerente','admin')),
  pin_hash      TEXT NOT NULL,
  pin_temporario INTEGER DEFAULT 0, -- 1 força a troca do PIN no próximo login
  tentativas_falhas INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate TEXT, -- se preenchido e no futuro, login/autorização ficam bloqueados até essa hora
  ativo         INTEGER DEFAULT 1,
  criado_em     TEXT NOT NULL DEFAULT (NOW_SYNCED())
);

-- business_profile define qual "perfil de negócio" está ativo
-- (farmacia, generico, mercadinho...) e injeta campos/regras extras
-- sem alterar o núcleo genérico.
CREATE TABLE IF NOT EXISTS business_profile (
  id            TEXT PRIMARY KEY DEFAULT 'default',
  perfil_ativo  TEXT NOT NULL DEFAULT 'generico',
  config_json   TEXT NOT NULL DEFAULT '{}'
);

-- Perfis de negócio — antes eram arquivos .json fixos (só eu conseguia
-- criar/editar); agora moram no banco e o próprio usuário cria e edita
-- pela tela de Configurações. "farmacia" e "generico" nascem como
-- perfis seed, mas continuam totalmente editáveis — não tem mais
-- distinção especial de "perfil embutido" vs "perfil do usuário".
CREATE TABLE IF NOT EXISTS custom_profiles (
  id                      TEXT PRIMARY KEY,
  nome                    TEXT NOT NULL,
  campos_extras_json      TEXT NOT NULL DEFAULT '[]', -- [{campo,label,tipo,obrigatorio}]
  alerta_validade_proxima INTEGER NOT NULL DEFAULT 0,
  dias_alerta_validade    INTEGER NOT NULL DEFAULT 60, -- nível "aviso" (amarelo)
  dias_alerta_validade_critico INTEGER NOT NULL DEFAULT 7, -- nível "crítico" (vermelho) — mais perto do vencimento
  estoque_critico_percentual REAL NOT NULL DEFAULT 50, -- % do estoque mínimo abaixo do qual vira "crítico" (vermelho)
  criado_em               TEXT NOT NULL DEFAULT (NOW_SYNCED())
);

CREATE TABLE IF NOT EXISTS products (
  id              TEXT PRIMARY KEY,
  sku             TEXT UNIQUE,
  codigo_barras   TEXT UNIQUE,
  nome            TEXT NOT NULL,
  categoria       TEXT,
  preco           REAL NOT NULL DEFAULT 0,
  custo           REAL DEFAULT 0,
  unidade         TEXT DEFAULT 'un',
  estoque_minimo  REAL DEFAULT 0,
  -- Dados fiscais (opcionais até a emissão de NFC-e estar configurada).
  -- Horizontais — não são específicos de perfil, são exigência do fisco
  -- independente do tipo de negócio.
  ncm             TEXT, -- Nomenclatura Comum do Mercosul (8 dígitos)
  cest            TEXT, -- Código Especificador da Substituição Tributária (quando aplicável)
  cfop            TEXT, -- Código Fiscal de Operações e Prestações (ex: 5102 venda dentro do estado)
  cst_csosn       TEXT, -- CST (Lucro Presumido/Real) ou CSOSN (Simples Nacional)
  origem_mercadoria TEXT DEFAULT '0', -- 0=nacional, 1=estrangeira importação direta, etc. (tabela do Fisco)
  foto_path       TEXT, -- caminho local da foto do produto (copiada para a pasta de dados do app)
  fornecedor_id   TEXT REFERENCES suppliers(id),
  codigo_balanca  TEXT, -- código curto (5-6 dígitos) cadastrado NA BALANÇA pra esse produto — usado pra decodificar a etiqueta de peso variável que ela imprime (diferente do código de barras comum)
  -- campos específicos de cada perfil (lote, validade, princípio
  -- ativo, controlado, exige_receita p/ farmácia, etc.) ficam aqui
  -- como JSON livre, sem exigir migração de schema por vertical.
  custom_fields   TEXT DEFAULT '{}',
  ativo           INTEGER DEFAULT 1,
  criado_em       TEXT NOT NULL DEFAULT (NOW_SYNCED())
);
CREATE INDEX IF NOT EXISTS idx_products_codigo_barras ON products(codigo_barras);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_categoria ON products(categoria);
CREATE INDEX IF NOT EXISTS idx_products_ativo ON products(ativo);

-- Histórico de alteração de preço — uma linha por vez que o preço de
-- venda mudou (não registra toda edição de produto, só quando o preço
-- especificamente é diferente do que já estava salvo).
CREATE TABLE IF NOT EXISTS product_price_history (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL REFERENCES products(id),
  preco_antigo REAL NOT NULL,
  preco_novo   REAL NOT NULL,
  operador_id  TEXT REFERENCES users(id),
  criado_em    TEXT NOT NULL DEFAULT (NOW_SYNCED())
);
CREATE INDEX IF NOT EXISTS idx_price_history_product ON product_price_history(product_id);

-- Controle de mesas (restaurante) — cada mesa aponta pra uma venda
-- (comanda) em aberto enquanto ocupada. A venda em si é a mesma tabela
-- `sales` de sempre — só fica aberta por mais tempo, recebendo itens aos
-- poucos, até a mesa fechar (pagamento) e voltar a ficar livre.
CREATE TABLE IF NOT EXISTS restaurant_tables (
  id          TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  numero      TEXT NOT NULL,
  nome        TEXT,
  status      TEXT NOT NULL DEFAULT 'livre', -- livre | ocupada | aguardando_limpeza | reservada
  pessoas     INTEGER, -- quantas pessoas na mesa, preenchido ao abrir — usado só pra dividir o valor da conta, não cria pagamentos separados
  reservado_para TEXT, -- data/hora combinada da reserva (formato ISO), só preenchido quando status = reservada
  sale_id     TEXT REFERENCES sales(id),
  criado_em   TEXT NOT NULL DEFAULT (NOW_SYNCED())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tables_location_numero ON restaurant_tables(location_id, numero);

-- Insumos (matéria-prima) — separado de `products` (que são os itens
-- vendidos, como pratos prontos). Um insumo tem custo por unidade
-- (ex: R$/kg), usado pra calcular o custo de um prato pela ficha
-- técnica dele.
CREATE TABLE IF NOT EXISTS ingredients (
  id             TEXT PRIMARY KEY,
  nome           TEXT NOT NULL,
  unidade        TEXT NOT NULL DEFAULT 'un', -- kg, g, l, ml, un
  custo_unitario REAL NOT NULL DEFAULT 0,
  estoque_atual  REAL NOT NULL DEFAULT 0,
  estoque_minimo REAL NOT NULL DEFAULT 0,
  ativo          INTEGER NOT NULL DEFAULT 1,
  criado_em      TEXT NOT NULL DEFAULT (NOW_SYNCED())
);

-- Ficha técnica — quais insumos (e quanto de cada) entram num prato.
-- Um prato é um `product` normal; isso só documenta a composição dele
-- pra poder calcular o custo automaticamente.
CREATE TABLE IF NOT EXISTS dish_ingredients (
  id            TEXT PRIMARY KEY,
  product_id    TEXT NOT NULL REFERENCES products(id),
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
  quantidade    REAL NOT NULL,
  criado_em     TEXT NOT NULL DEFAULT (NOW_SYNCED())
);
CREATE INDEX IF NOT EXISTS idx_dish_ingredients_product ON dish_ingredients(product_id);

-- Registro de desperdício — prato ou insumo que não virou venda
-- (sobrou do prato do dia, venceu, errou o preparo, etc). Guarda o
-- valor gasto perdido, calculado pela ficha técnica quando possível,
-- mas sempre editável na hora (o usuário pode digitar o valor direto).
CREATE TABLE IF NOT EXISTS waste_log (
  id             TEXT PRIMARY KEY,
  location_id    TEXT NOT NULL REFERENCES locations(id),
  tipo           TEXT NOT NULL, -- 'prato' | 'insumo'
  product_id     TEXT REFERENCES products(id),
  ingredient_id  TEXT REFERENCES ingredients(id),
  quantidade     REAL NOT NULL,
  custo_estimado REAL NOT NULL,
  motivo         TEXT,
  operador_id    TEXT REFERENCES users(id),
  criado_em      TEXT NOT NULL DEFAULT (NOW_SYNCED())
);
CREATE INDEX IF NOT EXISTS idx_waste_log_location ON waste_log(location_id, criado_em);

-- Estado local de licenciamento — funciona mesmo sem internet, já que
-- o cálculo de bloqueio usa só o que está salvo aqui (o contato com o
-- servidor, quando dá certo, só atualiza esses campos). Uma única
-- linha (id sempre 1).
CREATE TABLE IF NOT EXISTS license_state (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  ultimo_contato_ok  TEXT,    -- última vez que confirmou com o servidor com sucesso, seja ativa ou não
  congelada_desde    TEXT,    -- quando o servidor disse pela primeira vez "inativa" (NULL enquanto ativa) — tem 2 dias de carência
  bloqueio_imediato  INTEGER NOT NULL DEFAULT 0, -- bloqueio direto, sem carência nenhuma — diferente do congelamento (que avisa e dá 2 dias)
  status_atual       TEXT NOT NULL DEFAULT 'ativa' -- cache do último status conhecido: ativa | inativa
);

-- ============================================================
-- Lotes recebidos — cada entrada de mercadoria (via módulo de
-- abastecimento) vira uma linha aqui, com o PRÓPRIO lote/validade. Isso
-- é o que diferencia de só guardar validade no produto: um produto pode
-- ter vários lotes com validades diferentes ao mesmo tempo na loja, e a
-- recomendação de venda (vencer primeiro = vender primeiro) depende de
-- saber qual lote específico vence antes.
--
-- Importante: "quantidade" aqui é a quantidade RECEBIDA naquele lote —
-- o sistema não rastreia qual lote específico foi baixado em cada venda
-- (isso exigiria escolher o lote item a item no PDV, o que não existe
-- hoje). A recomendação de venda é sobre "qual lote priorizar", não uma
-- contagem exata de quanto resta daquele lote puxando venda por venda.
-- ============================================================
CREATE TABLE IF NOT EXISTS product_batches (
  id            TEXT PRIMARY KEY,
  product_id    TEXT NOT NULL REFERENCES products(id),
  location_id   TEXT NOT NULL REFERENCES locations(id),
  lote          TEXT,
  validade      TEXT, -- AAAA-MM-DD
  quantidade    REAL NOT NULL,
  fornecedor_id TEXT REFERENCES suppliers(id),
  operador_id   TEXT REFERENCES users(id),
  criado_em     TEXT NOT NULL DEFAULT (NOW_SYNCED())
);
CREATE INDEX IF NOT EXISTS idx_product_batches_product ON product_batches(product_id);
CREATE INDEX IF NOT EXISTS idx_product_batches_validade ON product_batches(validade);

-- Ledger de movimentos de estoque. Nunca é editado após criado,
-- apenas compensado com um novo movimento (ex: estorno).
CREATE TABLE IF NOT EXISTS stock_movements (
  id                TEXT PRIMARY KEY,
  product_id        TEXT NOT NULL REFERENCES products(id),
  location_id       TEXT NOT NULL REFERENCES locations(id),
  tipo              TEXT NOT NULL CHECK (tipo IN ('venda','entrada','ajuste','perda','estorno')),
  quantidade        REAL NOT NULL, -- negativo em vendas/perdas, positivo em entradas/estornos
  motivo            TEXT,
  sale_id           TEXT REFERENCES sales(id),
  sale_item_id      TEXT REFERENCES sale_items(id),
  operador_id       TEXT REFERENCES users(id),
  autorizado_por_id TEXT REFERENCES users(id), -- preenchido só quando exige autorização de gerente
  device_id         TEXT NOT NULL,
  criado_em         TEXT NOT NULL DEFAULT (NOW_SYNCED()),
  sincronizado_em   TEXT
);
CREATE INDEX IF NOT EXISTS idx_stock_mov_product_loc ON stock_movements(product_id, location_id);

CREATE TABLE IF NOT EXISTS sales (
  id            TEXT PRIMARY KEY,
  location_id   TEXT NOT NULL REFERENCES locations(id),
  operador_id   TEXT NOT NULL REFERENCES users(id),
  customer_id   TEXT REFERENCES customers(id), -- opcional: vincula a venda a um cliente (fiado/fidelidade)
  desconto      REAL NOT NULL DEFAULT 0, -- ex: resgate de pontos de fidelidade
  pontos_resgatados INTEGER NOT NULL DEFAULT 0,
  -- Desconto manual, a critério do gerente (ex: cliente específico,
  -- negociação pontual) — separado do desconto de fidelidade acima, pra
  -- nunca um sobrescrever o outro. Sempre exige autorização, com rastro.
  desconto_gerente        REAL NOT NULL DEFAULT 0,
  desconto_gerente_motivo TEXT,
  desconto_autorizado_por_id TEXT REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','finalizada','cancelada')),
  total         REAL NOT NULL DEFAULT 0,
  criado_em     TEXT NOT NULL DEFAULT (NOW_SYNCED()),
  finalizada_em TEXT,
  cancelada_em  TEXT,
  cancelada_por_id TEXT REFERENCES users(id),
  motivo_cancelamento TEXT,
  -- Taxa de serviço opcional (restaurante) — percentual (ex: 10 = 10%)
  -- aplicado sobre o total na hora do pagamento. Sempre opcional, começa
  -- em 0; quem decide ativar é quem está atendendo a mesa.
  taxa_servico_percentual REAL NOT NULL DEFAULT 0,
  -- Excluir do histórico é diferente de cancelar: some da LISTA (só
  -- gerente/admin vê a opção), mas não apaga nada por baixo — estoque,
  -- pagamento, e qualquer NFC-e já emitida continuam intactos. Nunca é
  -- um DELETE de verdade, pra nunca arriscar quebrar referência de
  -- outra tabela nem um documento fiscal já gerado.
  oculta_historico            INTEGER NOT NULL DEFAULT 0,
  oculta_historico_por_id     TEXT REFERENCES users(id),
  oculta_historico_em         TEXT,
  oculta_historico_motivo     TEXT
);

CREATE INDEX IF NOT EXISTS idx_sales_location_status_criado ON sales(location_id, status, criado_em);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);

CREATE TABLE IF NOT EXISTS sale_items (
  id              TEXT PRIMARY KEY,
  sale_id         TEXT NOT NULL REFERENCES sales(id),
  product_id      TEXT NOT NULL REFERENCES products(id),
  quantidade      REAL NOT NULL,
  preco_unitario  REAL NOT NULL,
  cancelado       INTEGER DEFAULT 0,
  cancelado_por_id TEXT REFERENCES users(id),
  cancelado_em    TEXT,
  motivo_cancelamento TEXT,
  criado_em       TEXT NOT NULL DEFAULT (NOW_SYNCED()),
  -- Controla o que já foi impresso na comanda da cozinha — assim, se
  -- adicionar mais itens numa mesa já em andamento, só os novos saem
  -- na impressão seguinte, sem reimprimir o que a cozinha já preparou.
  enviado_cozinha INTEGER NOT NULL DEFAULT 0,
  -- Observação livre do item (ex: "sem cebola", "ponto da carne mal
  -- passado") — vai junto na comanda impressa pra cozinha.
  observacao      TEXT,
  -- Qual pessoa da mesa pediu esse item (1, 2, 3...) — só usado quando
  -- a mesa tem mais de uma pessoa e alguém quer dividir a conta por
  -- item em vez de dividir o total igualmente.
  pessoa_numero   INTEGER,
  -- Preço unitário alterado manualmente na hora da venda (admin/gerente
  -- só) — preco_original guarda o preço de catálogo de antes da
  -- alteração, pra nunca perder o rastro de quanto era o preço "de
  -- verdade" versus o que foi realmente cobrado.
  preco_original       REAL,
  preco_alterado_por_id TEXT REFERENCES users(id),
  preco_alterado_motivo TEXT
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);

-- Pagamentos: uma venda pode ter múltiplos métodos (pagamento
-- misto, ex: parte dinheiro + parte cartão).
CREATE TABLE IF NOT EXISTS payments (
  id          TEXT PRIMARY KEY,
  sale_id     TEXT NOT NULL REFERENCES sales(id),
  metodo      TEXT NOT NULL CHECK (metodo IN ('dinheiro','cartao_credito','cartao_debito','pix','fiado','outro')),
  valor       REAL NOT NULL,
  detalhes    TEXT DEFAULT '{}', -- ex: parcelas, troco, nsu/autorização de cartão
  criado_em   TEXT NOT NULL DEFAULT (NOW_SYNCED())
);
CREATE INDEX IF NOT EXISTS idx_payments_sale ON payments(sale_id);

-- Sessões de caixa: abertura no início do turno com um valor inicial em
-- dinheiro, fechamento no fim conferindo o valor contado contra o
-- esperado (abertura + vendas em dinheiro no período). Vender no PDV
-- exige uma sessão aberta para o local.
CREATE TABLE IF NOT EXISTS cash_sessions (
  id                        TEXT PRIMARY KEY,
  location_id               TEXT NOT NULL REFERENCES locations(id),
  operador_abertura_id      TEXT NOT NULL REFERENCES users(id),
  valor_abertura            REAL NOT NULL DEFAULT 0,
  aberta_em                 TEXT NOT NULL DEFAULT (NOW_SYNCED()),
  operador_fechamento_id    TEXT REFERENCES users(id),
  valor_fechamento_informado REAL,
  valor_fechamento_esperado REAL,
  diferenca                 REAL,
  fechada_em                TEXT,
  status                    TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','fechada'))
);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_location_status ON cash_sessions(location_id, status);

-- Anexos da venda: imagem ou PDF de receita, comprovante, nota, etc.
-- Opcional e por venda (não por item) — nem todo estabelecimento vende
-- medicamentos, então isso nunca bloqueia a venda, só documenta.
CREATE TABLE IF NOT EXISTS sale_attachments (
  id              TEXT PRIMARY KEY,
  sale_id         TEXT NOT NULL REFERENCES sales(id),
  nome_arquivo    TEXT NOT NULL,
  caminho         TEXT NOT NULL,
  tipo            TEXT NOT NULL CHECK (tipo IN ('imagem','pdf')),
  operador_id     TEXT REFERENCES users(id),
  -- Extração de dados por IA (opcional, sob demanda — nunca automática
  -- sem o usuário pedir, e nunca bloqueia nada no PDV).
  extracao_status TEXT DEFAULT 'nao_solicitada' CHECK (extracao_status IN ('nao_solicitada','processando','concluida','erro')),
  extracao_json   TEXT, -- JSON com os campos extraídos pela IA (ou o erro, se falhou)
  extraido_em     TEXT,
  criado_em       TEXT NOT NULL DEFAULT (NOW_SYNCED())
);
CREATE INDEX IF NOT EXISTS idx_sale_attachments_sale ON sale_attachments(sale_id);

-- Configuração da integração de IA (Gemini). Fica só uma linha, como
-- business_profile. A chave nunca sai da máquina do usuário exceto para
-- chamar a própria API do Google.
CREATE TABLE IF NOT EXISTS ai_settings (
  id        TEXT PRIMARY KEY DEFAULT 'default',
  provider  TEXT NOT NULL DEFAULT 'gemini',
  api_key   TEXT,
  modelo    TEXT NOT NULL DEFAULT 'gemini-3.1-flash-lite',
  ativado   INTEGER NOT NULL DEFAULT 0
);

-- Auditoria: toda tentativa de cancelamento/alteração sensível,
-- sucesso ou falha, fica registrada — inclusive tentativas negadas.
CREATE TABLE IF NOT EXISTS audit_log (
  id                TEXT PRIMARY KEY,
  tipo_evento       TEXT NOT NULL, -- 'cancelamento_item' | 'cancelamento_venda' | 'devolucao' | 'ajuste_estoque' | 'autorizacao_negada'
  sale_id           TEXT,
  sale_item_id      TEXT,
  solicitante_id    TEXT REFERENCES users(id), -- operador que pediu
  autorizado_por_id TEXT REFERENCES users(id), -- gerente que autorizou (null se negado)
  motivo            TEXT,
  sucesso           INTEGER NOT NULL,
  criado_em         TEXT NOT NULL DEFAULT (NOW_SYNCED())
);
CREATE INDEX IF NOT EXISTS idx_audit_log_criado ON audit_log(criado_em);

-- ============================================================
-- ============================================================
-- Sincronização entre PDVs (Fase 1: numeração automática por CNPJ).
-- Totalmente opcional — sem isso configurado, o GerenciaAI continua
-- 100% local como sempre foi. Ver electron/services/pdvRegistryService.js
-- e o README para o checklist de configuração no Firebase Console.
-- ============================================================
-- ============================================================
-- Backup automático do banco. Guarda cópias do arquivo .sqlite3 (não
-- afeta o funcionamento do app se estiver desativado). Pasta secundária
-- é opcional — útil apontar pra uma pasta sincronizada por nuvem
-- (OneDrive/Google Drive) ou um pendrive, pra sair da própria máquina.
-- ============================================================
CREATE TABLE IF NOT EXISTS backup_config (
  id                TEXT PRIMARY KEY DEFAULT 'default',
  pasta_secundaria  TEXT,
  ultimo_backup_em  TEXT,
  ultimo_backup_ok  INTEGER
);

-- Formato do recibo impresso — largura de impressora térmica de cupom
-- (58mm ou 80mm são os dois padrões de mercado) ou folha comum (A4).
CREATE TABLE IF NOT EXISTS receipt_config (
  id                  TEXT PRIMARY KEY DEFAULT 'default',
  largura_mm          INTEGER NOT NULL DEFAULT 80 CHECK (largura_mm IN (58, 80, 210)),
  rodape_texto        TEXT,
  imprimir_automatico INTEGER NOT NULL DEFAULT 0,
  impressora_padrao   TEXT -- nome exato da impressora (Windows) escolhida como padrão; NULL = sempre perguntar
);

-- Cardápio digital personalizável (restaurante/padaria) — aparência
-- customizável de um cardápio que pode ser exportado como página HTML
-- própria (pra exibir num tablet/TV, ou mandar o link/arquivo pro
-- cliente) — diferente do "Cardápio do dia" (que é só a lista simples
-- pra imprimir dos pratos disponíveis hoje).
CREATE TABLE IF NOT EXISTS digital_menu_config (
  id              TEXT PRIMARY KEY DEFAULT 'default',
  titulo          TEXT DEFAULT 'Nosso Cardápio',
  subtitulo       TEXT,
  cor_tema        TEXT DEFAULT '#0f6e63',
  mostrar_precos  INTEGER NOT NULL DEFAULT 1,
  rodape_texto    TEXT
);

-- Formato da etiqueta de peso variável impressa pela balança — varia
-- por marca/modelo/configuração (não existe "o" formato único, cada
-- fabricante tem os seus). "formato" escolhe entre os padrões mais
-- comuns documentados pelos fabricantes brasileiros (Urano, Toledo,
-- Filizola costumam seguir variações parecidas). Ver
-- weightBarcodeService.js pra a lista completa dos formatos aceitos.
CREATE TABLE IF NOT EXISTS scale_barcode_config (
  id      TEXT PRIMARY KEY DEFAULT 'default',
  formato TEXT NOT NULL DEFAULT 'peso_cod6', -- ver FORMATOS em weightBarcodeService.js
  campo   TEXT NOT NULL DEFAULT 'peso' CHECK (campo IN ('peso', 'preco_total')) -- o que os 5 dígitos do meio representam
);

-- Configuração da balança digital conectada por porta serial (opcional
-- — sem isso configurado, o app só aceita peso digitado manualmente ou
-- lido da etiqueta impressa).
CREATE TABLE IF NOT EXISTS scale_hardware_config (
  id          TEXT PRIMARY KEY DEFAULT 'default',
  porta       TEXT, -- ex: 'COM3' — NULL = balança digital não configurada
  baud_rate   INTEGER DEFAULT 9600,
  protocolo   TEXT DEFAULT 'toledo_padrao' -- ver scaleHardwareService.js
);

-- Configurações de segurança do caixa — hoje só a exigência de senha
-- de gerente pra cancelar item/venda depois de já ter pagamento
-- registrado (opcional por padrão exige, mas pode ser desligada).
CREATE TABLE IF NOT EXISTS security_config (
  id                                TEXT PRIMARY KEY DEFAULT 'default',
  exigir_autorizacao_cancelamento   INTEGER NOT NULL DEFAULT 1,
  exigir_autorizacao_desconto       INTEGER NOT NULL DEFAULT 1
);

-- Cache local do que o painel de licenciamento publicou como
-- atualização obrigatória — igual o license_state, funciona offline
-- com o último valor conhecido (não trava ninguém por falta de rede).
CREATE TABLE IF NOT EXISTS forced_update_state (
  id                      TEXT PRIMARY KEY DEFAULT 'default',
  versao_minima_exigida   TEXT,
  obrigatoria             INTEGER NOT NULL DEFAULT 0
);

-- Cache local das mensagens publicadas no painel de licenciamento —
-- igual license_state, funciona offline com o último valor conhecido.
-- "Global" vem de config/mensagem (todo mundo vê); os outros dois vêm
-- do próprio documento da instalação (mensagem por cliente, e motivo
-- de bloqueio), então não precisam de coleção nova nenhuma.
CREATE TABLE IF NOT EXISTS home_message_state (
  id                          TEXT PRIMARY KEY DEFAULT 'default',
  global_texto                TEXT,
  global_imagem_url           TEXT,
  global_ativa                INTEGER NOT NULL DEFAULT 0,
  mensagem_personalizada      TEXT,
  motivo_bloqueio             TEXT
);

-- Rascunho da leitura de nota em andamento no Abastecimento — sem
-- isso, trocar de aba no meio da conferência perdia tudo que a IA já
-- tinha extraído (só existia como estado do componente React, que
-- reseta ao desmontar a tela). Singleton — só uma leitura em
-- andamento por vez faz sentido nesse fluxo.
CREATE TABLE IF NOT EXISTS supply_draft (
  id             TEXT PRIMARY KEY DEFAULT 'default',
  arquivo_nome   TEXT,
  fornecedor_id  TEXT,
  linhas_json    TEXT, -- array JSON das linhas em conferência
  atualizado_em  TEXT
);

-- Preferências de exibição do PDV — puramente visuais, cada instalação
-- guarda a sua própria (não sincroniza entre máquinas, cada terminal
-- pode preferir um jeito diferente de exibir).
CREATE TABLE IF NOT EXISTS pos_display_config (
  id                       TEXT PRIMARY KEY DEFAULT 'default',
  -- 'lista' (padrão) ou 'blocos' -- como os resultados da busca manual
  -- de produto aparecem.
  modo_busca               TEXT NOT NULL DEFAULT 'lista',
  -- 'recente' (padrão de sempre, reordena a cada venda) ou 'frequente'
  -- (mais estável, ordena por total vendido nos últimos 30 dias — o
  -- botão de um produto não fica pulando de lugar a cada venda).
  modo_vendidos_recentes   TEXT NOT NULL DEFAULT 'recente',
  -- Quantos produtos mostrar na fileira de "vendidos recentemente".
  qtd_vendidos_recentes    INTEGER NOT NULL DEFAULT 12,
  -- Tamanho dos blocos de produto (compacto cabe mais na tela,
  -- confortável fica mais fácil de acertar o dedo/mouse).
  tamanho_blocos           TEXT NOT NULL DEFAULT 'confortavel'
);

-- Cache local de qual grupo de sincronização entre PDVs essa
-- instalação pertence — atribuído centralmente pelo painel de
-- licenciamento (Central GerenciaAI → Sincronização), não configurado
-- pelo cliente. Vem do mesmo documento/escuta em tempo real que já
-- traz mensagem personalizada e motivo de bloqueio, então não precisa
-- de nenhuma consulta nova ao Firestore.
CREATE TABLE IF NOT EXISTS sync_state (
  id                       TEXT PRIMARY KEY DEFAULT 'default',
  grupo_sincronizacao_id   TEXT,
  -- Se essa máquina é a "servidor" do grupo — a que centraliza a
  -- consulta de estoque na hora de finalizar uma venda, pra impedir
  -- duas máquinas venderem a última unidade do mesmo produto ao mesmo
  -- tempo. Atribuído pelo painel, junto com o grupo.
  servidor_do_grupo        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS firebase_config (
  id            TEXT PRIMARY KEY DEFAULT 'default',
  api_key       TEXT,
  auth_domain   TEXT,
  project_id    TEXT,
  app_id        TEXT,
  ativado       INTEGER NOT NULL DEFAULT 0
);

-- Configuração de pagamento — hoje só a chave Pix, para gerar o QR Code
-- estático (padrão Banco Central) na hora de cobrar. Não integra com
-- nenhum banco: o operador confirma visualmente o recebimento.
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_config (
  id                TEXT PRIMARY KEY DEFAULT 'default',
  pix_chave         TEXT,
  pix_tipo_chave    TEXT, -- 'cpf' | 'cnpj' | 'email' | 'telefone' | 'aleatoria' — só informativo
  pix_nome_recebedor TEXT,
  pix_cidade        TEXT
);

-- ============================================================
-- Fiscal — fundação para emissão de NFC-e. A emissão real (assinatura de
-- XML, transmissão à SEFAZ) NÃO está implementada: depende de CNPJ, IE e
-- certificado digital reais para desenvolver e testar contra o ambiente
-- de homologação do estado. Ver electron/services/fiscalService.js e o
-- README para o que falta.
-- ============================================================

-- Dados da empresa emitente. Fica só uma linha, como business_profile.
CREATE TABLE IF NOT EXISTS fiscal_config (
  id                  TEXT PRIMARY KEY DEFAULT 'default',
  cnpj                TEXT,
  inscricao_estadual  TEXT,
  razao_social        TEXT,
  nome_fantasia       TEXT,
  regime_tributario   TEXT CHECK (regime_tributario IN ('simples_nacional','mei','lucro_presumido','lucro_real')),
  uf                  TEXT, -- sigla do estado, ex: 'PE' — define o webservice da SEFAZ a usar
  municipio_codigo_ibge TEXT,
  endereco_json       TEXT DEFAULT '{}', -- logradouro, número, bairro, CEP, etc. (exigido no XML da NFC-e)
  certificado_path    TEXT, -- caminho do arquivo .pfx/.p12 (A1) no disco — nunca commitar no projeto
  certificado_senha   TEXT, -- criptografado via safeStorage do SO (ver electron/services/secretsService.js) — nunca em texto puro, exceto no raro caso de o SO não suportar (aí cai pra texto puro em vez de travar o app)
  ambiente            TEXT NOT NULL DEFAULT 'homologacao' CHECK (ambiente IN ('homologacao','producao')),
  serie_nfce          TEXT DEFAULT '1',
  proximo_numero_nfce INTEGER DEFAULT 1,
  csc_id              TEXT, -- Código de Segurança do Contribuinte (necessário para o QR Code da NFC-e)
  csc_token           TEXT
);

-- Registro de cada NFC-e emitida (ou tentativa). Nunca é a fonte da
-- verdade do estoque/venda (isso continua em sales/stock_movements) —
-- é só o rastro fiscal em paralelo.
CREATE TABLE IF NOT EXISTS nfce_emitidas (
  id                    TEXT PRIMARY KEY,
  sale_id               TEXT NOT NULL REFERENCES sales(id),
  numero                INTEGER,
  serie                 TEXT,
  chave_acesso          TEXT,
  protocolo_autorizacao TEXT,
  status                TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','autorizada','rejeitada','cancelada','contingencia')),
  motivo_rejeicao       TEXT,
  ambiente              TEXT,
  xml_path              TEXT,
  criado_em             TEXT NOT NULL DEFAULT (NOW_SYNCED())
);
CREATE INDEX IF NOT EXISTS idx_nfce_sale ON nfce_emitidas(sale_id);

-- ============================================================
-- Clientes, fiado e fidelidade
-- ============================================================
CREATE TABLE IF NOT EXISTS customers (
  id            TEXT PRIMARY KEY,
  nome          TEXT NOT NULL,
  telefone      TEXT,
  cpf           TEXT,
  cnpj          TEXT, -- cliente pessoa jurídica (opcional, além ou no lugar do CPF)
  pontos        INTEGER NOT NULL DEFAULT 0,
  ativo         INTEGER DEFAULT 1,
  criado_em     TEXT NOT NULL DEFAULT (NOW_SYNCED())
);

-- Ledger de fiado — mesmo princípio do estoque: nunca edita, só lança
-- movimento novo. Saldo devedor = SUM(valor) dos movimentos do cliente.
CREATE TABLE IF NOT EXISTS customer_credit_movements (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  tipo          TEXT NOT NULL CHECK (tipo IN ('divida','pagamento')),
  valor         REAL NOT NULL, -- positivo em 'divida', positivo em 'pagamento' (abate o saldo)
  sale_id       TEXT REFERENCES sales(id),
  motivo        TEXT,
  operador_id   TEXT REFERENCES users(id),
  criado_em     TEXT NOT NULL DEFAULT (NOW_SYNCED())
);
CREATE INDEX IF NOT EXISTS idx_credit_customer ON customer_credit_movements(customer_id);

CREATE TABLE IF NOT EXISTS loyalty_config (
  id                  TEXT PRIMARY KEY DEFAULT 'default',
  ativado             INTEGER NOT NULL DEFAULT 0,
  reais_por_ponto     REAL NOT NULL DEFAULT 10, -- 1 ponto a cada X reais gastos
  valor_resgate_ponto REAL NOT NULL DEFAULT 0.05 -- quanto vale 1 ponto em desconto (R$)
);

-- ============================================================
-- Fornecedores
-- ============================================================
CREATE TABLE IF NOT EXISTS suppliers (
  id            TEXT PRIMARY KEY,
  nome          TEXT NOT NULL,
  cnpj_cpf      TEXT,
  telefone      TEXT,
  email         TEXT,
  ativo         INTEGER DEFAULT 1,
  criado_em     TEXT NOT NULL DEFAULT (NOW_SYNCED())
);

-- ============================================================
-- Devoluções pós-venda — separado do cancelamento (que só existe durante
-- a venda aberta). Mesma exigência de autorização de gerente.
-- ============================================================
CREATE TABLE IF NOT EXISTS returns (
  id                TEXT PRIMARY KEY,
  sale_id           TEXT NOT NULL REFERENCES sales(id),
  location_id       TEXT NOT NULL REFERENCES locations(id),
  operador_id       TEXT NOT NULL REFERENCES users(id),
  autorizado_por_id TEXT NOT NULL REFERENCES users(id),
  motivo            TEXT,
  valor_devolvido   REAL NOT NULL DEFAULT 0,
  criado_em         TEXT NOT NULL DEFAULT (NOW_SYNCED())
);

CREATE TABLE IF NOT EXISTS return_items (
  id            TEXT PRIMARY KEY,
  return_id     TEXT NOT NULL REFERENCES returns(id),
  product_id    TEXT NOT NULL REFERENCES products(id),
  quantidade    REAL NOT NULL,
  valor_unitario REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_return_items_return ON return_items(return_id);
