/**
 * Catálogos prontos da VITRINE DE DEMONSTRAÇÃO (ver vitrineDemoService.js).
 *
 * Cada produto vira um produto de verdade na máquina de demonstração, com
 * SKU `DEMO-<codigo>` -- assim o pedido feito pelo prospect cai na
 * Separação com produto real e, ao concluir, vira venda e baixa estoque
 * como qualquer pedido. Preços são exemplos de demonstração (editáveis na
 * própria máquina depois de criados: o seed nunca regrava um produto que
 * já existe).
 *
 * As chaves dos segmentos precisam bater com SEGMENTOS_DEMO no
 * admin-panel/index.html (Central → Crescimento → Vitrine de demonstração).
 */

const CATALOGOS_DEMO = {
  padaria: {
    rotulo: 'Padaria',
    itens: [
      { codigo: 'PAD-01', nome: 'Pão francês', categoria: 'Pães', preco: 16.9, unidade: 'kg' },
      { codigo: 'PAD-02', nome: 'Pão de queijo (unidade)', categoria: 'Pães', preco: 2.5, unidade: 'un' },
      { codigo: 'PAD-03', nome: 'Pão de forma artesanal', categoria: 'Pães', preco: 12, unidade: 'un' },
      { codigo: 'PAD-04', nome: 'Pão doce com coco', categoria: 'Pães', preco: 4.5, unidade: 'un' },
      { codigo: 'PAD-05', nome: 'Bolo de rolo (fatia)', categoria: 'Bolos e doces', preco: 8, unidade: 'un' },
      { codigo: 'PAD-06', nome: 'Bolo de macaxeira (fatia)', categoria: 'Bolos e doces', preco: 7, unidade: 'un' },
      { codigo: 'PAD-07', nome: 'Sonho de creme', categoria: 'Bolos e doces', preco: 6.5, unidade: 'un' },
      { codigo: 'PAD-08', nome: 'Coxinha de frango', categoria: 'Salgados', preco: 7, unidade: 'un' },
      { codigo: 'PAD-09', nome: 'Pastel de forno', categoria: 'Salgados', preco: 6.5, unidade: 'un' },
      { codigo: 'PAD-10', nome: 'Queijo coalho', categoria: 'Frios', preco: 54.9, unidade: 'kg' },
      { codigo: 'PAD-11', nome: 'Presunto fatiado', categoria: 'Frios', preco: 39.9, unidade: 'kg' },
      { codigo: 'PAD-12', nome: 'Café com leite (copo)', categoria: 'Bebidas', preco: 5, unidade: 'un' },
      { codigo: 'PAD-13', nome: 'Suco de laranja 300 ml', categoria: 'Bebidas', preco: 8, unidade: 'un' },
      { codigo: 'PAD-14', nome: 'Leite integral 1 L', categoria: 'Bebidas', preco: 6.29, unidade: 'un' },
    ],
  },
  lanchonete: {
    rotulo: 'Lanchonete',
    itens: [
      { codigo: 'LAN-01', nome: 'X-burguer', categoria: 'Sanduíches', preco: 18, unidade: 'un' },
      { codigo: 'LAN-02', nome: 'X-salada', categoria: 'Sanduíches', preco: 20, unidade: 'un' },
      { codigo: 'LAN-03', nome: 'X-tudo', categoria: 'Sanduíches', preco: 28, unidade: 'un' },
      { codigo: 'LAN-04', nome: 'Misto quente', categoria: 'Sanduíches', preco: 10, unidade: 'un' },
      { codigo: 'LAN-05', nome: 'Cachorro-quente', categoria: 'Sanduíches', preco: 12, unidade: 'un' },
      { codigo: 'LAN-06', nome: 'Tapioca de queijo coalho', categoria: 'Tapiocas', preco: 12, unidade: 'un' },
      { codigo: 'LAN-07', nome: 'Tapioca de carne de sol', categoria: 'Tapiocas', preco: 18, unidade: 'un' },
      { codigo: 'LAN-08', nome: 'Batata frita (porção)', categoria: 'Porções', preco: 22, unidade: 'un' },
      { codigo: 'LAN-09', nome: 'Coxinha de frango', categoria: 'Porções', preco: 7, unidade: 'un' },
      { codigo: 'LAN-10', nome: 'Refrigerante lata', categoria: 'Bebidas', preco: 6, unidade: 'un' },
      { codigo: 'LAN-11', nome: 'Suco natural 500 ml', categoria: 'Bebidas', preco: 10, unidade: 'un' },
      { codigo: 'LAN-12', nome: 'Água mineral 500 ml', categoria: 'Bebidas', preco: 3.5, unidade: 'un' },
      { codigo: 'LAN-13', nome: 'Açaí 400 ml', categoria: 'Sobremesas', preco: 16, unidade: 'un' },
    ],
  },
  mercearia: {
    rotulo: 'Mercearia',
    itens: [
      { codigo: 'MER-01', nome: 'Arroz tipo 1 5 kg', categoria: 'Mercearia', preco: 27.9, unidade: 'un' },
      { codigo: 'MER-02', nome: 'Feijão carioca 1 kg', categoria: 'Mercearia', preco: 8.49, unidade: 'un' },
      { codigo: 'MER-03', nome: 'Açúcar cristal 1 kg', categoria: 'Mercearia', preco: 5.29, unidade: 'un' },
      { codigo: 'MER-04', nome: 'Café torrado 250 g', categoria: 'Mercearia', preco: 14.9, unidade: 'un' },
      { codigo: 'MER-05', nome: 'Óleo de soja 900 ml', categoria: 'Mercearia', preco: 7.99, unidade: 'un' },
      { codigo: 'MER-06', nome: 'Macarrão espaguete 500 g', categoria: 'Mercearia', preco: 4.79, unidade: 'un' },
      { codigo: 'MER-07', nome: 'Flocão de milho 500 g', categoria: 'Mercearia', preco: 3.29, unidade: 'un' },
      { codigo: 'MER-08', nome: 'Leite integral 1 L', categoria: 'Frios e laticínios', preco: 6.29, unidade: 'un' },
      { codigo: 'MER-09', nome: 'Manteiga 200 g', categoria: 'Frios e laticínios', preco: 12.9, unidade: 'un' },
      { codigo: 'MER-10', nome: 'Ovos (bandeja com 12)', categoria: 'Frios e laticínios', preco: 11.9, unidade: 'un' },
      { codigo: 'MER-11', nome: 'Banana prata', categoria: 'Hortifrúti', preco: 6.99, unidade: 'kg' },
      { codigo: 'MER-12', nome: 'Tomate', categoria: 'Hortifrúti', preco: 8.49, unidade: 'kg' },
      { codigo: 'MER-13', nome: 'Detergente 500 ml', categoria: 'Limpeza', preco: 2.79, unidade: 'un' },
      { codigo: 'MER-14', nome: 'Sabão em pó 800 g', categoria: 'Limpeza', preco: 13.9, unidade: 'un' },
    ],
  },
  bar: {
    rotulo: 'Bar',
    itens: [
      { codigo: 'BAR-01', nome: 'Cerveja long neck', categoria: 'Cervejas', preco: 9, unidade: 'un' },
      { codigo: 'BAR-02', nome: 'Cerveja 600 ml', categoria: 'Cervejas', preco: 14, unidade: 'un' },
      { codigo: 'BAR-03', nome: 'Cerveja lata 350 ml', categoria: 'Cervejas', preco: 6.5, unidade: 'un' },
      { codigo: 'BAR-04', nome: 'Caipirinha', categoria: 'Drinks', preco: 16, unidade: 'un' },
      { codigo: 'BAR-05', nome: 'Dose de cachaça', categoria: 'Drinks', preco: 6, unidade: 'un' },
      { codigo: 'BAR-06', nome: 'Refrigerante lata', categoria: 'Sem álcool', preco: 6, unidade: 'un' },
      { codigo: 'BAR-07', nome: 'Água mineral 500 ml', categoria: 'Sem álcool', preco: 3.5, unidade: 'un' },
      { codigo: 'BAR-08', nome: 'Batata frita (porção)', categoria: 'Petiscos', preco: 24, unidade: 'un' },
      { codigo: 'BAR-09', nome: 'Macaxeira frita (porção)', categoria: 'Petiscos', preco: 22, unidade: 'un' },
      { codigo: 'BAR-10', nome: 'Carne de sol com macaxeira', categoria: 'Petiscos', preco: 48, unidade: 'un' },
      { codigo: 'BAR-11', nome: 'Calabresa acebolada', categoria: 'Petiscos', preco: 32, unidade: 'un' },
      { codigo: 'BAR-12', nome: 'Caldinho de feijão', categoria: 'Petiscos', preco: 9, unidade: 'un' },
    ],
  },
  petshop: {
    rotulo: 'Pet shop',
    itens: [
      { codigo: 'PET-01', nome: 'Ração cães adultos 3 kg', categoria: 'Rações', preco: 69.9, unidade: 'un' },
      { codigo: 'PET-02', nome: 'Ração gatos adultos 1 kg', categoria: 'Rações', preco: 32.9, unidade: 'un' },
      { codigo: 'PET-03', nome: 'Ração a granel (cães)', categoria: 'Rações', preco: 18.9, unidade: 'kg' },
      { codigo: 'PET-04', nome: 'Sachê para gatos 85 g', categoria: 'Rações', preco: 3.79, unidade: 'un' },
      { codigo: 'PET-05', nome: 'Petisco bifinho 65 g', categoria: 'Petiscos', preco: 8.9, unidade: 'un' },
      { codigo: 'PET-06', nome: 'Osso de couro', categoria: 'Petiscos', preco: 6.5, unidade: 'un' },
      { codigo: 'PET-07', nome: 'Areia higiênica 4 kg', categoria: 'Higiene', preco: 19.9, unidade: 'un' },
      { codigo: 'PET-08', nome: 'Tapete higiênico (7 un.)', categoria: 'Higiene', preco: 24.9, unidade: 'un' },
      { codigo: 'PET-09', nome: 'Shampoo pet 500 ml', categoria: 'Higiene', preco: 22.9, unidade: 'un' },
      { codigo: 'PET-10', nome: 'Coleira ajustável', categoria: 'Acessórios', preco: 29.9, unidade: 'un' },
      { codigo: 'PET-11', nome: 'Brinquedo bolinha', categoria: 'Acessórios', preco: 12.9, unidade: 'un' },
      { codigo: 'PET-12', nome: 'Comedouro inox', categoria: 'Acessórios', preco: 26.9, unidade: 'un' },
    ],
  },
};

const PREFIXO_SKU_DEMO = 'DEMO-';

module.exports = { CATALOGOS_DEMO, PREFIXO_SKU_DEMO };
