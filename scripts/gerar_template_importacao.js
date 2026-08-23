/**
 * Gera templates/modelo_importacao_estoque.xlsx A PARTIR das constantes
 * reais de electron/services/importExportService.js (COLUMNS,
 * CAMPOS_EXTRAS_CONHECIDOS, COLUNAS_INSUMOS, COLUNAS_FICHA_TECNICA) --
 * fonte única, pra planilha modelo shippada com o app nunca ficar
 * dessincronizada do que o código de fato aceita.
 *
 * Rodar com `node scripts/gerar_template_importacao.js` sempre que as
 * colunas de importação mudarem.
 */
const path = require('path');
const ExcelJS = require('exceljs');
const importExportService = require('../electron/services/importExportService');

const OUT_PATH = path.join(__dirname, '..', 'templates', 'modelo_importacao_estoque.xlsx');

const DESCRICAO_COLUNA_BASE = {
  sku: 'Código interno do produto (SKU). Se já existir, o produto é atualizado; se não existir, é criado.',
  codigo_barras: 'Código de barras (EAN/UPC). Usado pelo leitor no PDV. Pode ficar em branco (busca por nome ainda funciona).',
  nome: 'Nome do produto. Campo obrigatório.',
  categoria: 'Categoria/grupo do produto (texto livre) — vira botão automaticamente no PDV.',
  preco_venda: 'Preço de venda. Use ponto como separador decimal (ex: 12.50). Obrigatório.',
  custo: 'Custo de aquisição (opcional). Ponto como separador decimal.',
  unidade: 'Unidade de venda: un, cx, ml, kg, etc. Padrão: un.',
  estoque_minimo: 'Quantidade mínima antes de disparar alerta de estoque baixo. Padrão: 0.',
  quantidade_estoque_inicial: 'Quantidade em estoque no momento da importação. Só é usada na PRIMEIRA importação de um produto novo — reimportar (mesmo sku/código de barras) atualiza os outros dados, mas NÃO soma estoque de novo.',
  fornecedor: 'Nome do fornecedor (opcional). Se ainda não existir um fornecedor com esse nome, é criado automaticamente.',
  ncm: 'Código NCM do produto (opcional, uso fiscal — 8 dígitos).',
  cfop: 'Código CFOP da operação de venda (opcional, uso fiscal — ex: 5102 para venda dentro do estado).',
  cst_csosn: 'CST (Lucro Presumido/Real) ou CSOSN (Simples Nacional) — opcional, uso fiscal.',
  origem_mercadoria: 'Origem da mercadoria: 0=nacional, 1=estrangeira importação direta, 2=estrangeira mercado interno. Padrão: 0.',
};

const PERFIL_POR_CAMPO = {
  lote: 'Farmácia', validade: 'Farmácia, Petshop, Armazém, Salão, Padaria', principio_ativo: 'Farmácia',
  controlado: 'Farmácia', exige_receita: 'Farmácia',
  especie_animal: 'Petshop', peso_volume: 'Petshop', exige_receita_veterinaria: 'Petshop',
  peso_liquido: 'Armazém/Mercearia', perecivel: 'Armazém/Mercearia',
  uso_profissional: 'Salão de Beleza',
  peso_gramas: 'Padaria/Confeitaria',
  tamanho: 'Loja de Roupas', cor: 'Loja de Roupas',
  grau: 'Ótica', tipo_lente: 'Ótica',
  garantia_meses: 'Material de Construção',
  tipo_prato: 'Restaurante', tempo_preparo: 'Restaurante', disponivel_hoje: 'Restaurante',
};

