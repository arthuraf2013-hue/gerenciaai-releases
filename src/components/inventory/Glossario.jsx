import { useMemo, useState } from 'react';
import Icon from '../common/Icon';

/**
 * Glossário fiscal, contábil e financeiro em português simples. Usado na
 * aba Glossário do Fiscal e pelo <Termo> (sublinhado pontilhado com a
 * explicação ao passar o mouse) nas telas do ERP.
 */
export const GLOSSARIO = [
  ['Anexo do Simples', 'Tabela do Simples Nacional que vale para a atividade da empresa: I comércio, II indústria, III, IV e V serviços. Cada anexo tem suas alíquotas por faixa de faturamento.'],
  ['Balancete', 'Lista de todas as contas com o total de débitos, créditos e saldo do período. Se a contabilidade está certa, débitos e créditos somam o mesmo valor.'],
  ['CBS', 'Contribuição sobre Bens e Serviços, federal, criada pela Reforma Tributária (LC 214/2025). Substitui PIS e COFINS aos poucos a partir de 2026 (2026 é ano de teste, só informativo).'],
  ['CC-e', 'Carta de Correção Eletrônica: corrige erros que não mudam valor, imposto nem destinatário de uma NF-e já autorizada.'],
  ['CEST', 'Código Especificador da Substituição Tributária (7 dígitos). Obrigatório na nota quando a mercadoria tem ICMS-ST.'],
  ['CFOP', 'Código Fiscal de Operações e Prestações (4 dígitos): diz que tipo de operação é a nota. Começa com 5 (saída no estado), 6 (para outro estado), 1 ou 2 (entradas). Ex.: 5102 = venda de mercadoria comprada de terceiros.'],
  ['CNPJ alfanumérico', 'A partir de julho de 2026 a Receita passa a emitir CNPJ com letras e números nas 12 primeiras posições. Os dois últimos continuam sendo números (dígitos verificadores). O sistema já aceita os dois formatos.'],
  ['Competência', 'O mês a que uma receita ou despesa pertence, mesmo que seja paga em outro mês. Ex.: o aluguel de outubro pago em novembro é da competência de outubro.'],
  ['Contingência', 'Modo de emissão quando a SEFAZ está fora do ar: a NFC-e sai assim mesmo e é transmitida depois, dentro do prazo.'],
  ['CRT', 'Código de Regime Tributário que vai na nota: 1 Simples Nacional, 2 Simples com excesso de sublimite, 3 regime normal, 4 MEI.'],
  ['CSC', 'Código de Segurança do Contribuinte: senha que a SEFAZ dá para gerar o QR Code da NFC-e.'],
  ['CSOSN', 'Código de Situação da Operação no Simples Nacional (3 dígitos), usado por MEI e Simples no lugar do CST do ICMS. Ex.: 102 = venda sem crédito; 500 = ICMS já pago por substituição tributária.'],
  ['CST', 'Código de Situação Tributária: diz como o imposto (ICMS, PIS, COFINS, IPI) é tratado naquele item. Usado por Lucro Presumido e Lucro Real.'],
  ['DANFE', 'Documento Auxiliar da NF-e: a versão impressa (ou em PDF) da nota. A nota de verdade é o XML.'],
  ['DAS', 'Documento de Arrecadação do Simples Nacional: a guia única que paga os impostos do Simples (e do MEI, no DAS-MEI).'],
  ['DASN-SIMEI', 'Declaração anual do MEI, entregue até 31 de maio com o faturamento do ano anterior.'],
  ['DEFIS', 'Declaração anual do Simples Nacional (informações socioeconômicas e fiscais), entregue até 31 de março.'],
  ['DIFAL', 'Diferencial de alíquota do ICMS: diferença entre a alíquota do estado de destino e a interestadual, devida em vendas para consumidor final de outro estado.'],
  ['DRE', 'Demonstração do Resultado do Exercício: receitas menos custos e despesas = lucro ou prejuízo do período.'],
  ['ECD', 'Escrituração Contábil Digital (SPED Contábil): os livros contábeis entregues em arquivo à Receita. Feita pelo contador.'],
  ['EFD', 'Escrituração Fiscal Digital (SPED Fiscal): EFD ICMS/IPI e EFD-Contribuições (PIS/COFINS). Validadas no programa PVA da Receita.'],
  ['Estorno', 'Lançamento ao contrário que anula outro. Em vez de apagar, estorna-se: o histórico fica completo.'],
  ['Fator R', 'Folha de pagamento dos últimos 12 meses dividida pelo faturamento dos últimos 12 meses. Com 28% ou mais, atividades do Anexo V pagam pelo Anexo III (mais barato).'],
  ['IBS', 'Imposto sobre Bens e Serviços, de estados e municípios, criado pela Reforma Tributária. Substitui ICMS e ISS gradualmente de 2027 a 2033.'],
  ['ICMS', 'Imposto estadual sobre circulação de mercadorias. No Simples Nacional vai dentro do DAS (salvo ST e casos especiais).'],
  ['ICMS-ST', 'Substituição tributária: o ICMS de toda a cadeia é cobrado de uma vez, normalmente do fabricante ou distribuidor. Quem revende não paga de novo (CFOP 5405, CSOSN 500).'],
  ['IE', 'Inscrição Estadual: o "CPF" da empresa na SEFAZ do estado. Quem não tem escreve ISENTO.'],
  ['Inutilização', 'Aviso à SEFAZ de que uma faixa de números de nota foi pulada e não será usada.'],
  ['IPI', 'Imposto federal sobre produtos industrializados, pago por indústrias e importadores.'],
  ['ISS', 'Imposto municipal sobre serviços. Prestadores emitem NFS-e.'],
  ['MEI', 'Microempreendedor Individual: faturamento até R$ 81 mil por ano, imposto fixo mensal (DAS-MEI) e nota simplificada.'],
  ['MVA', 'Margem de Valor Agregado: percentual usado para calcular a base do ICMS-ST (o preço estimado até o consumidor).'],
  ['Natureza da operação', 'O que a nota está fazendo: venda, devolução, transferência, remessa para conserto... Ela define o CFOP e a finalidade da nota.'],
  ['NCM', 'Nomenclatura Comum do Mercosul (8 dígitos): a "classificação" do produto. Define alíquotas, ST e regras. Vem na nota do fornecedor.'],
  ['NF-e', 'Nota Fiscal Eletrônica modelo 55: venda para empresas, outros estados, devoluções, transferências.'],
  ['NFC-e', 'Nota Fiscal de Consumidor Eletrônica modelo 65: o cupom de venda no balcão para consumidor final.'],
  ['NFS-e', 'Nota Fiscal de Serviços Eletrônica: emitida no sistema da prefeitura ou no padrão nacional.'],
  ['Partidas dobradas', 'Todo lançamento contábil tem um débito (para onde o valor vai) e um crédito (de onde vem), sempre de mesmo valor.'],
  ['PGDAS-D', 'Programa da Receita onde a empresa do Simples informa o faturamento do mês e gera o DAS.'],
  ['PIS/COFINS', 'Contribuições federais sobre o faturamento. No Simples vão dentro do DAS; no Lucro Presumido e Real são apuradas à parte.'],
  ['Razão', 'Livro que mostra todos os movimentos de uma conta, com o saldo depois de cada um.'],
  ['RBT12', 'Receita bruta dos últimos 12 meses. Define a faixa e a alíquota efetiva do Simples Nacional.'],
  ['Sangria', 'Retirada de dinheiro da gaveta do caixa durante o dia (para depósito, pagamento etc.). Fica registrada e entra na conferência.'],
  ['Simples Nacional', 'Regime para micro e pequenas empresas (até R$ 4,8 milhões/ano) que junta vários impostos numa guia só, o DAS.'],
  ['Sublimite', 'Faturamento de R$ 3,6 milhões no Simples: acima dele, ICMS e ISS passam a ser pagos fora do DAS.'],
  ['Suprimento', 'Dinheiro colocado na gaveta do caixa (troco) depois da abertura.'],
  ['XML', 'O arquivo que é a nota fiscal de verdade, assinado com o certificado digital. Precisa ser guardado por 5 anos.'],
].map(([termo, texto]) => ({ termo, texto }));

