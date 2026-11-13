// Conteúdo dos treinamentos por perfil de negócio (public/treinamento-<perfil>.pdf).
// Para atualizar: edite os textos aqui e rode `npm run treinamentos` (gera os PDFs).
//
// Cada slide diz PARA QUEM é (papeis): caixa, garcom, cozinha, gerente, dono.
// "novo: true" marca o que entrou desde a versão anterior do treinamento.
// Os nomes de tela e botão têm que ser os que aparecem no app -- conferir antes
// de mudar um texto.

const ATUALIZADO_EM = 'novembro de 2026';

// ---------------------------------------------------------------- no caixa
const caixa = (perfil) => [
  {
    tipo: 'passos', kicker: 'Começo do turno', titulo: 'Entrar no sistema e abrir o caixa', papeis: ['caixa', 'garcom', 'gerente'],
    passos: [
      { t: 'Toque no seu nome e digite o seu PIN', d: 'Quem cria o seu usuário é o gerente. No primeiro acesso o sistema pede para você trocar o PIN por um só seu.' },
      { t: 'Abra o caixa antes da primeira venda', d: 'Informe quanto tem de dinheiro na gaveta agora. É com esse valor que o sistema confere o caixa no fim do turno.' },
      { t: 'Precisou mexer na gaveta? Use o menu Caixa', d: '**Sangria** para tirar dinheiro (levar ao cofre) e **Suprimento** para pôr troco. Sempre com o motivo: fica registrado.' },
    ],
    nota: { icone: 'escudo', texto: 'Tudo o que é feito fica com o nome de quem está logado. Nunca use o PIN de outra pessoa.' },
  },
  {
    tipo: 'cards', kicker: 'Vender', titulo: 'Três jeitos de pôr o produto no carrinho', papeis: ['caixa'],
    cards: [
      { icone: 'codigo', t: 'Leitor de código', d: 'Aponte o leitor: o produto entra na hora, com um bipe. Etiqueta de balança também funciona.' },
      { icone: 'busca', t: 'Busca pelo nome', d: 'Digite um pedaço do nome, do código ou da marca. Não precisa do nome inteiro.' },
      { icone: 'grade', t: 'Categorias com foto', d: 'Toque numa categoria e escolha o produto na grade. Bom para quem não decorou os nomes.' },
    ],
    nota: { icone: 'teclado', texto: 'Depois de adicionar, o PDV pode sugerir o que costuma sair junto ("quem compra isso, compra aquilo"). Um toque em "+ Adicionar" põe no carrinho.' },
  },
  {
    tipo: 'imagem', kicker: 'Tela de toque', titulo: 'Vender com o dedo', papeis: ['caixa', 'garcom', 'gerente'], imagem: 'toque.jpg', larga: true, novo: true,
    pontos: [
      'Com monitor de toque o sistema percebe sozinho: botões maiores, **carrinho fixo à direita** com **− e +** em cada item, e a busca em cartões grandes.',
      'Tocou num campo de número (PIN, quantidade, valor, peso)? Abre o **teclado de números** na tela. O primeiro número troca o valor que já estava lá.',
      '**Próximo** passa para o campo seguinte; **OK** fecha. Para nome e busca, sobe o teclado do Windows.',
      'Não reconheceu a tela? **Aparência → Tela de toque → Ligado**. Vale para o computador, para todos os usuários.',
    ],
  },
  {
    tipo: 'cards', kicker: 'Do seu jeito', titulo: 'Menu, letra e PDV do jeito de cada um', papeis: ['caixa', 'garcom', 'gerente'], novo: true,
    cards: [
      { icone: 'estrela', t: 'Menu da esquerda', d: 'Botão **Menu** no rodapé: a estrela fixa a tela no topo, o olho esconde o que você não usa. Tela escondida continua no Ctrl+K.', novo: true },
      { icone: 'paleta', t: 'Aparência', d: 'Tamanho da letra, espaçamento (compacto para notebook) e tema claro ou escuro. Fica salvo no seu usuário.', novo: true },
      { icone: 'grade', t: 'Mais espaço no PDV', d: '**Categorias** esconde os botões; em **Mais** dá para trocar por lista e esconder "Vendidos recentemente". **Modo foco** some com o menu.', novo: true },
    ],
  },
  {
    tipo: 'cards', kicker: 'Receber', titulo: 'Formas de pagamento', papeis: ['caixa'],
    cards: [
      { icone: 'dinheiro', t: 'Dinheiro, cartão e fiado', d: 'Dá para dividir a conta em várias formas. Em dinheiro, o sistema calcula o troco.' },
      { icone: 'pix', t: 'Pix', d: 'QR com o valor já preenchido. Com o **Pix automático** ligado, o pagamento se confirma sozinho, sem conferir o celular.', novo: true },
      { icone: 'maquininha', t: 'Maquininha integrada', d: 'Com a Mercado Pago Point ligada, o valor vai sozinho para a maquininha. Aprovou, a venda baixa sem digitar nada.', novo: true },
    ],
    nota: { icone: 'recibo', texto: 'Se a loja emite NFC-e, a nota sai ao finalizar. Bandeira e autorização da maquininha vão para a nota sozinhas.' },
  },
  {
    tipo: 'cards', kicker: 'Clientes', titulo: 'Cliente na venda e ficha do cliente', papeis: ['caixa', 'gerente'],
    cards: [
      { icone: 'estrela', t: 'Cliente e fidelidade', d: 'Vincule o cliente à venda: ele junta pontos que viram desconto e a compra entra no histórico dele.' },
      { icone: 'documento', t: 'Ficha do cliente', d: `Em Clientes, clique no nome: compras com filtro de datas, o que levou e ${perfil.ficha}.`, novo: true },
      { icone: 'conversa', t: 'Clientes que sumiram', d: 'Lista quem passou do próprio ritmo de compra. Um botão abre o WhatsApp com a mensagem pronta.' },
    ],
  },
  {
    tipo: 'passos', kicker: 'Segurança', titulo: 'Cancelamento e devolução', papeis: ['caixa', 'gerente'],
    passos: [
      { t: 'Antes do pagamento, cancelar item é livre', d: 'Use **−** para tirar uma unidade, ou **Cancelar** na linha para tirar o item (ou selecione a linha e aperte F4).' },
      { t: 'Depois que entrou pagamento, precisa do gerente', d: 'Outra pessoa autoriza com o PIN dela. Ninguém autoriza o próprio cancelamento, nem o gerente.' },
      { t: 'Cliente voltou outro dia? É devolução', d: 'Menu Devolução: escolha a venda, os itens, e o estoque volta. Fica tudo na Auditoria.' },
    ],
  },
  {
    tipo: 'passos', kicker: 'Fim do turno', titulo: 'Fechar o caixa', papeis: ['caixa', 'gerente'],
    passos: [
      { t: 'Menu Caixa → Fechar caixa', d: 'O sistema mostra quanto espera em cada forma de pagamento.' },
      { t: 'Conte o dinheiro e confira Pix e cartões', d: 'Digite o que contou. Pix e cartões podem ser conferidos com o extrato ou com a maquininha.' },
      { t: 'O sistema mostra a diferença', d: 'Sobra ou falta fica registrada no fechamento, com o seu nome, para o gerente ver depois.' },
    ],
  },
  {
    tipo: 'teclas', kicker: 'Cola rápida', titulo: 'Atalhos que poupam tempo', papeis: ['caixa', 'gerente'],
    teclas: [
      ['F2', 'Finalizar a venda'], ['F4', 'Cancelar o item selecionado'],
      ['Esc', 'Fechar a janela aberta, sem salvar'], ['Ctrl+K', 'Pular para qualquer tela pelo nome'],
      ['Tab', 'Ir para o próximo campo ou botão'], ['↑ ↓', 'Andar pelo menu e pelas listas'],
      ['Enter', 'Confirmar ou salvar o formulário'], ['?', 'Ajuda com todos os atalhos, em qualquer tela'],
    ],
  },
];

