/**
 * Respostas da SEFAZ em português simples, com o que fazer. Só entram
 * códigos de significado estável no Manual de Orientação do Contribuinte;
 * qualquer outro código cai na mensagem genérica com o texto da SEFAZ.
 */

const AUTORIZADOS = new Set(['100', '150']); // 150 = autorizada fora de prazo (ex.: contingência)

const CODIGOS = {
  '108': ['O serviço da SEFAZ está parado no momento.', 'A nota fica em contingência e é reenviada sozinha quando a SEFAZ voltar.'],
  '109': ['O serviço da SEFAZ está parado sem previsão.', 'A nota fica em contingência e é reenviada sozinha quando a SEFAZ voltar.'],
  '204': ['Essa nota já tinha sido recebida pela SEFAZ.', 'Use "Reenviar" para consultar a situação dela; não emita outra para a mesma venda.'],
  '215': ['O arquivo da nota tem um campo em formato inválido.', 'Confira o cadastro fiscal dos produtos (NCM, CFOP, CSOSN) e os dados da empresa. Se continuar, fale com o suporte.'],
  '225': ['O arquivo da nota tem um campo em formato inválido.', 'Confira o cadastro fiscal dos produtos (NCM, CFOP, CSOSN) e os dados da empresa. Se continuar, fale com o suporte.'],
  '280': ['O certificado digital não foi aceito.', 'Confira em Configurações → Fiscal se o certificado é o da empresa e se está dentro da validade.'],
  '281': ['O certificado digital está vencido.', 'Renove o certificado A1 com a certificadora e importe o novo em Configurações → Fiscal.'],
  '290': ['A assinatura digital não foi aceita.', 'Confira o certificado em Configurações → Fiscal (empresa certa e dentro da validade).'],
  '291': ['O certificado usado na assinatura está vencido.', 'Renove o certificado A1 e importe o novo em Configurações → Fiscal.'],
  '297': ['A assinatura não confere com o conteúdo da nota.', 'Tente reenviar. Se continuar, fale com o suporte.'],
  '301': ['Uso denegado: a SEFAZ aponta irregularidade fiscal da empresa.', 'Fale com o contador para regularizar a inscrição estadual. Essa numeração não pode ser reutilizada.'],
  '302': ['Uso denegado: a SEFAZ aponta irregularidade do destinatário.', 'Confira o CPF/CNPJ do cliente informado na venda.'],
  '539': ['Já existe uma nota com esse número e dados diferentes.', 'A numeração ficou repetida. Fale com o suporte para acertar o próximo número e inutilizar o que sobrou.'],
  '610': ['O total da nota não bate com a soma dos itens.', 'Confira descontos e acréscimos da venda e tente de novo; se continuar, fale com o suporte.'],
  '703': ['A data e hora da nota estão à frente do horário da SEFAZ.', 'Acerte o relógio do computador (data, hora e fuso de Brasília) e reenvie.'],
  '704': ['A nota foi emitida há tempo demais para ser enviada agora.', 'Acerte o relógio do computador; se a nota ficou em contingência por muito tempo, fale com o contador.'],
  '778': ['O NCM de um produto não existe na tabela oficial.', 'Corrija o NCM em Fiscal → Cadastro fiscal (ou no cadastro do produto) e emita de novo.'],
};

function autorizado(cStat) {
  return AUTORIZADOS.has(String(cStat || ''));
}

/** Texto para o operador: o que aconteceu e o que fazer (com o código e a mensagem original). */
function explicar(cStat, xMotivo) {
  const c = String(cStat || '').trim();
  const original = String(xMotivo || '').trim();
  const conhecido = CODIGOS[c];
  if (conhecido) return `${conhecido[0]} O que fazer: ${conhecido[1]} (SEFAZ ${c}${original ? `: ${original}` : ''})`;
  return `A SEFAZ não autorizou a nota${c ? ` (código ${c})` : ''}${original ? `: ${original}` : ''}. Confira o cadastro fiscal dos produtos e os dados da empresa; se não ficar claro, mande esta mensagem para o suporte.`;
}

module.exports = { explicar, autorizado, CODIGOS };
