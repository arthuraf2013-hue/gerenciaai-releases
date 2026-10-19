const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/**
 * A Central (admin-panel/index.html) e o app do celular (pwa-mobile/) montam
 * HTML com template string. Os documentos que eles mostram são escritos
 * pelas próprias máquinas, SEM login (installations/{id}, status_ao_vivo,
 * histórico...) -- então qualquer pessoa com a configuração do Firebase
 * consegue gravar `versaoApp: "<img src=x onerror=...>"` e executar código no
 * navegador do administrador. Este teste lê o código e falha se um campo de
 * documento entrar no HTML sem passar por escapeHtml/Number/formatar*.
 */

let parser;
let traverse;
try {
  parser = require('@babel/parser');
  traverse = require('@babel/traverse').default;
} catch { /* sem babel instalado: teste pulado */ }

// Variáveis que, nesses arquivos, guardam documentos vindos do Firestore.
const DOCUMENTOS = /^(inst|i|m|x|b|backup|e|erro|s|cliente|c|d|p|l|loja|t|v|pedido|mesa|u|dispositivo|r|hist|resumo|g|grupo|a)\b\./;
const SEGURO = /^(escapeHtml|esc|icon|formatar\w*|Number|Math\.|String\(Number|render[A-Z]\w*|textoUltimoContato|textoDoPedido|nomeDaInstalacaoComCliente|nomeDoComputador|encodeURIComponent|JSON\.stringify|!!)/;

function expressoesInseguras(src) {
  const ast = parser.parse(src, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true });
  const achados = [];
  traverse(ast, {
    TemplateLiteral(p) {
      const html = p.node.quasis.some((q) => /<[a-z/!]/i.test(q.value.raw) || /="[^"]*$/.test(q.value.raw));
      if (!html) return;
      for (const e of p.node.expressions) {
        const visitar = (n) => {
          if (!n) return;
          if (n.type === 'ConditionalExpression') { visitar(n.consequent); visitar(n.alternate); return; }
          if (n.type === 'LogicalExpression') { visitar(n.left); visitar(n.right); return; }
          if (n.type === 'TemplateLiteral' || n.type === 'StringLiteral' || n.type === 'NumericLiteral') return;
          const codigo = src.slice(n.start, n.end);
          if (SEGURO.test(codigo)) return;
          if (/\.(length|size)$/.test(codigo)) return;
          if (n.type === 'BinaryExpression' || n.type === 'UnaryExpression') return; // aritmética/comparação dá número/booleano
          if (n.type === 'CallExpression' && /\.(map|join|filter)\(/.test(codigo)) return; // templates internos são checados à parte
          if (DOCUMENTOS.test(codigo)) achados.push(`${n.loc.start.line}: ${codigo.slice(0, 100)}`);
        };
        visitar(e);
      }
    },
  });
  return achados;
}

function scriptDaCentral() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin-panel', 'index.html'), 'utf-8');
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  return m[1];
}

test('Central: nenhum campo de documento entra no HTML sem escapar', { skip: !parser && 'sem @babel/parser' }, () => {
  assert.deepEqual(expressoesInseguras(scriptDaCentral()), []);
});

test('App do celular (pwa-mobile): nenhum campo de documento entra no HTML sem escapar', { skip: !parser && 'sem @babel/parser' }, () => {
  const dir = path.join(__dirname, '..', 'pwa-mobile');
  const achados = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    for (const a of expressoesInseguras(fs.readFileSync(path.join(dir, f), 'utf-8'))) achados.push(`${f}:${a}`);
  }
  assert.deepEqual(achados, []);
});

test('o detector pega o caso real que existia (versaoApp sem escapar)', { skip: !parser && 'sem @babel/parser' }, () => {
  const ruim = 'const h = `<span class="maquina-meta">v${inst.versaoApp || \'—\'}</span>`;';
  assert.equal(expressoesInseguras(ruim).length, 1);
  const bom = 'const h = `<span>v${escapeHtml(inst.versaoApp || \'—\')}</span>`;';
  assert.equal(expressoesInseguras(bom).length, 0);
});