// ------------------------------------------- pedidos de fora e celular
const foraECelular = () => [
  {
    tipo: 'cards', kicker: 'Pedidos que chegam sozinhos', titulo: 'Loja online, WhatsApp e entregas', papeis: ['caixa', 'gerente'], novo: true,
    cards: [
      { icone: 'globo', t: 'Vitrine online', d: 'O site da loja com o catálogo. O cliente pede para retirar, consumir no local ou receber, e pode pagar o Pix no site.', novo: true },
      { icone: 'caixa', t: 'Separação', d: 'Todo pedido de fora cai aqui. Só vai para a cozinha ou para a conta depois que alguém aceita (Pix já pago entra sozinho).' },
      { icone: 'conversa', t: 'Robô do WhatsApp', d: 'Atende pedido, orçamento, agendamento e reserva. Avisa o cliente quando o pedido fica pronto e quando sai para entrega.' },
      { icone: 'moto', t: 'Delivery e Orçamentos', d: 'Fila de entregas com rota e entregador. Orçamento não mexe em estoque até virar venda.' },
    ],
  },
  {
    tipo: 'passos', kicker: 'Senhas e painel na TV', titulo: 'Chamar o cliente pela senha', papeis: ['caixa', 'cozinha'], novo: true,
    passos: [
      { t: 'A senha nasce com a venda de balcão', d: 'Com o painel ligado, cada venda finalizada ganha uma senha. Em Senhas também dá para gerar uma senha avulsa.' },
      { t: 'Pedido pronto? Toque em Chamar', d: 'A senha e o primeiro nome aparecem na TV, com aviso sonoro. **De novo** repete a chamada na hora.' },
      { t: 'Entregou, toque em Entregue', d: 'A senha sai do painel. A TV pode ser qualquer navegador (link) ou o Vértice.' },
    ],
    nota: { icone: 'tv', texto: 'Ligar o painel: Configurações → Senhas e Vértice (gerente).' },
  },
  {
    tipo: 'cards', kicker: 'App do celular', titulo: 'O sistema no celular de cada um', papeis: ['caixa', 'garcom', 'gerente', 'dono'], novo: true,
    cards: [
      { icone: 'link', t: 'Parear o celular', d: 'Configurações → Celular gera um código de 6 dígitos. No celular, abra o app e digite o código.' },
      { icone: 'carrinho', t: 'PDV móvel', d: 'Vender pelo celular: câmera como leitor, cliente, desconto, várias formas e recibo. Precisa de internet.' },
      { icone: 'grafico', t: 'Painel da loja', d: 'Faturamento do dia, 7 e 30 dias, mais vendidos, por operador, mesas e pedidos ao vivo. Várias lojas no mesmo celular.' },
      { icone: 'etiqueta', t: 'Gerente no celular', d: 'Muda preço, acerta estoque e cadastra produto pelo celular, sem ir ao computador.' },
    ],
  },
];