const POR_TERMO = new Map(GLOSSARIO.map((g) => [g.termo.toLowerCase(), g.texto]));

/** Termo com explicação ao passar o mouse (e acessível por teclado). */
export function Termo({ t, children }) {
  const texto = POR_TERMO.get(String(t).toLowerCase());
  if (!texto) return children || t;
  return <abbr className="termo-glossario" title={texto} tabIndex={0}>{children || t}</abbr>;
}

export function GlossarioTab() {
  const [busca, setBusca] = useState('');
  const lista = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return q ? GLOSSARIO.filter((g) => g.termo.toLowerCase().includes(q) || g.texto.toLowerCase().includes(q)) : GLOSSARIO;
  }, [busca]);
  return (
    <section className="settings-section" style={{ maxWidth: 860 }}>
      <h2><Icon name="book" size={16} /> Glossário</h2>
      <p className="screen-hint">As siglas do fiscal, da contabilidade e do caixa em português simples. Na dúvida sobre o seu caso, pergunte ao contador.</p>
      <input autoFocus placeholder="Buscar (ex.: CFOP, sangria, fator R)" value={busca} onChange={(e) => setBusca(e.target.value)} style={{ maxWidth: 360, marginBottom: 12 }} />
      {lista.length === 0 ? <p className="empty-state">Nada encontrado.</p> : (
        <dl className="glossario-lista">
          {lista.map((g) => (
            <div key={g.termo} className="glossario-item"><dt>{g.termo}</dt><dd>{g.texto}</dd></div>
          ))}
        </dl>
      )}
    </section>
  );
}
