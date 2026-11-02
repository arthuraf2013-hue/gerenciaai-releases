/**
 * Catálogos da DEMONSTRAÇÃO COMPLETA (ver demoDataService.js) -- um por
 * perfil de negócio (as chaves batem com os ids de `custom_profiles`,
 * seedProfileIfMissing em database.js).
 *
 * Não confundir com vitrineDemoCatalogos.js: aquele alimenta só a vitrine
 * online da máquina de demonstração; este monta a loja inteira (produtos,
 * clientes, quatro meses de vendas) para apresentar o sistema.
 *
 * Tudo aqui é fictício. Formato de cada item:
 *   [codigo, nome, categoria, preco, custo, unidade, estoqueMinimo, extras?]
 * extras: { servico, validadeDias, custom, peso }
 *   - servico: true  -> products.tipo = 'servico' (sem estoque)
 *   - validadeDias   -> custom_fields.validade = hoje + N dias (perfis que
 *                       exigem validade recebem uma padrão se faltar)
 *   - custom         -> demais custom_fields do perfil
 *   - peso           -> o quanto o item sai nas vendas (padrão 1)
 * `pares`: itens comprados juntos com frequência (alimenta a sugestão
 * "quem compra isso, compra aquilo").
 */

const CATALOGOS_DEMONSTRACAO = {
  farmacia: {
    rotulo: 'Farmácia',
    exigeValidade: true,
    exigeLote: true,
    fornecedores: ['Distribuidora Farma Alfa (fictícia)', 'Medic Beta Distribuidora (fictícia)', 'Higiene Gama (fictícia)'],
    itens: [
      ['F01', 'Dipirona 500 mg 10 comprimidos', 'Analgésicos', 8.9, 3.2, 'un', 15, { peso: 3, validadeDias: 400, custom: { principio_ativo: 'Dipirona' } }],
      ['F02', 'Paracetamol 750 mg 20 comprimidos', 'Analgésicos', 12.9, 4.8, 'un', 15, { peso: 3, validadeDias: 380, custom: { principio_ativo: 'Paracetamol' } }],
      ['F03', 'Ibuprofeno 400 mg 10 cápsulas', 'Analgésicos', 14.9, 5.9, 'un', 10, { peso: 2, validadeDias: 300, custom: { principio_ativo: 'Ibuprofeno' } }],
      ['F04', 'Loratadina 10 mg 12 comprimidos', 'Antialérgicos', 11.5, 3.9, 'un', 8, { validadeDias: 50, custom: { principio_ativo: 'Loratadina' } }],
      ['F05', 'Soro fisiológico 0,9% 250 ml', 'Higiene e curativos', 6.9, 2.4, 'un', 12, { peso: 2, validadeDias: 500 }],
      ['F06', 'Curativo adesivo caixa com 40', 'Higiene e curativos', 9.9, 3.8, 'un', 10, { peso: 2, validadeDias: 700 }],
      ['F07', 'Termômetro digital', 'Equipamentos', 29.9, 14, 'un', 3, { validadeDias: 900 }],
      ['F08', 'Protetor solar FPS 50 120 ml', 'Dermocosméticos', 49.9, 24, 'un', 4, { validadeDias: 40 }],
      ['F09', 'Vitamina C 1 g efervescente 10 comprimidos', 'Vitaminas', 17.9, 7.5, 'un', 6, { validadeDias: 260 }],
      ['F10', 'Fralda infantil M pacote com 30', 'Infantil', 54.9, 34, 'un', 6, { peso: 2, validadeDias: 720 }],
      ['F11', 'Álcool em gel 70% 500 ml', 'Higiene e curativos', 12.9, 5.5, 'un', 8, { validadeDias: 540 }],
      ['F12', 'Omeprazol 20 mg 28 cápsulas', 'Uso contínuo', 19.9, 6.5, 'un', 8, { peso: 2, validadeDias: 330, custom: { principio_ativo: 'Omeprazol' } }],
      ['F13', 'Losartana 50 mg 30 comprimidos', 'Uso contínuo', 15.9, 4.9, 'un', 10, { peso: 2, validadeDias: 420, custom: { principio_ativo: 'Losartana potássica' } }],
      ['F14', 'Clonazepam 2 mg 30 comprimidos', 'Controlados', 24.9, 9, 'un', 4, { validadeDias: 360, custom: { principio_ativo: 'Clonazepam', controlado: true, exige_receita: true } }],
      ['F15', 'Amoxicilina 500 mg 21 cápsulas', 'Antibióticos', 29.9, 11, 'un', 4, { validadeDias: 300, custom: { principio_ativo: 'Amoxicilina', exige_receita: true } }],
      ['F16', 'Sertralina 50 mg 30 comprimidos', 'Controlados', 32.9, 12.5, 'un', 4, { validadeDias: 360, custom: { principio_ativo: 'Sertralina', controlado: true, exige_receita: true } }],
      ['F17', 'Escova dental macia', 'Higiene bucal', 7.9, 2.9, 'un', 10, { validadeDias: 1000 }],
      ['F18', 'Creme dental 90 g', 'Higiene bucal', 5.49, 2.2, 'un', 12, { peso: 2, validadeDias: 600 }],
    ],
    pares: [['F05', 'F06'], ['F17', 'F18'], ['F09', 'F11'], ['F13', 'F12'], ['F01', 'F05'], ['F03', 'F11']],
  },

  petshop: {
    rotulo: 'Petshop',
    fornecedores: ['Pet Nutri Delta (fictícia)', 'Acessórios Pet Ômega (fictícia)', 'Vet Saúde Sigma (fictícia)'],
    itens: [
      ['P01', 'Ração cão adulto 15 kg', 'Rações', 189.9, 128, 'un', 3, { validadeDias: 120, custom: { especie_animal: 'Cão', peso_volume: '15 kg' } }],
      ['P02', 'Ração cão adulto 1 kg', 'Rações', 22.9, 14, 'un', 8, { peso: 3, validadeDias: 100, custom: { especie_animal: 'Cão', peso_volume: '1 kg' } }],
      ['P03', 'Ração gato adulto 1 kg', 'Rações', 26.9, 16, 'un', 8, { peso: 3, validadeDias: 100, custom: { especie_animal: 'Gato', peso_volume: '1 kg' } }],
      ['P04', 'Sachê para gatos 85 g', 'Rações', 3.49, 1.6, 'un', 24, { peso: 3, validadeDias: 60, custom: { especie_animal: 'Gato', peso_volume: '85 g' } }],
      ['P05', 'Areia higiênica 4 kg', 'Higiene', 18.9, 11, 'un', 6, { peso: 2 }],
      ['P06', 'Shampoo pet 500 ml', 'Higiene', 21.9, 12, 'un', 4, { validadeDias: 400 }],
      ['P07', 'Petisco bifinho 65 g', 'Petiscos', 9.9, 5, 'un', 10, { peso: 2, validadeDias: 80, custom: { especie_animal: 'Cão' } }],
      ['P08', 'Osso de couro', 'Petiscos', 15.9, 9, 'un', 6],
      ['P09', 'Vermífugo para cães até 10 kg', 'Saúde', 24.9, 12, 'un', 5, { validadeDias: 300 }],
      ['P10', 'Antipulgas para cães', 'Saúde', 69.9, 38, 'un', 4, { validadeDias: 360 }],
      ['P11', 'Coleira ajustável M', 'Acessórios', 29.9, 14, 'un', 3],
      ['P12', 'Comedouro inox', 'Acessórios', 24.9, 11, 'un', 3],
      ['P13', 'Banho e tosa porte pequeno', 'Serviços', 60, 0, 'un', 0, { servico: true, peso: 2 }],
      ['P14', 'Banho porte médio', 'Serviços', 50, 0, 'un', 0, { servico: true }],
    ],
    pares: [['P03', 'P05'], ['P03', 'P04'], ['P02', 'P07'], ['P09', 'P10'], ['P06', 'P13'], ['P11', 'P12']],
  },

  armazem: {
    rotulo: 'Armazém / Mercearia',
    exigeValidade: true,
    fornecedores: ['Distribuidora Alfa (fictícia)', 'Laticínios Gama (fictícia)', 'Bebidas Beta (fictícia)'],
    itens: [
      ['A01', 'Arroz tipo 1 5 kg', 'Mercearia', 27.9, 19, 'un', 8, { peso: 2, validadeDias: 200 }],
      ['A02', 'Feijão carioca 1 kg', 'Mercearia', 9.49, 6.5, 'un', 10, { peso: 2, validadeDias: 180 }],
      ['A03', 'Açúcar cristal 1 kg', 'Mercearia', 4.99, 3.2, 'un', 10, { validadeDias: 300 }],
      ['A04', 'Café torrado e moído 500 g', 'Mercearia', 18.9, 12, 'un', 8, { peso: 2, validadeDias: 150 }],
      ['A05', 'Óleo de soja 900 ml', 'Mercearia', 8.49, 5.8, 'un', 8, { validadeDias: 240 }],
      ['A06', 'Macarrão espaguete 500 g', 'Mercearia', 4.79, 2.9, 'un', 10, { validadeDias: 300 }],
      ['A07', 'Leite integral 1 L', 'Laticínios', 5.49, 3.8, 'un', 24, { peso: 3, validadeDias: 10, custom: { perecivel: true } }],
      ['A08', 'Manteiga 200 g', 'Laticínios', 12.9, 8.2, 'un', 6, { validadeDias: 12, custom: { perecivel: true } }],
      ['A09', 'Queijo mussarela', 'Frios', 44.9, 28, 'kg', 3, { peso: 2, validadeDias: 8, custom: { perecivel: true } }],
      ['A10', 'Presunto fatiado', 'Frios', 39.9, 24, 'kg', 3, { validadeDias: 6, custom: { perecivel: true } }],
      ['A11', 'Refrigerante 2 L', 'Bebidas', 7.49, 4.2, 'un', 12, { peso: 2, validadeDias: 120 }],
      ['A12', 'Água mineral 500 ml', 'Bebidas', 2.5, 0.9, 'un', 24, { peso: 2, validadeDias: 300 }],
      ['A13', 'Biscoito cream cracker 400 g', 'Mercearia', 5.29, 3.1, 'un', 8, { validadeDias: 160 }],
      ['A14', 'Sabão em pó 1 kg', 'Limpeza', 13.9, 8.9, 'un', 6, { validadeDias: 700 }],
      ['A15', 'Detergente 500 ml', 'Limpeza', 2.99, 1.6, 'un', 12, { validadeDias: 700 }],
      ['A16', 'Papel higiênico 12 rolos', 'Limpeza', 19.9, 13, 'un', 6, { validadeDias: 900 }],
    ],
    pares: [['A01', 'A02'], ['A04', 'A03'], ['A09', 'A10'], ['A14', 'A15'], ['A07', 'A04'], ['A06', 'A05']],
  },

  salao_beleza: {
    rotulo: 'Salão de Beleza',
    fornecedores: ['Cosméticos Zeta (fictícia)', 'Beleza Pro Kappa (fictícia)'],
    itens: [
      ['S01', 'Corte feminino', 'Serviços', 80, 0, 'un', 0, { servico: true, peso: 3, custom: { tipo_servico: 'Corte' } }],
      ['S02', 'Corte masculino', 'Serviços', 40, 0, 'un', 0, { servico: true, peso: 2, custom: { tipo_servico: 'Corte' } }],
      ['S03', 'Escova', 'Serviços', 60, 0, 'un', 0, { servico: true, peso: 2, custom: { tipo_servico: 'Escova' } }],
      ['S04', 'Coloração', 'Serviços', 180, 0, 'un', 0, { servico: true, custom: { tipo_servico: 'Coloração' } }],
      ['S05', 'Manicure', 'Serviços', 35, 0, 'un', 0, { servico: true, peso: 3, custom: { tipo_servico: 'Unhas' } }],
      ['S06', 'Pedicure', 'Serviços', 40, 0, 'un', 0, { servico: true, peso: 2, custom: { tipo_servico: 'Unhas' } }],
      ['S07', 'Hidratação', 'Serviços', 110, 0, 'un', 0, { servico: true, custom: { tipo_servico: 'Tratamento' } }],
      ['S08', 'Shampoo profissional 1 L', 'Revenda', 44.9, 22, 'un', 4, { validadeDias: 400 }],
      ['S09', 'Condicionador profissional 1 L', 'Revenda', 44.9, 22, 'un', 4, { validadeDias: 400 }],
      ['S10', 'Máscara capilar 500 g', 'Revenda', 58.9, 28, 'un', 3, { validadeDias: 150 }],
      ['S11', 'Esmalte cremoso 8 ml', 'Revenda', 11.9, 4, 'un', 12, { peso: 2, validadeDias: 365 }],
      ['S12', 'Óleo reparador 60 ml', 'Revenda', 39.9, 18, 'un', 3, { validadeDias: 500 }],
    ],
    pares: [['S05', 'S06'], ['S01', 'S03'], ['S08', 'S09'], ['S04', 'S07'], ['S05', 'S11'], ['S07', 'S10']],
  },

  padaria: {
    rotulo: 'Padaria',
    exigeValidade: true,
    fornecedores: ['Moinho Trigo Bom (fictício)', 'Laticínios Gama (fictícia)', 'Frios Lambda (fictícia)'],
    itens: [
      ['D01', 'Pão francês', 'Pães', 16.9, 8, 'kg', 5, { peso: 4, validadeDias: 1 }],
      ['D02', 'Pão de queijo', 'Pães', 2.5, 0.9, 'un', 30, { peso: 3, validadeDias: 2 }],
      ['D03', 'Pão de forma artesanal', 'Pães', 12, 5, 'un', 6, { validadeDias: 4 }],
      ['D04', 'Bolo de rolo (fatia)', 'Bolos e doces', 8, 3.2, 'un', 10, { peso: 2, validadeDias: 3 }],
      ['D05', 'Bolo de macaxeira (fatia)', 'Bolos e doces', 7, 2.8, 'un', 10, { validadeDias: 3 }],
      ['D06', 'Sonho de creme', 'Bolos e doces', 6.5, 2.2, 'un', 12, { validadeDias: 2 }],
      ['D07', 'Coxinha de frango', 'Salgados', 7, 2.5, 'un', 20, { peso: 3, validadeDias: 1 }],
      ['D08', 'Pastel de forno', 'Salgados', 6.5, 2.3, 'un', 20, { peso: 2, validadeDias: 1 }],
      ['D09', 'Queijo coalho', 'Frios', 54.9, 34, 'kg', 3, { validadeDias: 10 }],
      ['D10', 'Presunto fatiado', 'Frios', 39.9, 24, 'kg', 3, { validadeDias: 6 }],
      ['D11', 'Café com leite (copo)', 'Bebidas', 5, 1.2, 'un', 0, { servico: true, peso: 3 }],
      ['D12', 'Suco de laranja 300 ml', 'Bebidas', 8, 3, 'un', 10, { validadeDias: 3 }],
      ['D13', 'Leite integral 1 L', 'Bebidas', 6.29, 3.9, 'un', 12, { peso: 2, validadeDias: 10 }],
    ],
    pares: [['D01', 'D10'], ['D01', 'D09'], ['D02', 'D11'], ['D07', 'D12'], ['D04', 'D11'], ['D01', 'D13']],
  },

  papelaria: {
    rotulo: 'Papelaria',
    fornecedores: ['Papelaria Teta Atacado (fictícia)', 'Escolar Mu Distribuidora (fictícia)'],
    itens: [
      ['PA01', 'Caderno universitário 10 matérias', 'Cadernos', 32.9, 18, 'un', 6, { peso: 2 }],
      ['PA02', 'Caderno brochura 96 folhas', 'Cadernos', 9.9, 4.5, 'un', 12, { peso: 2 }],
      ['PA03', 'Caneta esferográfica azul', 'Escrita', 2.5, 0.8, 'un', 40, { peso: 4 }],
      ['PA04', 'Lápis grafite nº 2', 'Escrita', 1.5, 0.45, 'un', 40, { peso: 3 }],
      ['PA05', 'Borracha branca', 'Escrita', 1.8, 0.5, 'un', 30, { peso: 2 }],
      ['PA06', 'Apontador com depósito', 'Escrita', 3.9, 1.3, 'un', 20],
      ['PA07', 'Marca-texto amarelo', 'Escrita', 4.5, 1.8, 'un', 15],
      ['PA08', 'Papel sulfite A4 500 folhas', 'Papel', 32.9, 21, 'un', 5],
      ['PA09', 'Cola branca 90 g', 'Artes', 4.9, 1.9, 'un', 12],
      ['PA10', 'Tesoura escolar', 'Artes', 6.9, 2.8, 'un', 10],
      ['PA11', 'Mochila escolar', 'Mochilas', 119.9, 62, 'un', 2],
      ['PA12', 'Estojo escolar', 'Mochilas', 24.9, 10, 'un', 5],
      ['PA13', 'Impressão colorida A4', 'Serviços', 2, 0, 'un', 0, { servico: true, peso: 3 }],
      ['PA14', 'Cópia preto e branco', 'Serviços', 0.5, 0, 'un', 0, { servico: true, peso: 3 }],
    ],
    pares: [['PA03', 'PA04'], ['PA04', 'PA05'], ['PA05', 'PA06'], ['PA02', 'PA03'], ['PA11', 'PA12'], ['PA09', 'PA10']],
  },

  vestuario: {
    rotulo: 'Loja de Roupas',
    fornecedores: ['Confecções Rho (fictícia)', 'Malharia Tau (fictícia)'],
    itens: [
      ['V01', 'Camiseta básica algodão M', 'Camisetas', 49.9, 22, 'un', 6, { peso: 3, custom: { tamanho: 'M', cor: 'Branca' } }],
      ['V02', 'Camiseta básica algodão G', 'Camisetas', 49.9, 22, 'un', 6, { peso: 3, custom: { tamanho: 'G', cor: 'Preta' } }],
      ['V03', 'Calça jeans feminina 38', 'Calças', 139.9, 62, 'un', 3, { custom: { tamanho: '38', cor: 'Azul' } }],
      ['V04', 'Calça jeans masculina 42', 'Calças', 149.9, 66, 'un', 3, { custom: { tamanho: '42', cor: 'Azul' } }],
      ['V05', 'Bermuda sarja 40', 'Bermudas', 89.9, 38, 'un', 4, { custom: { tamanho: '40', cor: 'Bege' } }],
      ['V06', 'Vestido midi floral M', 'Vestidos', 159.9, 70, 'un', 2, { custom: { tamanho: 'M', cor: 'Estampado' } }],
      ['V07', 'Blusa de alça P', 'Blusas', 59.9, 24, 'un', 4, { custom: { tamanho: 'P', cor: 'Rosa' } }],
      ['V08', 'Moletom canguru G', 'Agasalhos', 129.9, 58, 'un', 3, { custom: { tamanho: 'G', cor: 'Cinza' } }],
      ['V09', 'Meia cano médio (par)', 'Acessórios', 14.9, 5, 'un', 15, { peso: 2 }],
      ['V10', 'Cueca boxer', 'Moda íntima', 24.9, 9, 'un', 10, { peso: 2, custom: { tamanho: 'M' } }],
      ['V11', 'Boné aba curva', 'Acessórios', 59.9, 24, 'un', 3],
      ['V12', 'Cinto de couro', 'Acessórios', 79.9, 32, 'un', 3],
    ],
    pares: [['V03', 'V07'], ['V04', 'V12'], ['V01', 'V05'], ['V02', 'V09'], ['V10', 'V09'], ['V02', 'V11']],
  },

  otica: {
    rotulo: 'Ótica',
    fornecedores: ['Lentes Phi Laboratório (fictício)', 'Armações Chi (fictícia)'],
    itens: [
      ['O01', 'Armação acetato modelo Clássico', 'Armações', 289.9, 120, 'un', 3, { peso: 2 }],
      ['O02', 'Armação metal modelo Leve', 'Armações', 249.9, 95, 'un', 3, { peso: 2 }],
      ['O03', 'Armação infantil flexível', 'Armações', 189.9, 70, 'un', 2],
      ['O04', 'Lente monofocal 1.56 antirreflexo (par)', 'Lentes', 249, 90, 'un', 4, { peso: 3, custom: { tipo_lente: 'Monofocal' } }],
      ['O05', 'Lente multifocal 1.67 (par)', 'Lentes', 890, 360, 'un', 2, { custom: { tipo_lente: 'Multifocal' } }],
      ['O06', 'Lente fotossensível monofocal (par)', 'Lentes', 590, 230, 'un', 2, { custom: { tipo_lente: 'Fotossensível' } }],
      ['O07', 'Óculos de sol polarizado', 'Solar', 199.9, 80, 'un', 3],
      ['O08', 'Estojo rígido', 'Acessórios', 29.9, 8, 'un', 8, { peso: 2 }],
      ['O09', 'Flanela de microfibra', 'Acessórios', 9.9, 2, 'un', 15, { peso: 2 }],
      ['O10', 'Spray limpa-lentes 60 ml', 'Acessórios', 24.9, 7, 'un', 8],
      ['O11', 'Ajuste e solda de armação', 'Serviços', 40, 0, 'un', 0, { servico: true }],
    ],
    pares: [['O01', 'O04'], ['O02', 'O04'], ['O01', 'O05'], ['O07', 'O08'], ['O04', 'O08'], ['O09', 'O10']],
  },

  material_construcao: {
    rotulo: 'Material de Construção',
    fornecedores: ['Construção Épsilon (fictícia)', 'Hidráulica Psi (fictícia)', 'Elétrica Ômega (fictícia)'],
    itens: [
      ['M01', 'Cimento CP-II 50 kg', 'Básicos', 39.9, 28, 'saco', 20, { peso: 3 }],
      ['M02', 'Areia média', 'Básicos', 140, 90, 'm³', 3],
      ['M03', 'Brita 1', 'Básicos', 160, 105, 'm³', 3],
      ['M04', 'Tijolo 8 furos', 'Básicos', 1.2, 0.7, 'un', 500, { peso: 2 }],
      ['M05', 'Argamassa AC-I 20 kg', 'Básicos', 22.9, 14, 'saco', 10, { peso: 2 }],
      ['M06', 'Tinta acrílica branca 18 L', 'Tintas', 279.9, 180, 'un', 3],
      ['M07', 'Rolo de lã 23 cm', 'Tintas', 29.9, 14, 'un', 5],
      ['M08', 'Tubo PVC 25 mm barra 6 m', 'Hidráulica', 22.9, 14, 'un', 10, { peso: 2 }],
      ['M09', 'Joelho PVC 25 mm', 'Hidráulica', 1.9, 0.7, 'un', 30, { peso: 2 }],
      ['M10', 'Torneira de cozinha', 'Hidráulica', 69.9, 35, 'un', 3, { custom: { garantia_meses: 12 } }],
      ['M11', 'Fio flexível 2,5 mm rolo 100 m', 'Elétrica', 249.9, 165, 'un', 3],
      ['M12', 'Disjuntor 20 A', 'Elétrica', 19.9, 9, 'un', 8, { custom: { garantia_meses: 12 } }],
      ['M13', 'Fita isolante 19 mm', 'Elétrica', 5.9, 2.5, 'un', 12, { peso: 2 }],
      ['M14', 'Parafuso sextavado 1/4 caixa com 100', 'Fixação', 18.9, 9, 'un', 6],
      ['M15', 'Furadeira de impacto 600 W', 'Ferramentas', 289.9, 170, 'un', 2, { custom: { garantia_meses: 12 } }],
    ],
    pares: [['M01', 'M02'], ['M01', 'M05'], ['M06', 'M07'], ['M08', 'M09'], ['M11', 'M12'], ['M12', 'M13'], ['M03', 'M01']],
  },

  restaurante: {
    rotulo: 'Restaurante',
    fornecedores: ['Hortifruti Nu (fictício)', 'Bebidas Beta (fictícia)', 'Carnes Xi (fictícia)'],
    itens: [
      ['R01', 'Prato executivo de frango', 'Pratos', 29.9, 11, 'un', 0, { servico: true, peso: 3, custom: { tipo_prato: 'Prato principal', tempo_preparo: 20 } }],
      ['R02', 'Prato executivo de carne', 'Pratos', 34.9, 14, 'un', 0, { servico: true, peso: 3, custom: { tipo_prato: 'Prato principal', tempo_preparo: 25 } }],
      ['R03', 'Feijoada individual', 'Pratos', 39.9, 16, 'un', 0, { servico: true, peso: 2, custom: { tipo_prato: 'Prato principal', tempo_preparo: 15 } }],
      ['R04', 'Salada Caesar', 'Entradas', 27.9, 9, 'un', 0, { servico: true, custom: { tipo_prato: 'Entrada', tempo_preparo: 10 } }],
      ['R05', 'Porção de batata frita', 'Entradas', 32, 8, 'un', 0, { servico: true, peso: 2, custom: { tipo_prato: 'Entrada', tempo_preparo: 15 } }],
      ['R06', 'Pudim de leite (fatia)', 'Sobremesas', 12, 3.5, 'un', 0, { servico: true, custom: { tipo_prato: 'Sobremesa', tempo_preparo: 2 } }],
      ['R07', 'Refrigerante lata 350 ml', 'Bebidas', 6, 2.8, 'un', 24, { peso: 3, custom: { tipo_prato: 'Bebida' } }],
      ['R08', 'Suco natural 500 ml', 'Bebidas', 10, 3.5, 'un', 0, { servico: true, peso: 2, custom: { tipo_prato: 'Bebida', tempo_preparo: 5 } }],
      ['R09', 'Água mineral 500 ml', 'Bebidas', 4, 1, 'un', 24, { peso: 2, custom: { tipo_prato: 'Bebida' } }],
      ['R10', 'Cerveja long neck', 'Bebidas', 9.9, 4.8, 'un', 24, { peso: 2, custom: { tipo_prato: 'Bebida' } }],
    ],
    pares: [['R01', 'R07'], ['R02', 'R08'], ['R03', 'R10'], ['R05', 'R10'], ['R04', 'R09'], ['R02', 'R06']],
  },

  generico: {
    rotulo: 'Varejo geral',
    fornecedores: ['Distribuidora Alfa (fictícia)', 'Eletro Iota (fictícia)'],
    itens: [
      ['G01', 'Pilha AA com 4 unidades', 'Eletrônicos', 12.9, 6, 'un', 6, { peso: 2 }],
      ['G02', 'Carregador USB', 'Eletrônicos', 29.9, 10, 'un', 4, { peso: 2 }],
      ['G03', 'Cabo USB-C 1 m', 'Eletrônicos', 24.9, 8, 'un', 6, { peso: 2 }],
      ['G04', 'Fone de ouvido com fio', 'Eletrônicos', 34.9, 13, 'un', 4],
      ['G05', 'Lâmpada LED 9 W', 'Casa', 9.9, 4.2, 'un', 10, { peso: 2 }],
      ['G06', 'Extensão 3 tomadas', 'Casa', 29.9, 13, 'un', 4],
      ['G07', 'Guarda-chuva', 'Utilidades', 39.9, 17, 'un', 3],
      ['G08', 'Garrafa térmica 1 L', 'Utilidades', 59.9, 28, 'un', 3],
      ['G09', 'Copo plástico 200 ml pacote com 100', 'Descartáveis', 6.9, 3.2, 'un', 10, { peso: 2 }],
      ['G10', 'Vela aromática', 'Casa', 24.9, 9, 'un', 5],
      ['G11', 'Caderno 96 folhas', 'Papelaria', 17.9, 9, 'un', 6],
      ['G12', 'Caneta esferográfica azul', 'Papelaria', 2.5, 0.8, 'un', 30, { peso: 3 }],
    ],
    pares: [['G02', 'G03'], ['G03', 'G04'], ['G05', 'G06'], ['G11', 'G12'], ['G01', 'G05'], ['G08', 'G09']],
  },
};