// ---------------------------------------------------------------- gestão
const gestao = () => [
  {
    tipo: 'cards', kicker: 'Cadastro', titulo: 'Produtos sem retrabalho', papeis: ['gerente', 'dono'],
    cards: [
      { icone: 'documento', t: 'Imposto pelo NCM', d: 'Digite o NCM e o sistema preenche CFOP, CST e CEST com o que a loja já usa. Só preenche o que está vazio; confira antes de salvar.', novo: true },
      { icone: 'copia', t: 'Duplicar', d: 'Cria um produto novo com os mesmos dados, para variações (tamanho P, M, G). Código de barras não vai junto.', novo: true },
      { icone: 'nuvem', t: 'Migrar do sistema antigo', d: 'Produtos → Ferramentas: importa a planilha de qualquer sistema. A IA ajuda a ligar as colunas.', novo: true },
      { icone: 'grade', t: 'Categorias e duplicados', d: 'Aba Categorias (renomear move todos os produtos) e "Ver duplicados" para limpar cadastro repetido.' },
    ],
  },
  {
    tipo: 'cards', kicker: 'Compras e estoque', titulo: 'Abastecimento', papeis: ['gerente', 'dono'], novo: true,
    cards: [
      { icone: 'documento', t: 'Notas de compra (XML)', d: 'Importe o XML da nota: o sistema liga os itens aos produtos, atualiza o custo médio e lança a conta a pagar.', novo: true },
      { icone: 'lista', t: 'Pedidos de compra', d: 'Monte o pedido, mande ao fornecedor pelo WhatsApp e dê baixa no que chegar.', novo: true },
      { icone: 'check', t: 'Inventário', d: 'Contagem com a loja aberta: o que for vendido durante a contagem entra na conta. O ajuste só sai no fechamento.', novo: true },
      { icone: 'caixa', t: 'Receber mercadoria', d: 'Sem XML? Foto, PDF ou planilha da nota. Item novo se cadastra ali mesmo.' },
    ],
  },
  {
    tipo: 'cards', kicker: 'Antes de virar prejuízo', titulo: 'Alertas', papeis: ['caixa', 'gerente'],
    nota: { icone: 'check', texto: 'A tela de Alertas abre com um resumo no topo e mostra só o que tem pendência. O que está em dia aparece numa linha: "Tudo certo em".' },
    cards: [
      { icone: 'alerta', t: 'Vai faltar em breve', d: 'Usa o ritmo real de venda dos últimos 30 dias e mostra em quantos dias acaba.' },
      { icone: 'grafico', t: 'Margem fora do padrão', d: 'Compara a margem com a da categoria. Pega custo que subiu e preço que não acompanhou.' },
      { icone: 'etiqueta', t: 'Descontar por validade', d: 'Sugere preço com desconto para o que vence logo. O preço volta sozinho depois da data.' },
    ],
  },
  {
    tipo: 'cards', kicker: 'Dinheiro da loja', titulo: 'Financeiro', papeis: ['gerente', 'dono'], novo: true, colunas: 3,
    cards: [
      { icone: 'recibo', t: 'Resumo e despesas', d: 'Contas a pagar com as vencidas em destaque, despesa fixa que se repete todo mês.' },
      { icone: 'usuarios', t: 'Contas a receber', d: 'Fiado e cobranças, com quem está atrasado.' },
      { icone: 'grafico', t: 'Fluxo de caixa e DRE', d: 'O que entra e sai por dia, e o resultado do mês: receita, custo e despesa.' },
      { icone: 'setas', t: 'Conciliação bancária', d: 'Importe o extrato (OFX) e ligue cada linha à conta certa.' },
      { icone: 'estrela', t: 'Comissões e metas', d: 'Comissão por operador e acompanhamento de metas.' },
      { icone: 'documento', t: 'Contabilidade', d: 'Lançamentos, razão e balancete para o escritório contábil.' },
    ],
    nota: { icone: 'ajuda', texto: 'Algumas abas dependem do módulo contratado. O que não estiver liberado aparece avisando.' },
  },
  {
    tipo: 'cards', kicker: 'Imposto sem susto', titulo: 'Fiscal', papeis: ['gerente', 'dono'], novo: true,
    cards: [
      { icone: 'check', t: 'Cadastro fiscal', d: 'Mostra produto com NCM, CFOP ou CST faltando e corrige em lote, só onde está vazio ou errado.' },
      { icone: 'documento', t: 'Relatório do MEI', d: 'A receita do mês no formato da declaração: comércio e serviço, com e sem nota.' },
      { icone: 'caixa', t: 'Pacote do contador', d: 'Um arquivo com planilhas, XMLs de compra e de venda e o relatório do mês.' },
      { icone: 'ajuda', t: 'Painel e Glossário', d: 'Estimativa do imposto e do limite do regime, e o significado de cada sigla.' },
    ],
    nota: { icone: 'escudo', texto: 'Os valores de imposto são estimativa para planejar. A apuração oficial continua com o contador.' },
  },
  {
    tipo: 'cards', kicker: 'Quem faz o quê', titulo: 'Painéis, equipe e permissões', papeis: ['gerente', 'dono'],
    cards: [
      { icone: 'grafico', t: 'Painel e Painel executivo', d: 'Vendas, mais vendidos, lucro por produto e os números do mês num lugar só.', novo: true },
      { icone: 'usuarios', t: 'Equipe', d: 'Cadastro da equipe, férias e informações de cada pessoa.', novo: true },
      { icone: 'chave', t: 'Usuários e permissões', d: 'Crie operador, garçom e gerente. Em "Permissões do ERP", tire do gerente as áreas que ele não deve ver.' },
      { icone: 'escudo', t: 'Auditoria', d: 'Cancelamentos, descontos e autorizações, com quem pediu e quem autorizou.' },
    ],
  },
  {
    tipo: 'cards', kicker: 'Deixar redondo', titulo: 'Configurações que valem a pena', papeis: ['gerente', 'dono'], colunas: 3,
    cards: [
      { icone: 'impressora', t: 'Impressora', d: 'Escolha a padrão para não perguntar toda vez. Restaurante: impressora da cozinha.' },
      { icone: 'nuvem', t: 'Backup', d: 'Cópia automática conferida. Ligue a cópia na conta Google para não perder nada.' },
      { icone: 'celular', t: 'Celular', d: 'Gerar código de pareamento e escolher o que cada celular pode fazer.' },
      { icone: 'conversa', t: 'WhatsApp', d: 'Conectar o número e ligar o robô e os avisos automáticos.' },
      { icone: 'pix', t: 'Pix automático e maquininha', d: 'Conta do Mercado Pago para o Pix que confirma sozinho e a Point.', novo: true },
      { icone: 'documento', t: 'Fiscal (NFC-e)', d: 'Certificado, série e ambiente para emitir a nota no caixa.' },
    ],
  },
];

