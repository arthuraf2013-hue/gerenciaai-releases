const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/database');
const secrets = require('./secretsService');

const EXTRACTION_PROMPT = `Você está analisando um documento anexado a uma venda de farmácia (pode ser uma receita médica, uma nota fiscal ou um comprovante).
Extraia os dados que conseguir identificar e responda SOMENTE com um JSON válido, sem markdown e sem texto fora do JSON, no formato exato:
{"medico": "", "crm": "", "numeroReceita": "", "dataReceita": "", "medicamentos": [""], "observacoes": ""}
Regras:
- Se um campo não aparecer no documento, deixe como string vazia ("") ou lista vazia ([]).
- Não invente informação que não esteja no documento.
- "medicamentos" deve listar cada medicamento/produto identificado no documento, um por item.
- "dataReceita" no formato AAAA-MM-DD quando possível.`;

const INVOICE_EXTRACTION_PROMPT = `Você está analisando uma NOTA DE COMPRA, ROMANEIO ou RECIBO DE ENTREGA de uma distribuidora — o documento que chega junto com a mercadoria comprada para reabastecer o estoque. Pode ser uma foto tirada com celular (às vezes torta, com reflexo de luz, papel amassado ou dobrado) ou um PDF/imagem digitalizada de um cupom impresso em impressora térmica ou matricial (letra pequena, monoespaçada).

Extraia os dados e responda SOMENTE com um JSON válido, sem markdown e sem texto fora do JSON, no formato exato:
{"fornecedor": "", "data": "", "numeroNota": "", "valorTotal": 0, "itens": [{"codigo": "", "descricao": "", "marca": "", "quantidade": 0, "precoUnitario": 0, "desconto": 0, "precoTotal": 0}]}

Regras importantes:
- O documento quase sempre tem anotações feitas à mão por cima do texto impresso — checkmarks, círculos, nomes de pessoas, rabiscos de conferência. IGNORE tudo isso completamente. Extraia só o que está IMPRESSO pela distribuidora.
- "quantidade" é a coluna de quantidade comprada (geralmente "QTD") — sempre um número, nunca string.
- "codigo" é o código do produto no catálogo da distribuidora (coluna tipo "Cód. Prod."), não confundir com código de barras.
- Se não conseguir ler um campo de algum item com confiança razoável, deixe "" ou 0 nesse campo específico — nunca invente um valor. Ainda assim, inclua a linha do item (com o que conseguiu ler) em vez de pular ela inteira.
- "fornecedor" normalmente aparece no cabeçalho do documento (nome da distribuidora).
- "data" no formato AAAA-MM-DD quando possível.
- Valores em reais no documento usam vírgula como separador decimal (ex: "15,35" significa quinze reais e trinta e cinco centavos, não 1535). Nos campos numéricos do JSON, sempre devolva o valor decimal correto (15.35), nunca o texto com vírgula.
- Este tipo de documento NÃO traz lote nem validade dos produtos — isso é preenchido manualmente depois por quem está conferindo a mercadoria física. Não invente esses campos.`;