const LABEL_POR_CAMPO = {
  lote: 'Lote', validade: 'Validade (AAAA-MM-DD)', principio_ativo: 'Princípio ativo',
  controlado: 'Medicamento controlado? (sim/não)', exige_receita: 'Exige receita médica? (sim/não)',
  especie_animal: 'Espécie do animal (cão, gato, ave...)', peso_volume: 'Peso/volume da embalagem',
  exige_receita_veterinaria: 'Exige receita veterinária? (sim/não)',
  peso_liquido: 'Peso/volume líquido', perecivel: 'Perecível / precisa refrigeração? (sim/não)',
  uso_profissional: 'Uso profissional, não é pra revenda? (sim/não)',
  peso_gramas: 'Peso (gramas)',
  tamanho: 'Tamanho (P, M, G...)', cor: 'Cor',
  grau: 'Grau da lente', tipo_lente: 'Tipo de lente',
  garantia_meses: 'Garantia (meses)',
  tipo_prato: 'Tipo do prato (entrada, principal, sobremesa, bebida...)',
  tempo_preparo: 'Tempo de preparo (minutos)', disponivel_hoje: 'Disponível hoje / prato do dia? (sim/não)',
};

async function main() {
  const { COLUMNS, CAMPOS_EXTRAS_CONHECIDOS, COLUNAS_INSUMOS, COLUNAS_FICHA_TECNICA } = importExportService;

  const workbook = new ExcelJS.Workbook();

  // ---------- Instruções ----------
  const instrucoes = workbook.addWorksheet('Instruções');
  const addLinha = (a, b) => instrucoes.addRow([a, b]);
  instrucoes.addRow(['Modelo de importação de estoque — GerenciaAI']);
  instrucoes.addRow(['Preencha a aba \'Modelo\' seguindo exatamente os nomes de coluna abaixo. Não renomeie o cabeçalho.']);
  instrucoes.addRow([]);
  addLinha('Coluna', 'Descrição');
  for (const col of COLUMNS) {
    if (DESCRICAO_COLUNA_BASE[col]) {
      addLinha(col, DESCRICAO_COLUNA_BASE[col]);
    } else {
      const [, tipo] = CAMPOS_EXTRAS_CONHECIDOS.find(([campo]) => campo === col);
      addLinha(col, `${LABEL_POR_CAMPO[col]} — campo do perfil "${PERFIL_POR_CAMPO[col]}" (tipo: ${tipo}). Deixe em branco se não se aplica ao seu tipo de negócio.`);
    }
  }
  instrucoes.addRow([]);
  instrucoes.addRow(['Observações importantes:']);
  instrucoes.addRow(['- Esta planilha reúne os campos extras de TODOS os perfis de negócio nativos numa aba só — preencha apenas os que fazem sentido pro seu tipo de negócio, deixe o resto em branco.']);
  instrucoes.addRow(['- Colunas fiscais (ncm, cfop, cst_csosn, origem_mercadoria) são opcionais — preencha se/quando for configurar a emissão fiscal.']);
  instrucoes.addRow(['- \'sku\' ou \'codigo_barras\' são a chave de identificação: se um produto com o mesmo valor já existir, ele será ATUALIZADO, não duplicado.']);
  instrucoes.addRow(['- \'fornecedor\' cria o fornecedor automaticamente se ainda não existir — não precisa cadastrar antes.']);
  instrucoes.addRow(['- \'quantidade_estoque_inicial\' só é aplicada na primeira importação de um produto novo — reimportar não soma estoque de novo.']);
  instrucoes.addRow(['- Datas devem estar no formato AAAA-MM-DD (ex: 2027-03-01).']);
  instrucoes.addRow(['- Não altere a ordem ou os nomes das colunas na aba \'Modelo\'.']);
  instrucoes.addRow([]);
  instrucoes.addRow(['Abas opcionais — Insumos e Ficha Tecnica:']);
  instrucoes.addRow(['- A aba \'Insumos\' cadastra matéria-prima (farinha, carne, óleo...) usada nas fichas técnicas dos produtos. Veja a aba de exemplo.']);
  instrucoes.addRow(['- \'estoque_atual\' em Insumos só é aplicado na CRIAÇÃO de um insumo novo — reimportar não reseta o estoque já consumido em vendas.']);
  instrucoes.addRow(['- A aba \'Ficha Tecnica\' liga um produto (aba Modelo) a um insumo (aba Insumos) e a quantidade usada em CADA unidade vendida.']);
  instrucoes.addRow(['- Um mesmo produto pode ter várias linhas na Ficha Tecnica (uma por insumo) — juntas formam a receita inteira dele.']);
  instrucoes.addRow(['- Produto e insumo referenciados na Ficha Tecnica precisam já existir (nesta mesma planilha ou já cadastrados antes) — nomes idênticos aos cadastrados.']);
  instrucoes.addRow(['- As duas abas são OPCIONAIS: uma planilha só com \'Modelo\' continua funcionando normalmente, sem elas.']);
  instrucoes.getRow(1).font = { bold: true, size: 13 };
  instrucoes.getRow(4).font = { bold: true };
  instrucoes.columns = [{ width: 28 }, { width: 110 }];

  // ---------- Modelo (exemplo farmácia + exemplo restaurante) ----------
  const modelo = workbook.addWorksheet('Modelo');
  modelo.addRow(COLUMNS);
  modelo.getRow(1).font = { bold: true };
  modelo.addRow(COLUMNS.map((c) => ({
    sku: 'MED-001', codigo_barras: '7891234567890', nome: 'Dipirona 500mg 20cp', categoria: 'Analgésicos',
    preco_venda: 8.9, custo: 4.2, unidade: 'un', estoque_minimo: 10, quantidade_estoque_inicial: 150,
    lote: 'L2024A', validade: '2027-03-01', principio_ativo: 'Dipirona monoidratada', controlado: 'não', exige_receita: 'não',
    fornecedor: 'Distribuidora Central', ncm: '30049069', cfop: '5102', cst_csosn: '102', origem_mercadoria: '0',
  }[c] ?? '')));
  modelo.addRow(COLUMNS.map((c) => ({
    sku: 'PRT-001', nome: 'Risoto de Camarão', categoria: 'Pratos Principais', preco_venda: 59.9, custo: 24,
    unidade: 'porção', estoque_minimo: 5, quantidade_estoque_inicial: 20,
    tipo_prato: 'Prato principal', tempo_preparo: 25, disponivel_hoje: 'sim',
  }[c] ?? '')));
  modelo.columns.forEach((col, idx) => { col.width = Math.max(String(COLUMNS[idx]).length + 2, 14); });

  // ---------- Insumos (exemplo) ----------
  const insumos = workbook.addWorksheet('Insumos');
  insumos.addRow(COLUNAS_INSUMOS);
  insumos.getRow(1).font = { bold: true };
  insumos.addRow(['Arroz Arbóreo', 'kg', 12, 10, 2]);
  insumos.addRow(['Camarão', 'kg', 45, 5, 1]);
  insumos.columns.forEach((col, idx) => { col.width = Math.max(String(COLUNAS_INSUMOS[idx]).length + 2, 16); });

  // ---------- Ficha Tecnica (exemplo -- liga o Risoto acima aos insumos acima) ----------
  const ficha = workbook.addWorksheet('Ficha Tecnica');
  ficha.addRow(COLUNAS_FICHA_TECNICA);
  ficha.getRow(1).font = { bold: true };
  ficha.addRow(['Risoto de Camarão', 'PRT-001', 'Arroz Arbóreo', 0.15]);
  ficha.addRow(['Risoto de Camarão', 'PRT-001', 'Camarão', 0.12]);
  ficha.columns.forEach((col, idx) => { col.width = Math.max(String(COLUNAS_FICHA_TECNICA[idx]).length + 2, 16); });

  await workbook.xlsx.writeFile(OUT_PATH);
  console.log('Template regenerado em', OUT_PATH);
}

main().catch((err) => { console.error(err); process.exit(1); });