// ------------------------------------------------------------ restaurante
const salaoECozinha = () => [
  {
    tipo: 'imagem', kicker: 'Salão', titulo: 'Mesas: abrir, juntar e acompanhar', papeis: ['caixa', 'garcom'], imagem: 'mesas.jpg', larga: true,
    pontos: [
      'Cor diz o estado: **livre**, **ocupada**, **aguardando limpeza** e **reservada**.',
      'Ao abrir, informe quantas pessoas: serve para dividir a conta.',
      '**Juntar mesas** vira uma comanda só; separar devolve cada mesa.',
      'Fechar a conta manda a mesa para limpeza, não direto para livre.',
    ],
  },
  {
    tipo: 'cards', kicker: 'Comanda', titulo: 'Conta por pessoa, sem confusão', papeis: ['caixa', 'garcom'], novo: true,
    cards: [
      { icone: 'usuarios', t: 'Pessoas com nome', d: 'Cada pessoa da mesa pode ter nome. O item já nasce dela ("lançar para"), e dá para mover depois.', novo: true },
      { icone: 'recibo', t: 'Fechar por pessoa ou a mesa', d: 'Cada um paga a sua parte (e pode ir embora) ou a mesa inteira de uma vez. Taxa de serviço de 10% sugerida e editável.', novo: true },
      { icone: 'usuario', t: 'Ligar a um cliente', d: 'O ícone de pessoa liga o nome a um cliente do cadastro: o consumo vai para a ficha dele.', novo: true },
      { icone: 'chef', t: 'Observação e cozinha', d: '"Sem cebola", "ao ponto": vai junto para a cozinha. Só sai o que ainda não foi enviado.' },
    ],
  },
  {
    tipo: 'imagem', kicker: 'Pagamento individual', titulo: 'Cada um paga a sua parte', papeis: ['caixa', 'garcom'], imagem: 'parte.jpg', novo: true,
    pontos: [
      'No grupo da pessoa, toque em **Pagar a parte**: cobra só o que ela consumiu, já com a taxa de serviço.',
      'Dinheiro, cartão, Pix ou maquininha, igual ao pagamento da mesa. **Concluir** e a mesa continua aberta.',
      'Quem pagou fica com "pagou R$ ..." na comanda; no rodapé aparece quanto já entrou e quanto falta.',
      'O resto da mesa fecha no **Ir para pagamento** de sempre. Quem já pagou não pode ser removido da mesa.',
    ],
  },
  {
    tipo: 'cards', kicker: 'No celular do garçom', titulo: 'Atender a mesa sem ir ao caixa', papeis: ['garcom'], novo: true,
    cards: [
      { icone: 'mesa', t: 'Painel de mesas', d: 'As mesas ao vivo, com filtro Minhas, Livres e Todas. Toque numa mesa para ver a comanda por pessoa.' },
      { icone: 'chef', t: 'Status da cozinha', d: 'Cada item mostra aguardando, preparando ou pronto. Garçom sabe a hora de buscar.' },
      { icone: 'nuvem', t: 'Funciona sem internet', d: 'O item lançado fica na fila do celular e vai sozinho quando a conexão volta.' },
      { icone: 'chave', t: 'Cancelar e limpar', d: 'Cancelar item pede o PIN do gerente (se a loja exigir). "Marcar como limpa" libera a mesa.' },
    ],
    nota: { icone: 'celular', texto: 'No celular de operador também dá para juntar, separar, transferir e fechar a conta, com troco e QR do Pix.' },
  },
  {
    tipo: 'imagem', kicker: 'Cozinha', titulo: 'Painel de Cozinha e impressora', papeis: ['cozinha', 'garcom'], imagem: 'cozinha.jpg', larga: true, novo: true,
    pontos: [
      'Os pedidos aparecem por mesa e se atualizam sozinhos.',
      '**Começar a preparar** e **Marcar como pronto**: o garçom vê no celular na hora.',
      'Com impressora da cozinha (rede), cada item sai uma vez só. Reimprimir sai igual.',
      'Pedido do site ou do WhatsApp só chega depois de aceito na Separação.',
    ],
  },
  {
    tipo: 'cards', kicker: 'Cliente pede sozinho', titulo: 'QR da mesa e reservas', papeis: ['garcom', 'caixa', 'gerente'], novo: true,
    cards: [
      { icone: 'qr', t: 'QR do cardápio na mesa', d: 'O cliente lê o QR, vê o cardápio e pede. O pedido entra na conta daquela mesa, no nome de quem pediu.', novo: true },
      { icone: 'escudo', t: 'QR vazou? Troque', d: 'Em Configurações (Vitrine online → QR das mesas) gere um QR novo; o antigo para de valer.', novo: true },
      { icone: 'calendario', t: 'Reservas', d: 'Nome, telefone, pessoas, dia e hora. Reserva do WhatsApp chega sozinha e o robô confirma 1 hora antes.' },
    ],
  },
  {
    tipo: 'imagem', kicker: 'Cadastro de prato', titulo: 'Prato feito na hora: sem estoque do prato', papeis: ['gerente', 'dono'], imagem: 'prato.jpg', larga: true, novo: true,
    pontos: [
      'Em Produtos → **Novo item do cardápio**, escolha o tipo: **prato feito na hora**, **produto com estoque** (bebida, sobremesa pronta) ou **taxa**.',
      'Prato feito na hora nunca trava por "estoque insuficiente": quem baixa são os **insumos da ficha técnica**.',
      'O custo vem da ficha, e o sistema mostra o **CMV** (custo sobre o preço) com cor: verde até 30%.',
      'Custo alto? Um botão sugere o preço para o custo ficar em 30%.',
    ],
  },
  {
    tipo: 'imagem', kicker: 'Ficha técnica', titulo: 'A receita no mesmo cadastro', papeis: ['gerente', 'dono'], imagem: 'ficha.jpg', novo: true,
    pontos: [
      'Digite o insumo e a quantidade em **g, kg, ml ou l**: o sistema converte sozinho.',
      'Faz em panela? Digite a receita inteira e quantas **porções ela rende**; o sistema divide.',
      'Insumo que não existe? **Crie ali mesmo** pelo preço que pagou ("R$ 25,90 por 5 kg").',
      'Um **Salvar** guarda o prato e a ficha juntos. **Duplicar** copia a ficha para as variações.',
    ],
  },
  {
    tipo: 'imagem', kicker: 'Insumos no dia a dia', titulo: 'Registrar a compra de uma vez', papeis: ['gerente', 'dono'], imagem: 'compra.jpg', larga: true, novo: true,
    pontos: [
      'Insumos → **Registrar compra**: a nota do hortifruti inteira, linha por linha.',
      '"Trazer os que estão acabando" monta a lista sozinho.',
      'O custo novo aparece com ▲ ou ▼ e, se você quiser, já atualiza o custo dos pratos.',
    ],
  },
  {
    tipo: 'imagem', kicker: 'Insumos no dia a dia', titulo: 'Conferir o estoque da despensa', papeis: ['gerente', 'cozinha'], imagem: 'conferir.jpg', larga: true, novo: true,
    pontos: [
      'Insumos → **Conferir estoque**: conte e digite. Só o que você preencher é corrigido.',
      'A diferença aparece em quantidade e em reais, e fica registrada com o seu nome.',
      'O relatório **consumo pela ficha × inventário** mostra o que saiu além da receita: porção maior, desperdício ou desvio.',
      'Filtros **Acabando** e **Fora das fichas**; cada insumo mostra em quantos pratos entra.',
    ],
  },
  {
    tipo: 'imagem', kicker: 'Cardápio do dia', titulo: 'Liga e desliga, sem abrir cadastro', papeis: ['caixa', 'cozinha', 'gerente'], imagem: 'cardapio.jpg', larga: true, novo: true,
    pontos: [
      'Restaurante → **Cardápio do dia**: toque no prato para tirar ou pôr. Acabou o feijão? Desligue.',
      'Liga ou tira a seção inteira; "Tirar todos" para montar o de amanhã.',
      'Mostra quantas porções o estoque dos insumos ainda rende.',
      '**Imprimir** sai só com o que está ligado. O **Cardápio Digital** é o cardápio fixo, para tablet ou TV.',
    ],
  },
  {
    tipo: 'cards', kicker: 'Sem desperdício', titulo: 'Perdas e item montado na hora', papeis: ['caixa', 'gerente'],
    cards: [
      { icone: 'lixo', t: 'Desperdício', d: 'Prato que não saiu ou insumo estragado. O valor perdido é sugerido pela ficha técnica.' },
      { icone: 'paleta', t: 'Produto personalizado', d: 'Busque "personalizado" na venda ou na comanda e monte o item (meia pizza de cada sabor). O sistema sugere o preço.' },
      { icone: 'insumo', t: 'Ajustes', d: 'Em Produtos → Ajustes, informe quanto de insumo o personalizado gastou de verdade. Só a diferença é ajustada.' },
    ],
  },
];