const PRIMEIROS_NOMES = ['Maria', 'José', 'Ana', 'João', 'Francisca', 'Antônio', 'Luiza', 'Paulo', 'Carla', 'Lucas',
  'Fernanda', 'Marcos', 'Juliana', 'Rafael', 'Patrícia', 'Eduardo', 'Renata', 'Felipe', 'Simone', 'Gustavo'];
const SOBRENOMES = ['Silva', 'Souza', 'Santos', 'Oliveira', 'Lima', 'Costa', 'Pereira', 'Rocha', 'Almeida', 'Nascimento',
  'Barbosa', 'Ferreira', 'Gomes', 'Ribeiro', 'Carvalho', 'Martins', 'Araújo', 'Mendes', 'Melo', 'Cavalcanti'];

/** 40 clientes fictícios. Telefone com DDD 00 (não existe): a reconquista
 * e o cupom de aniversário automáticos nunca alcançam um número real. */
function clientesDemonstracao() {
  const lista = [];
  for (let i = 0; i < 40; i += 1) {
    lista.push({
      nome: `${PRIMEIROS_NOMES[i % 20]} ${SOBRENOMES[(Math.floor(i / 20) * 5 + i) % 20]}`,
      telefone: `(00) 90000-${String(i + 1).padStart(4, '0')}`,
    });
  }
  return lista;
}

function perfisDisponiveis() {
  return Object.entries(CATALOGOS_DEMONSTRACAO).map(([id, c]) => ({ id, rotulo: c.rotulo }));
}

module.exports = { CATALOGOS_DEMONSTRACAO, clientesDemonstracao, perfisDisponiveis };