const TUTOR_SYSTEM_PROMPT = `Você é a IA tutora do GerenciaAI, um sistema de gerenciamento de estoque com PDV. Seu papel é tirar dúvidas de quem está usando o sistema (operadores de caixa, gerentes, donos de negócio) sobre como usar cada função, e ajudar a interpretar mensagens de erro do sistema.

Responda sempre em português, de forma direta e prática — como alguém explicando pra um colega de trabalho, não como documentação técnica. Frases curtas. Não use markdown pesado (sem títulos ###, sem tabelas) — só texto corrido e, quando fizer sentido, uma lista simples com "-".

O que você sabe sobre o GerenciaAI:

PDV (venda): busca produto por código de barras (leitor), busca manual por nome, ou navega por categorias (botões gerados automaticamente a partir dos produtos cadastrados). Itens vão pro carrinho; clicar num item do carrinho seleciona ele; F4 cancela o item selecionado (pede autorização de um gerente/admin diferente do operador — nunca a própria pessoa). F2 finaliza a venda, Esc fecha janelas abertas. Antes de vender, é obrigatório abrir o caixa (informar quanto tem em dinheiro).

Pagamento: dinheiro, cartão de crédito/débito, Pix (gera QR Code de verdade, valor integral ou parcial — sem confirmação bancária automática, o operador confere no próprio banco e confirma manualmente), fiado (exige um cliente vinculado à venda) e "outro". Dá pra dividir uma venda entre métodos diferentes.

Clientes: cadastro com saldo de fiado (dívida por venda, pagamentos abatem o saldo) e pontos de fidelidade (acumulam automaticamente por venda vinculada a um cliente, resgatáveis como desconto — configurável em Configurações → Programa de fidelidade).

Desconto manual: na tela de pagamento, o operador pode solicitar um desconto em reais a critério do gerente (para clientes específicos ou negociações pontuais) — exige autorização de um gerente/admin diferente do operador, com motivo registrado. É separado do desconto de fidelidade — os dois podem existir juntos na mesma venda.

Fornecedores: cadastro simples + sugestão de compra baseada na velocidade de venda dos últimos 30 dias (estatística, não é IA).

Abastecimento: tela pra dar entrada em mercadoria recebida, lendo a nota de compra da distribuidora (foto de celular, PDF ou planilha CSV/Excel). A IA extrai os itens da nota; quem está conferindo a mercadoria física casa cada linha com o produto do sistema e preenche o lote e a validade daquele lote específico (a nota da distribuidora normalmente não traz isso). Cada lote fica registrado separado — um produto pode ter vários lotes com validades diferentes ao mesmo tempo. A tela também mostra uma recomendação de venda por validade (o que vence primeiro aparece primeiro), pra priorizar o que sai da prateleira.

Devolução: só funciona para vendas já finalizadas (separado do cancelamento, que só existe durante a venda aberta). Também exige autorização de gerente.

Produtos: cadastro com nome, categoria, preço, custo, estoque mínimo, foto (só depois do produto já existir). Perfis de negócio (Configurações → Perfis de negócio) definem campos extras que aparecem no cadastro — cada tipo de comércio pode ter seu próprio perfil (Farmácia já vem com lote/validade/receita, mas dá pra criar perfis novos do zero: Papelaria, Pet Shop, etc.). Importação/exportação de estoque via planilha Excel.

Alertas: estoque baixo (abaixo do mínimo configurado) e validade próxima (se o perfil ativo tiver isso ligado) — também dispara notificação nativa do Windows quando um produto cruza o mínimo numa venda.

Fiscal (NFC-e): a emissão real ainda não está implementada — exige CNPJ, Inscrição Estadual e certificado digital reais. A configuração e os campos fiscais do produto (NCM, CFOP, CST) já existem prontos para quando isso for implementado.

Painel: resumo de vendas por período (hoje/semana/mês), vendas por dia, produtos mais vendidos, devoluções, e um botão de resumo em linguagem natural gerado por IA.

Histórico: filtro por período (hoje/semana/mês/personalizado), mostra o método de pagamento de cada venda, exporta relatório em planilha.

Caixa: abertura obrigatória (informa o valor em dinheiro) antes de vender; fechamento mostra o valor esperado por método de pagamento e a diferença contra o valor contado.

Usuários e papéis: operador (só vê o PDV), gerente e admin (acesso a todas as telas). Só admin acessa Usuários e algumas partes de Configurações. PIN esquecido: existe um script "reset-admin-pin.js" que o dono/desenvolvedor roda pra voltar o PIN do admin para 0000.

Sincronização entre PDVs: opcional, via Firebase — numera automaticamente PDV001, PDV002... por CNPJ. Não é obrigatório para usar o app normalmente.

Sobre mensagens de erro: se o usuário colar uma mensagem de erro do sistema, tente explicar o que ela provavelmente significa em termos simples. Um padrão muito comum nesse sistema: erros do tipo "no such column" ou "no such table" quase sempre significam que o banco de dados local está desatualizado em relação a uma versão mais nova do app — a solução típica é fechar o app e apagar o arquivo do banco (ele fica em %APPDATA%\\gerenciaai\\gerenciaai.sqlite3) para ele recriar do zero, avisando que isso apaga os dados de teste. Não invente uma causa técnica diferente dessa para esse padrão específico de erro, é a causa real e conhecida deste sistema.

Se a pergunta for sobre algo que você genuinamente não sabe ou que foge do escopo do GerenciaAI, diga isso claramente em vez de inventar uma resposta.`;