// -------------------------------------------------- blocos de outros ramos
const vendaPorPeso = () => ({
  tipo: 'cards', kicker: 'Balança', titulo: 'Venda por peso', papeis: ['caixa', 'gerente'],
  cards: [
    { icone: 'balanca', t: 'Balança no computador', d: 'Balança ligada no computador: o peso entra direto no item vendido por kg.' },
    { icone: 'codigo', t: 'Etiqueta da balança', d: 'Balança que imprime etiqueta: o leitor lê o código e o sistema entende produto e peso (ou valor).' },
    { icone: 'etiqueta', t: 'Código na balança', d: 'No cadastro do produto por kg, informe o código que ele tem na balança.' },
  ],
});

const validade = () => ({
  tipo: 'cards', kicker: 'Validade', titulo: 'Vender antes de vencer', papeis: ['caixa', 'gerente'],
  cards: [
    { icone: 'calendario', t: 'Validade no cadastro', d: 'Produto com validade avisa no carrinho quando está perto de vencer.' },
    { icone: 'etiqueta', t: 'Descontar por validade', d: 'Em Alertas, o sistema sugere o desconto. Um clique aplica; o preço volta sozinho depois da data.' },
    { icone: 'lixo', t: 'Venceu mesmo assim', d: 'Registre como perda para o estoque e o resultado do mês ficarem certos.' },
  ],
});

