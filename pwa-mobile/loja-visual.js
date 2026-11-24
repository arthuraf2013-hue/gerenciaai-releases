// Ilustração do produto sem foto na vitrine online (loja.js): emoji pelo
// nome/categoria sobre a cor da categoria. CÓPIA de
// electron/services/vitrineVisual.js (a página do QR da mesa usa aquela):
// tests/vitrineVisual.test.js confere que as duas continuam iguais.

const REGRAS_EMOJI = [
  ['\\b(caipirinha|caipiroska|caipifruta|drinks?|batida|mojito|coquetel|pina colada|sex on the beach)\\b','🍹'],
  ['\\b(refrigerantes?|refri|coca|guarana|fanta|sprite|soda|pepsi|kuat|schweppes|sukita|antartica)\\b','🥤'],
  ['\\b(chopp?|cervejas?|amstel|heineken|skol|brahma|antarctica|budweiser|stella|itaipava|devassa|spaten|corona|eisenbahn|bohemia|petra|kaiser|crystal|imperio|latao|litrao|long ?neck)\\b','🍺'],
  ['\\b(vinhos?|espumante|sangria|champagne|prosecco)\\b','🍷'],
  ['\\b(whisky|whiskey|vodka|cachaca|pitu|ypioca|doses?|conhaque|rum|tequila|licor|alcatrao|steinhaeger|campari|martini|gin|jurubeba|cynar|montilla|caninha|cachacas)\\b','🥃'],
  ['\\b(energetico|red ?bull|monster|tnt)\\b','⚡'],
  ['\\b(sucos?|vitamina|limonada|polpa|laranjada|cajuina)\\b','🧃'],
  ['\\b(aguas?|tonica|h2oh|gelo de coco|agua de coco)\\b','💧'],
  ['\\b(cafe|cappuccino|capuccino|expresso|cafezinho|pingado)\\b','☕'],
  ['\\b(cha|mate)\\b','🍵'],
  ['\\b(pizzas?)\\b','🍕'],
  ['\\b(cachorro quente|hot ?dog)\\b','🌭'],
  ['\\b(hamburguer|hamburger|burger|x (tudo|burguer|burger|bacon|salada|egg|frango|calabresa|picanha|carne)|sanduiche|misto|bauru|beirute)\\b','🍔'],
  ['\\b(batata|batatas|fritas|aipim frito|macaxeira frita)\\b','🍟'],
  ['\\b(camarao|camaroes)\\b','🦐'],
  ['\\b(peixes?|tilapia|pescada|bacalhau|sardinha|agulhinha|moqueca|caldeirada)\\b','🐟'],
  ['\\b(frango|galinha|galeto|asinha|asas?|coxa|sobrecoxa|passarinho)\\b','🍗'],
  ['\\b(picanha|carnes?|charque|bife|costela|churrasco|maminha|alcatra|file|bode|carneiro|linguica|calabresa|espetos?|espetinhos?|cupim|fraldinha|contra file|carne de sol|guisado|figado|bisteca|lombo|porco|torresmo)\\b','🥩'],
  ['\\b(queijo|coalho|provolone)\\b','🧀'],
  ['\\b(saladas?|verduras?|legumes)\\b','🥗'],
  ['\\b(sopas?|caldos?|caldinhos?)\\b','🍲'],
  ['\\b(arroz|feijao|baiao|feijoada|pratos?|pf|executivo|refeicao|marmita|quentinha|almoco|jantar|cuscuz|macarrao|lasanha|escondidinho|strogonoff|estrogonofe|parmegiana|risoto|buchada|sarapatel|mungunza|rubacao)\\b','🍛'],
  ['\\b(porcao|porcoes|petiscos?|tira gosto|tiragosto|isca|iscas|pasteis|pastel|coxinha|salgados?|empada|kibe|quibe|bolinhos?|dadinho|tapioca|amendoim|azeitona|mandioca|macaxeira|aipim|inhame)\\b','🍢'],
  ['\\b(sorvetes?|acai|picole|milk ?shake|sundae|gelato)\\b','🍨'],
  ['\\b(pudim|bolos?|doces?|sobremesas?|tortas?|brigadeiro|mousse|chocolate|cocada|cartola|brownie)\\b','🍰'],
  ['\\b(pao|paes|torrada|crepe|cuscuz)\\b','🥖'],
  ['\\b(gelo)\\b','🧊'],
  ['\\b(frutas?|banana|maca|laranja|abacaxi|melancia|uva|manga)\\b','🍉'],
  ['\\b(racao|racoes|pet|petshop|coleira|areia sanitaria|caes|gatos?|cachorros?)\\b','🐾'],
  ['\\b(medicamentos?|remedios?|farmacia|dipirona|paracetamol|ibuprofeno|comprimidos?|capsulas?|xarope|pomada|\\d+ ?mg)\\b','💊'],
  ['\\b(shampoo|condicionador|sabonete|creme|perfume|desodorante|higiene|cosmeticos?|hidratante)\\b','🧴'],
  ['\\b(cimento|tinta|tijolo|parafusos?|ferramentas?|construcao|argamassa|tubo|cano)\\b','🧱'],
  ['\\b(bebidas?)\\b','🥤'],
  ['\\b(comidas?|cozinha|lanches?|cardapio|restaurante)\\b','🍽️'],
];
const EMOJI_PADRAO = '🛍️';
const CORES_CATEGORIA = ['#ffe0b2', '#ffcdd2', '#c8e6c9', '#b3e5fc', '#e1bee7', '#fff59d', '#ffccbc', '#d7ccc8', '#b2dfdb', '#f8bbd0'];

function semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const REGRAS = REGRAS_EMOJI.map(([fonte, emoji]) => [new RegExp(fonte), emoji]);

/** Emoji do produto: primeiro pelo nome, depois pela categoria. */
function emojiDoProduto(nome, categoria) {
  for (const texto of [semAcento(nome), semAcento(categoria)]) {
    if (!texto) continue;
    for (const [re, emoji] of REGRAS) if (re.test(texto)) return emoji;
  }
  return EMOJI_PADRAO;
}

/** Cor de fundo da ilustração: a mesma para toda a categoria. */
function corDaCategoria(categoria) {
  const s = semAcento(categoria || 'outros');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return CORES_CATEGORIA[h % CORES_CATEGORIA.length];
}

export { REGRAS_EMOJI, EMOJI_PADRAO, CORES_CATEGORIA, emojiDoProduto, corDaCategoria };