function getAiSettings() {
  const db = getDb();
  const row = db.prepare('SELECT * FROM ai_settings WHERE id = ?').get('default');
  return { ...row, api_key: secrets.decrypt(row.api_key) };
}

/** Nunca devolve a api_key para o renderer — só se está configurada ou não. */
function getAiSettingsPublic() {
  const settings = getAiSettings();
  return {
    provider: settings.provider,
    modelo: settings.modelo,
    ativado: !!settings.ativado,
    temChaveConfigurada: !!settings.api_key,
  };
}

function updateAiSettings({ apiKey, modelo, ativado }) {
  const db = getDb();
  const current = getAiSettings();
  db.prepare(`UPDATE ai_settings SET api_key = ?, modelo = ?, ativado = ? WHERE id = 'default'`).run(
    apiKey !== undefined ? (apiKey ? secrets.encrypt(apiKey) : null) : secrets.encrypt(current.api_key),
    modelo || current.modelo,
    ativado ? 1 : 0
  );
  return { ok: true };
}

function mimeType(filePath, tipo) {
  if (tipo === 'pdf') return 'application/pdf';
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function callGemini({ apiKey, modelo, base64Data, mime, prompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      parts: [
        { text: prompt || EXTRACTION_PROMPT },
        { inline_data: { mime_type: mime, data: base64Data } },
      ],
    }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: 'Falha de conexão ao chamar a API de IA. Verifique sua internet.' };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    if (response.status === 400 || response.status === 403) {
      return { ok: false, error: 'Chave de API inválida ou sem permissão. Confira em Configurações.' };
    }
    if (response.status === 404) {
      return { ok: false, error: `O modelo "${modelo}" não está disponível para essa chave. Tente "gemini-3.1-flash-lite" em Configurações → IA.` };
    }
    if (response.status === 429) {
      return { ok: false, error: 'Limite de uso da API de IA atingido. Tente novamente em instantes.' };
    }
    return { ok: false, error: `Erro da API de IA (${response.status}): ${errText.slice(0, 200)}` };
  }

  const data = await response.json();
  const textOut = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textOut) return { ok: false, error: 'A IA não retornou conteúdo interpretável.' };

  try {
    return { ok: true, data: JSON.parse(textOut) };
  } catch {
    return { ok: false, error: 'A IA retornou um formato inesperado.' };
  }
}

/**
 * Extrai dados do anexo sob demanda (nunca automático) e persiste o
 * resultado em sale_attachments. Se a IA não estiver configurada, devolve
 * erro claro em vez de falhar silenciosamente.
 */
async function extractAttachment(attachmentId) {
  const db = getDb();
  const attachment = db.prepare('SELECT * FROM sale_attachments WHERE id = ?').get(attachmentId);
  if (!attachment) return { ok: false, error: 'Anexo não encontrado.' };

  const settings = getAiSettings();
  if (!settings.ativado || !settings.api_key) {
    return { ok: false, error: 'IA não configurada. Ative e informe a chave da API Gemini em Configurações.' };
  }

  db.prepare(`UPDATE sale_attachments SET extracao_status = 'processando' WHERE id = ?`).run(attachmentId);

  let fileBuffer;
  try {
    fileBuffer = fs.readFileSync(attachment.caminho);
  } catch {
    db.prepare(`UPDATE sale_attachments SET extracao_status = 'erro', extracao_json = ? WHERE id = ?`)
      .run(JSON.stringify({ error: 'Arquivo do anexo não foi encontrado no disco.' }), attachmentId);
    return { ok: false, error: 'Arquivo do anexo não foi encontrado no disco.' };
  }

  const result = await callGemini({
    apiKey: settings.api_key,
    modelo: settings.modelo,
    base64Data: fileBuffer.toString('base64'),
    mime: mimeType(attachment.caminho, attachment.tipo),
  });

  if (!result.ok) {
    db.prepare(`UPDATE sale_attachments SET extracao_status = 'erro', extracao_json = ? WHERE id = ?`)
      .run(JSON.stringify({ error: result.error }), attachmentId);
    return result;
  }

  db.prepare(`UPDATE sale_attachments SET extracao_status = 'concluida', extracao_json = ?, extraido_em = NOW_SYNCED() WHERE id = ?`)
    .run(JSON.stringify(result.data), attachmentId);

  return { ok: true, data: result.data };
}