const PERFIS = {
  padrao: {
    nome: 'Comércio', subtitulo: 'Do caixa à gestão, com tudo o que entrou de novo no sistema.',
    ficha: 'o que ele costuma levar (tamanho, cor)',
    especifico: null,
  },
  farmacia: {
    nome: 'Farmácia', subtitulo: 'Caixa, receitas, controlados e a gestão da farmácia.',
    ficha: 'os selos de controlado e de exige receita',
    especifico: {
      titulo: 'Na farmácia', texto: 'Receita, controlado, lote e validade.', papeis: ['caixa', 'gerente'],
      slides: () => [
        {
          tipo: 'cards', kicker: 'Farmácia', titulo: 'Receita e controlados', papeis: ['caixa', 'gerente'],
          cards: [
            { icone: 'remedio', t: 'Aviso no carrinho', d: 'Produto marcado como controlado ou "exige receita" avisa na hora da venda.' },
            { icone: 'documento', t: 'Anexos da venda', d: 'Anexe a foto ou o PDF da receita à venda, com médico, número e data. A IA ajuda a ler.' },
            { icone: 'lista', t: 'Livro de controlados', d: 'No Painel: as vendas de controlado no período, com princípio ativo, para imprimir.' },
          ],
        },
        validade(),
      ],
    },
  },
  petshop: {
    nome: 'Petshop', subtitulo: 'Caixa, ficha do pet, banho e tosa e a gestão da loja.',
    ficha: 'os animais com a próxima vacina e o vermífugo',
    especifico: {
      titulo: 'No petshop', texto: 'O pet no centro do atendimento.', papeis: ['caixa', 'gerente'],
      slides: () => [{
        tipo: 'cards', kicker: 'Petshop', titulo: 'Ficha do pet e lembretes', papeis: ['caixa', 'gerente'],
        cards: [
          { icone: 'pata', t: 'Ficha do pet', d: 'Cada cliente com seus animais: espécie, raça, vacinas e vermífugo.' },
          { icone: 'sino', t: 'Lembrete de vacina', d: 'O sistema lista o que vence nos próximos dias. "Enviar lembrete" abre o WhatsApp com a mensagem pronta.' },
          { icone: 'tesoura', t: 'Banho e tosa', d: 'Cadastrados como serviço: não têm estoque e entram na mesma venda dos produtos.' },
        ],
      }],
    },
  },
  armazem: {
    nome: 'Armazém e mercearia', subtitulo: 'Caixa rápido, balança, validade e a gestão do mercado.',
    ficha: 'o fiado e as entregas',
    especifico: {
      titulo: 'No armazém', texto: 'Peso e validade no dia a dia.', papeis: ['caixa', 'gerente'],
      slides: () => [vendaPorPeso(), validade()],
    },
  },
  salao_beleza: {
    nome: 'Salão de beleza', subtitulo: 'Agenda, serviços com material e a gestão do salão.',
    ficha: 'os horários marcados (próximos e anteriores)',
    especifico: {
      titulo: 'No salão', texto: 'Agenda, tabela de serviços e material usado.', papeis: ['caixa', 'gerente'],
      slides: () => [
        {
          tipo: 'cards', kicker: 'Salão', titulo: 'Agenda e tabela de serviços', papeis: ['caixa', 'gerente'],
          cards: [
            { icone: 'calendario', t: 'Agenda', d: '"+ Novo agendamento" por profissional. Status: agendado, confirmado, concluído ou cancelado.' },
            { icone: 'lista', t: 'Preços de Serviço', d: '**Tabela de Preços** para mostrar ao cliente e **Consulta Rápida** para achar o preço na hora.', novo: true },
            { icone: 'estrela', t: 'Comissões', d: 'Comissão por quem lançou a venda e metas, em Financeiro → Comissões e metas.', novo: true },
          ],
        },
        {
          tipo: 'cards', kicker: 'Salão', titulo: 'Material gasto em cada serviço', papeis: ['gerente'], novo: true,
          cards: [
            { icone: 'paleta', t: 'Material do serviço', d: 'No cadastro do serviço, diga o que ele gasta (a tintura da coloração). Sai do estoque a cada venda.', novo: true },
            { icone: 'dinheiro', t: 'Cobrar no preço', d: 'Marque "Cobrar no preço" para somar o custo do material ao serviço; desmarque se o preço já cobre.', novo: true },
            { icone: 'insumo', t: 'Ajustes', d: 'Gastou mais ou menos? Produtos → Ajustes: informe o real e só a diferença é corrigida.', novo: true },
          ],
        },
      ],
    },
  },
  padaria: {
    nome: 'Padaria e confeitaria', subtitulo: 'Balcão, balança, receitas, mesas e a gestão da padaria.',
    ficha: 'as reservas pelo telefone e o consumo dela nas mesas',
    especifico: {
      titulo: 'Na padaria', texto: 'Balança, validade, receitas e o salão.', papeis: ['caixa', 'garcom', 'cozinha', 'gerente'],
      slides: () => [vendaPorPeso(), validade(), ...salaoECozinha()],
    },
  },
  otica: {
    nome: 'Ótica', subtitulo: 'Caixa, receita óptica, garantia e a gestão da ótica.',
    ficha: 'as receitas ópticas',
    especifico: {
      titulo: 'Na ótica', texto: 'Receita e garantia acompanhando o cliente.', papeis: ['caixa', 'gerente'],
      slides: () => [{
        tipo: 'cards', kicker: 'Ótica', titulo: 'Receita óptica e garantia', papeis: ['caixa', 'gerente'],
        cards: [
          { icone: 'oculos', t: 'Receita no cliente', d: '"+ Nova receita" com grau e tipo de lente. As receitas ficam na ficha do cliente.' },
          { icone: 'documento', t: 'Tudo na ficha', d: 'Na ficha do cliente ficam as receitas em ordem e o que ele comprou com cada uma.', novo: true },
          { icone: 'ferramenta', t: 'Ajustes e consertos', d: 'Cadastre como serviço: entram na venda sem mexer em estoque.' },
        ],
      }],
    },
  },
  material_construcao: {
    nome: 'Material de construção', subtitulo: 'Orçamento, entrega, garantia e a gestão da loja.',
    ficha: 'os orçamentos e a garantia de cada item',
    especifico: {
      titulo: 'Na loja de material', texto: 'Orçamento antes da venda e entrega na obra.', papeis: ['caixa', 'gerente'],
      slides: () => [{
        tipo: 'passos', kicker: 'Material de construção', titulo: 'Do orçamento à entrega', papeis: ['caixa', 'gerente'],
        passos: [
          { t: 'Orçamentos → Novo orçamento', d: 'Monte a lista do cliente. Orçamento não mexe em estoque nem em caixa.' },
          { t: 'Cliente fechou? Converter em venda', d: 'Os itens viram uma venda de verdade, com o preço atual do cadastro. O estoque sai só agora.' },
          { t: 'Entrega na obra pelo Delivery', d: 'Endereço, veículo e entregador. O cliente recebe aviso no WhatsApp quando sai para entrega.' },
        ],
        nota: { icone: 'escudo', texto: 'Com a garantia em meses no produto, a ficha do cliente mostra até quando cada item está coberto.' },
      }],
    },
  },
  restaurante: {
    nome: 'Restaurante', subtitulo: 'Salão, cozinha, cardápio, fichas técnicas e a gestão do restaurante.',
    ficha: 'as reservas pelo telefone e o consumo dela nas mesas',
    especifico: {
      titulo: 'Salão e cozinha', texto: 'Mesas, garçom no celular, cozinha, cardápio e fichas técnicas.', papeis: ['caixa', 'garcom', 'cozinha', 'gerente'],
      slides: () => salaoECozinha(),
    },
  },
};

/** Monta a lista de slides de um perfil, com capa, roteiro, seções e fim. */
function montarDeck(id) {
  const p = PERFIS[id];
  const secoes = [
    { titulo: 'No caixa', texto: 'Do login ao fechamento, o que todo operador precisa saber.', papeis: ['caixa', 'gerente'], slides: caixa(p) },
    ...(p.especifico ? [{ titulo: p.especifico.titulo, texto: p.especifico.texto, papeis: p.especifico.papeis, slides: p.especifico.slides() }] : []),
    { titulo: 'Pedidos de fora e celular', texto: 'Loja online, WhatsApp, senhas na TV e o app do celular.', papeis: ['caixa', 'garcom', 'gerente'], slides: foraECelular() },
    { titulo: 'Gestão', texto: 'Para gerente e dono: cadastro, compras, financeiro e fiscal.', papeis: ['gerente', 'dono'], slides: gestao() },
  ];
  const papeis = [...new Set(secoes.flatMap((s) => s.papeis))];
  const slides = [{ tipo: 'capa' }, { tipo: 'agenda' }];
  secoes.forEach((s, i) => {
    slides.push({ tipo: 'secao', numero: i + 1, titulo: s.titulo, texto: s.texto, papeis: s.papeis });
    slides.push(...s.slides);
  });
  slides.push({ tipo: 'fim' });
  return {
    id, nome: p.nome, subtitulo: p.subtitulo, atualizadoEm: ATUALIZADO_EM, papeis, slides,
    secoes: secoes.map((s) => ({ titulo: s.titulo, papeis: s.papeis, itens: s.slides.map((sl) => ({ titulo: sl.titulo, novo: !!sl.novo })) })),
  };
}

module.exports = { PERFIS, montarDeck, ATUALIZADO_EM };