/**
 * Resumo de vendas em linguagem natural — reaproveita a mesma
 * configuração/chave da extração de anexos, só que sem imagem, texto puro.
 */
async function summarizeSales({ sales, periodo }) {
  const settings = getAiSettings();
  if (!settings.ativado || !settings.api_key) {
    return { ok: false, error: 'IA não configurada. Ative e informe a chave da API Gemini em Configurações.' };
  }

  const resumoDados = sales.map((s) => ({
    total: s.total, status: s.status, itens: s.total_itens, metodos: s.metodos_pagamento,
  }));

  const prompt = `Você é um assistente de um sistema de PDV de farmácia. Analise os dados de vendas do período "${periodo}" abaixo e escreva um resumo curto (3-5 frases), em português, em tom direto e útil para o dono do negócio — destaque padrões, não liste cada venda.
Dados (JSON): ${JSON.stringify(resumoDados)}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.modelo}:generateContent?key=${settings.api_key}`;
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3 } };

  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, error: 'Falha de conexão ao chamar a API de IA.' };
  }
  if (!response.ok) {
    return { ok: false, error: `Erro da API de IA (${response.status}). Confira o modelo/chave em Configurações.` };
  }

  const data = await response.json();
  const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!texto) return { ok: false, error: 'A IA não retornou um resumo.' };

  return { ok: true, resumo: texto.trim() };
}

/**
 * IA tutora — responde dúvidas sobre como usar o sistema e ajuda a
 * interpretar mensagens de erro. Reaproveita a mesma configuração (chave
 * e modelo) da extração de anexos, para não exigir uma segunda chave.
 */
async function askTutor({ pergunta, historico }) {
  const settings = getAiSettings();
  if (!settings.ativado || !settings.api_key) {
    return { ok: false, error: 'IA não configurada. Ative e informe a chave da API Gemini em Configurações → IA.' };
  }

  // O histórico vira "contents" alternando user/model, com o prompt de
  // sistema entrando como a primeira mensagem do usuário — a API Gemini
  // não tem um papel "system" separado no formato v1beta usado aqui.
  const contents = [
    { role: 'user', parts: [{ text: TUTOR_SYSTEM_PROMPT }] },
    { role: 'model', parts: [{ text: 'Entendido — estou pronta pra ajudar com dúvidas do GerenciaAI.' }] },
    ...(historico || []).map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.texto }] })),
    { role: 'user', parts: [{ text: pergunta }] },
  ];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.modelo}:generateContent?key=${settings.api_key}`;
  const body = { contents, generationConfig: { temperature: 0.4 } };

  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, error: 'Falha de conexão ao chamar a API de IA.' };
  }
  if (!response.ok) {
    if (response.status === 404) {
      return { ok: false, error: `O modelo "${settings.modelo}" não está disponível para essa chave. Tente "gemini-3.1-flash-lite" em Configurações → IA.` };
    }
    return { ok: false, error: `Erro da API de IA (${response.status}). Confira o modelo/chave em Configurações.` };
  }

  const data = await response.json();
  const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!texto) return { ok: false, error: 'A IA não retornou uma resposta.' };

  return { ok: true, resposta: texto.trim() };
}

/**
 * Extração de nota de compra/romaneio (imagem foto de celular ou PDF) —
 * mesma infraestrutura da extração de receita, prompt diferente.
 */
async function extractPurchaseInvoice(filePath) {
  const settings = getAiSettings();
  if (!settings.ativado || !settings.api_key) {
    return { ok: false, error: 'IA não configurada. Ative e informe a chave da API Gemini em Configurações.' };
  }

  let fileBuffer;
  try {
    fileBuffer = fs.readFileSync(filePath);
  } catch {
    return { ok: false, error: 'Não foi possível ler o arquivo selecionado.' };
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';

  const result = await callGemini({
    apiKey: settings.api_key,
    modelo: settings.modelo,
    base64Data: fileBuffer.toString('base64'),
    mime,
    prompt: INVOICE_EXTRACTION_PROMPT,
  });

  if (!result.ok) return result;
  return { ok: true, data: result.data };
}

/**
 * Sugere categorias pra uma lista de produtos, usando as categorias
 * JÁ EXISTENTES como opção preferencial (só propõe categoria nova
 * quando nenhuma existente serve). Nunca aplica sozinha — só sugere,
 * quem decide se aceita é sempre a pessoa, revisando antes.
 */
async function sugerirCategorias(produtos, categoriasExistentes) {
  const settings = getAiSettings();
  if (!settings.ativado || !settings.api_key) {
    return { ok: false, error: 'IA não configurada. Ative e informe a chave da API Gemini em Configurações → IA.' };
  }
  if (!produtos || produtos.length === 0) return { ok: true, sugestoes: [] };

  const prompt = `Você está ajudando a organizar o catálogo de produtos de um comércio (na maioria das vezes farmácia, mas pode ser outro ramo). Vou te dar uma lista de produtos sem categoria, e as categorias que JÁ EXISTEM no catálogo.

Pra cada produto, sugira a categoria mais adequada — USE UMA CATEGORIA EXISTENTE sempre que fizer sentido, pra não espalhar o catálogo em categorias demais. Só proponha uma categoria NOVA se nenhuma das existentes servir de verdade.

Responda SOMENTE com um JSON válido, sem markdown e sem texto fora do JSON, no formato exato:
{"sugestoes": [{"produtoId": "", "categoria": ""}]}

Regras:
- Categorias devem ser curtas e genéricas (ex: "Medicamentos", "Higiene", "Cosméticos", "Bebidas"), nunca o nome específico de um produto.
- Se não tiver confiança nenhuma sobre a categoria de um produto específico, deixe "categoria": "" (vazio) pra esse item — melhor não sugerir do que sugerir errado.
- Inclua TODOS os produtos da lista na resposta, um item por produto, na mesma ordem.

Categorias já existentes: ${categoriasExistentes.length > 0 ? categoriasExistentes.join(', ') : '(nenhuma cadastrada ainda)'}

Produtos sem categoria (formato "id: nome"):
${produtos.map((p) => `${p.id}: ${p.nome}`).join('\n')}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.modelo}:generateContent?key=${settings.api_key}`;
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } };

  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, error: 'Falha de conexão ao chamar a API de IA.' };
  }
  if (!response.ok) {
    if (response.status === 404) {
      return { ok: false, error: `O modelo "${settings.modelo}" não está disponível para essa chave. Tente "gemini-3.1-flash-lite" em Configurações → IA.` };
    }
    return { ok: false, error: `Erro da API de IA (${response.status}). Confira o modelo/chave em Configurações.` };
  }

  const data = await response.json();
  const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!texto) return { ok: false, error: 'A IA não retornou sugestões.' };

  let parsed;
  try {
    parsed = JSON.parse(texto);
  } catch {
    return { ok: false, error: 'A IA retornou um formato inesperado.' };
  }
  if (!Array.isArray(parsed.sugestoes)) return { ok: false, error: 'A IA retornou um formato inesperado.' };

  return { ok: true, sugestoes: parsed.sugestoes.filter((s) => s.produtoId && s.categoria) };
}

module.exports = { getAiSettingsPublic, updateAiSettings, extractAttachment, summarizeSales, askTutor, extractPurchaseInvoice, sugerirCategorias };
