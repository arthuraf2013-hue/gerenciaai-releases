// Página do cardápio da mesa (servida pelo mesaLocalService na rede da loja).
// Um arquivo só, sem bibliotecas nem nada da internet: tem de abrir no Wi-Fi
// da loja mesmo sem internet. Os dados vêm de /api/cardapio; o texto vindo do
// cadastro entra sempre por textContent (nunca innerHTML).

const ESTILO = `
  :root { --cor: #0f6e56; --fundo: #f5f6f4; --texto: #141a26; --suave: #5c6670; --borda: #e2e5e1; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; background: var(--fundo); color: var(--texto); }
  header { background: var(--cor); color: #fff; padding: 14px 16px 12px; position: sticky; top: 0; z-index: 2; }
  header .loja { font-size: 13px; opacity: .85; }
  header .mesa { font-size: 22px; font-weight: 800; }
  .busca { margin: 10px 12px 0; }
  .busca input { width: 100%; padding: 11px 12px; border-radius: 10px; border: 1px solid var(--borda); font-size: 15px; }
  .cats { display: flex; gap: 8px; overflow-x: auto; padding: 10px 12px; }
  .cats button { flex: none; border: 1px solid var(--borda); background: #fff; border-radius: 999px; padding: 7px 14px; font-size: 14px; }
  .cats button.ativa { background: var(--cor); color: #fff; border-color: var(--cor); }
  main { padding: 0 12px 110px; }
  h2 { font-size: 15px; margin: 16px 2px 8px; color: var(--suave); }
  .item { display: flex; gap: 10px; align-items: center; background: #fff; border-radius: 12px; padding: 10px; margin-bottom: 8px; border: 1px solid var(--borda); }
  .item img { width: 64px; height: 64px; border-radius: 10px; object-fit: cover; flex: none; background: #eee; }
  .item .info { flex: 1; min-width: 0; }
  .item .nome { font-weight: 600; font-size: 15px; }
  .item .preco { color: var(--cor); font-weight: 700; margin-top: 2px; }
  .item .de { color: var(--suave); text-decoration: line-through; font-size: 12px; margin-left: 6px; font-weight: 400; }
  .item .aviso { font-size: 12px; color: #b5521d; }
  .qtd { display: flex; align-items: center; gap: 8px; }
  .qtd button { width: 36px; height: 36px; border-radius: 50%; border: none; font-size: 20px; background: var(--cor); color: #fff; }
  .qtd button.menos { background: #e6ece9; color: var(--texto); }
  .qtd span { min-width: 22px; text-align: center; font-weight: 700; }
  .barra { position: fixed; left: 0; right: 0; bottom: 0; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); background: #fff; border-top: 1px solid var(--borda); }
  .barra button, .principal { width: 100%; padding: 14px; border: none; border-radius: 12px; background: var(--cor); color: #fff; font-size: 16px; font-weight: 700; }
  .secundario { width: 100%; padding: 12px; border: 1px solid var(--borda); border-radius: 12px; background: #fff; font-size: 15px; margin-top: 8px; }
  .folha { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: flex-end; z-index: 5; }
  .folha > div { background: #fff; width: 100%; max-height: 92vh; overflow: auto; border-radius: 16px 16px 0 0; padding: 16px; }
  .folha h3 { margin: 0 0 10px; }
  .linha { display: flex; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 1px dashed var(--borda); font-size: 14px; }
  .total { display: flex; justify-content: space-between; font-weight: 800; font-size: 17px; margin: 10px 0; }
  label { display: block; font-size: 14px; margin: 10px 0 4px; color: var(--suave); }
  label input { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid var(--borda); font-size: 16px; margin-top: 4px; color: var(--texto); }
  .erro { color: #a32d2d; font-size: 14px; margin: 8px 0; }
  .nota { color: var(--suave); font-size: 13px; }
  .hora { color: var(--suave); font-size: 12px; margin-left: 6px; white-space: nowrap; }
  .status { text-align: center; padding: 40px 18px; }
  .status .grande { font-size: 22px; font-weight: 800; margin: 10px 0; }
  .vazio { text-align: center; color: var(--suave); padding: 40px 10px; }
  header .topo { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
  header .conta { flex: none; border: 1px solid rgba(255,255,255,.6); background: rgba(255,255,255,.12); color: #fff; border-radius: 999px; padding: 8px 12px; font-size: 14px; font-weight: 600; }
  header .gente { font-size: 13px; margin-top: 4px; opacity: .92; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 8px; }
  .chip { background: #e6ece9; border-radius: 999px; padding: 5px 11px; font-size: 14px; }
  .chip.eu { background: var(--cor); color: #fff; font-weight: 600; }
  .acoes { display: flex; gap: 8px; margin-top: 12px; }
  .acoes button { flex: 1; padding: 13px 8px; border-radius: 12px; border: 1px solid var(--cor); background: #fff; color: var(--cor); font-size: 15px; font-weight: 700; }
  .ok { color: var(--cor); font-size: 14px; margin: 8px 0; font-weight: 600; }
  header .botoes { display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
  .opcao { display: block; width: 100%; text-align: left; border: 1px solid var(--borda); background: #fff; border-radius: 12px; padding: 12px 14px; margin-top: 8px; font-size: 15px; color: var(--texto); }
  .opcao b { display: block; font-size: 16px; margin-bottom: 2px; }
  .opcao span { color: var(--suave); font-size: 13px; }
  .opcao.sel { border: 2px solid var(--cor); background: #eef6f2; }
  .faixa { background: #fff4d6; color: #7a4a00; padding: 10px 14px; font-size: 14px; font-weight: 600; }
  .relogio { font-size: 40px; text-align: center; margin: 6px; }
  .toast { position: fixed; left: 12px; right: 12px; top: 12px; z-index: 9; background: #14231d; color: #fff; padding: 13px 14px; border-radius: 12px; font-size: 15px; font-weight: 600; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
  .toast.erro { background: #a32d2d; }
`;

const SCRIPT = `
(function () {
  var token = (location.pathname.match(/\\/m\\/([A-Za-z0-9]{24})/) || [])[1];
  var chave = 'gerenciaai-mesa-' + token;
  var salvo = {};
  try { salvo = JSON.parse(localStorage.getItem(chave) || '{}'); } catch (e) { salvo = {}; }
  var cliente = { nome: salvo.nome || '', telefone: salvo.telefone || '' };
  // Este celular é uma conta na mesa: um código aleatório guardado só aqui.
  var aparelho = '';
  try { aparelho = localStorage.getItem('gerenciaai-aparelho') || ''; } catch (e) {}
  if (!/^[A-Za-z0-9]{16,40}$/.test(aparelho)) { aparelho = idPedido(); try { localStorage.setItem('gerenciaai-aparelho', aparelho); } catch (e) {} }
  var carrinho = {};
  var dados = null, categoria = 'todas', termo = '';
  function guardar() { try { localStorage.setItem(chave, JSON.stringify({ nome: cliente.nome, telefone: cliente.telefone, pedidos: salvo.pedidos || [] })); } catch (e) {} }
  function el(tag, cls, texto) { var e = document.createElement(tag); if (cls) e.className = cls; if (texto != null) e.textContent = texto; return e; }
  function moeda(v) { return 'R$ ' + (Math.round(v * 100) / 100).toFixed(2).replace('.', ','); }
  function passo(p) { return p.unidade === 'kg' ? 0.1 : 1; }
  function qtd(id) { return carrinho[id] || 0; }
  function itensDoCarrinho() {
    return dados.produtos.filter(function (p) { return qtd(p.id) > 0; }).map(function (p) { return { p: p, q: qtd(p.id), total: p.preco * qtd(p.id) }; });
  }
  function idPedido() { var c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789', s = ''; var a = new Uint8Array(20); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; }); a.forEach(function (n) { s += c[n % c.length]; }); return s; }

  // Integrantes da mesa: cada celular entra com o nome e vira uma conta.
  var mesa = null;
  function cabecalho() {
    var h = document.querySelector('header'); h.textContent = '';
    var topo = el('div', 'topo'), esq = el('div');
    esq.appendChild(el('div', 'loja', dados.loja));
    esq.appendChild(el('div', 'mesa', (mesa && mesa.mesa) || dados.mesa));
    topo.appendChild(esq);
    var botoes = el('div', 'botoes');
    // Chamar o garçom: qualquer um, sem informar nome.
    var g = el('button', 'conta', 'Chamar garçom'); g.onclick = function () { chamarGarcom(g); }; botoes.appendChild(g);
    if (mesa && mesa.eu) { var b = el('button', 'conta', 'Minha conta'); b.onclick = minhaConta; botoes.appendChild(b); }
    topo.appendChild(botoes);
    h.appendChild(topo);
    if (mesa && mesa.entregarAqui) {
      h.appendChild(el('div', 'gente', 'Sua conta: ' + mesa.contaEm + ' · os pedidos são entregues aqui'));
    } else if (mesa && mesa.integrantes && mesa.integrantes.length) {
      h.appendChild(el('div', 'gente', 'Na mesa: ' + mesa.integrantes.map(function (p) { return p.eu ? p.nome + ' (você)' : p.nome; }).join(', ')));
    }
  }

  // Mudança de mesa: quem está na conta de outra mesa leu este QR.
  function fecharFolha(sel) { var f = document.querySelector(sel); if (f) f.remove(); }
  function mudar(tipo, botao) {
    if (botao) botao.disabled = true;
    return fetch('/api/mudar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ m: token, aparelho: aparelho, tipo: tipo }) })
      .then(function (r) { return r.json(); }).then(function (r) {
        if (!r.ok) throw new Error(r.error || 'Não deu certo.');
        fecharFolha('.folha.mudanca'); mesa = r; cabecalho(); tratar(r);
      }).catch(function (e) { if (botao) botao.disabled = false; alert(e && e.message && e.message !== 'Failed to fetch' ? e.message : 'Sem conexão com a loja.'); });
  }
  function escolha(r) {
    var chave = 'escolha:' + (r.mudanca ? r.mudanca.id + r.mudanca.status : '');
    var aberta = document.querySelector('.folha.mudanca');
    if (aberta && aberta.getAttribute('data-estado') === chave) return;
    if (aberta) aberta.remove();
    var folha = el('div', 'folha mudanca'), caixa = el('div');
    folha.setAttribute('data-estado', chave);
    folha.appendChild(caixa);
    caixa.appendChild(el('h3', '', 'Você está no ' + r.outraMesa));
    if (r.mudanca && r.mudanca.status === 'recusada') caixa.appendChild(el('p', 'erro', 'O atendente não aprovou a mudança' + (r.mudanca.erro ? ': ' + r.mudanca.erro : '.') + ' Fale com ele ou escolha de novo.'));
    caixa.appendChild(el('p', 'nota', 'Leu o QR do ' + r.mesa + '. O que você quer fazer?'));
    var opcoes = [
      ['minha', 'Levar só a minha conta para cá', 'Seus itens saem do ' + r.outraMesa + ' e vêm para o ' + r.mesa + '. Os outros continuam lá.'],
      ['todos', 'Mudamos todos para cá', 'A conta inteira do ' + r.outraMesa + ' vem para o ' + r.mesa + '.'],
      ['entregar', 'Só pedir para entregar aqui', 'Continua na conta do ' + r.outraMesa + '; o pedido avisa "entregar no ' + r.mesa + '".'],
    ];
    var escolhido = 'minha', botoes = [];
    opcoes.forEach(function (o) {
      var b = el('button', o[0] === escolhido ? 'opcao sel' : 'opcao');
      b.appendChild(el('b', '', o[1])); b.appendChild(el('span', '', o[2]));
      b.onclick = function () { escolhido = o[0]; botoes.forEach(function (x) { x.className = x === b ? 'opcao sel' : 'opcao'; }); confirmar.textContent = o[0] === 'entregar' ? 'Pedir daqui' : 'Pedir a mudança'; };
      botoes.push(b); caixa.appendChild(b);
    });
    caixa.appendChild(el('p', 'nota', 'Mudar a conta: o atendente confirma no caixa. Enquanto isso, você pode continuar pedindo.'));
    var confirmar = el('button', 'principal', 'Pedir a mudança'); confirmar.style.marginTop = '8px'; caixa.appendChild(confirmar);
    confirmar.onclick = function () { mudar(escolhido, confirmar); };
    var garcom = el('button', 'secundario', 'Só chamar o garçom'); caixa.appendChild(garcom);
    var aviso = el('p', 'ok'); aviso.hidden = true; caixa.appendChild(aviso);
    garcom.onclick = function () { chamarGarcom(garcom, aviso); };
    document.body.appendChild(folha);
  }
  function espera(r) {
    var chave = 'espera:' + r.mudanca.id;
    var aberta = document.querySelector('.folha.mudanca');
    if (aberta && aberta.getAttribute('data-estado') === chave) return;
    if (aberta) aberta.remove();
    var folha = el('div', 'folha mudanca'), caixa = el('div', 'status');
    folha.setAttribute('data-estado', chave);
    folha.appendChild(caixa);
    caixa.appendChild(el('div', 'relogio', '⏳'));
    caixa.appendChild(el('div', 'grande', 'Mudança pedida'));
    caixa.appendChild(el('p', 'nota', (r.mudanca.tipo === 'todos' ? 'Levar a conta inteira do ' : 'Levar a sua conta do ') + r.outraMesa + ' para o ' + r.mesa + '. O atendente vai confirmar em instantes.'));
    caixa.appendChild(el('p', 'nota', 'Enquanto isso, a sua conta continua no ' + r.outraMesa + '.'));
    var desistir = el('button', 'secundario', 'Desistir da mudança'); caixa.appendChild(desistir);
    desistir.onclick = function () { mudar('cancelar', desistir); };
    document.body.appendChild(folha);
  }
  function faixa(texto) {
    if (document.querySelector('.faixa')) return;
    var f = el('div', 'faixa', texto);
    document.body.insertBefore(f, document.body.firstChild);
    setTimeout(function () { f.remove(); }, 12000);
  }
  var lentoOuRapido = null;
  function tratar(r) {
    if (r.outraMesa) {
      fecharFolha('.folha.entrada');
      if (r.mudanca && r.mudanca.status === 'pendente') espera(r); else escolha(r);
      ritmo(r.mudanca && r.mudanca.status === 'pendente' ? 4000 : 15000);
      return true;
    }
    fecharFolha('.folha.mudanca');
    ritmo(15000);
    if (r.mudanca && r.mudanca.status === 'aprovada') {
      var vista = 'gerenciaai-mudanca-' + r.mudanca.id;
      var ja = false; try { ja = localStorage.getItem(vista) === '1'; localStorage.setItem(vista, '1'); } catch (e) {}
      if (!ja) faixa('✅ Você mudou para o ' + r.mesa + '. ' + (r.mudanca.tipo === 'todos' ? 'A conta da mesa veio junto.' : 'Sua conta veio junto.'));
    }
    return false;
  }
  function ritmo(ms) {
    if (lentoOuRapido && lentoOuRapido.ms === ms) return;
    if (lentoOuRapido) clearInterval(lentoOuRapido.id);
    lentoOuRapido = { ms: ms, id: setInterval(carregarMesa, ms) };
  }

  var garcomChamadoEm = 0;
  function chamarGarcom(botao, aviso) {
    if (Date.now() - garcomChamadoEm < 60000) { mostrar('O garçom já foi avisado. Ele já vem.'); return; }
    if (botao) botao.disabled = true;
    fetch('/api/chamar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ m: token, aparelho: aparelho, tipo: 'garcom' }) })
      .then(function (r) { return r.json(); }).then(function (r) {
        if (!r.ok) throw new Error(r.error || 'Não deu certo.');
        garcomChamadoEm = Date.now();
        mostrar('Pronto! O garçom já foi avisado.');
      }).catch(function (e) { mostrar(e && e.message && e.message !== 'Failed to fetch' ? e.message : 'Sem conexão com a loja.', true); })
      .then(function () { if (botao) setTimeout(function () { botao.disabled = false; }, 3000); });
    function mostrar(texto, erro) {
      if (aviso) { aviso.hidden = false; aviso.className = erro ? 'erro' : 'ok'; aviso.textContent = texto; return; }
      var t = el('div', erro ? 'toast erro' : 'toast', texto);
      document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3500);
    }
  }

  function carregarMesa() {
    return fetch('/api/mesa?m=' + token + '&a=' + aparelho).then(function (r) { return r.json(); }).then(function (r) {
      if (!r.ok) return;
      var eraIntegrante = mesa && mesa.eu;
      mesa = r; cabecalho();
      if (tratar(r)) return;
      if (!r.eu && !document.querySelector('.folha.entrada')) entrada(eraIntegrante);
    }).catch(function () {});
  }

  function entrada(fechou) {
    var folha = el('div', 'folha entrada'), caixa = el('div');
    folha.appendChild(caixa);
    caixa.appendChild(el('h3', '', 'Entrar na ' + ((mesa && mesa.mesa) || dados.mesa)));
    caixa.appendChild(el('p', 'nota', fechou ? 'A conta anterior desta mesa foi fechada. Entre de novo para pedir.' : 'Cada celular é uma conta: os seus pedidos ficam no seu nome.'));
    if (mesa && mesa.integrantes && mesa.integrantes.length) {
      caixa.appendChild(el('p', 'nota', 'Já estão na mesa:'));
      var chips = el('div', 'chips'); mesa.integrantes.forEach(function (p) { chips.appendChild(el('span', 'chip', p.nome)); }); caixa.appendChild(chips);
    }
    var lNome = el('label', '', 'Seu nome'); var iNome = el('input'); iNome.maxLength = 40; iNome.autocomplete = 'given-name'; iNome.value = cliente.nome; lNome.appendChild(iNome); caixa.appendChild(lNome);
    var lTel = el('label', '', 'Celular (opcional)'); var iTel = el('input'); iTel.type = 'tel'; iTel.inputMode = 'tel'; iTel.maxLength = 20; iTel.placeholder = '(81) 91234-5678'; iTel.value = cliente.telefone; lTel.appendChild(iTel); caixa.appendChild(lTel);
    caixa.appendChild(el('p', 'nota', 'Com o celular, a loja reconhece você nas próximas visitas.'));
    var erro = el('p', 'erro'); erro.hidden = true; caixa.appendChild(erro);
    var entrar = el('button', 'principal', 'Entrar na mesa'); caixa.appendChild(entrar);
    var avisoGarcom = el('p', 'ok'); avisoGarcom.hidden = true;
    var soGarcom = el('button', 'secundario', 'Só chamar o garçom'); caixa.appendChild(soGarcom); caixa.appendChild(avisoGarcom);
    soGarcom.onclick = function () { chamarGarcom(soGarcom, avisoGarcom); };
    entrar.onclick = function () {
      cliente.nome = iNome.value.trim(); cliente.telefone = iTel.value.trim(); guardar();
      if (cliente.nome.length < 2) { erro.hidden = false; erro.textContent = 'Escreva seu nome.'; return; }
      var tel = cliente.telefone.replace(/\\D/g, '');
      if (tel.length > 11 && tel.indexOf('55') === 0) tel = tel.slice(2);
      if (cliente.telefone && !/^[1-9][0-9]{9,10}$/.test(tel)) { erro.hidden = false; erro.textContent = 'Confira o celular (DDD + número) ou deixe em branco.'; return; }
      entrar.disabled = true; entrar.textContent = 'Entrando...';
      fetch('/api/entrar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ m: token, aparelho: aparelho, nome: cliente.nome, telefone: tel || '' }) })
        .then(function (r) { return r.json(); }).then(function (r) {
          if (!r.ok) throw new Error(r.error || 'Não deu certo.');
          mesa = r; folha.remove(); cabecalho(); tratar(r);
        }).catch(function (e) {
          entrar.disabled = false; entrar.textContent = 'Entrar na mesa';
          erro.hidden = false; erro.textContent = e && e.message && e.message !== 'Failed to fetch' ? e.message : 'Sem conexão com a loja. Confira a sua internet (ou o Wi-Fi da loja) e tente de novo.';
        });
    };
    document.body.appendChild(folha);
    iNome.focus();
  }

  function minhaConta() {
    var folha = el('div', 'folha'), caixa = el('div');
    folha.appendChild(caixa);
    function desenhar() {
      caixa.textContent = '';
      caixa.appendChild(el('h3', '', 'Minha conta · ' + mesa.mesa));
      var chips = el('div', 'chips');
      (mesa.integrantes || []).forEach(function (p) { chips.appendChild(el('span', p.eu ? 'chip eu' : 'chip', p.nome)); });
      caixa.appendChild(chips);
      if (!mesa.meusItens.length) caixa.appendChild(el('p', 'nota', mesa.pedidosEsperando ? 'Seu pedido está esperando o atendente confirmar.' : 'Você ainda não pediu nada.'));
      mesa.meusItens.forEach(function (i) {
        var l = el('div', 'linha');
        var nomeDoItem = el('span', '', String(i.quantidade).replace('.', ',') + 'x ' + i.nome);
        if (i.hora) nomeDoItem.appendChild(el('span', 'hora', i.hora));
        l.appendChild(nomeDoItem);
        l.appendChild(el('span', '', moeda(i.total)));
        caixa.appendChild(l);
      });
      if (mesa.meusItens.length && mesa.pedidosEsperando) caixa.appendChild(el('p', 'nota', 'E mais ' + mesa.pedidosEsperando + ' pedido(s) esperando confirmação.'));
      var t = el('div', 'total'); t.appendChild(el('span', '', 'Sua parte')); t.appendChild(el('span', '', moeda(mesa.meuTotal))); caixa.appendChild(t);
      var tm = el('div', 'linha'); tm.appendChild(el('span', '', 'Total da mesa')); tm.appendChild(el('span', '', moeda(mesa.totalMesa))); caixa.appendChild(tm);
      caixa.appendChild(el('p', 'nota', 'Valores sem a taxa de serviço. O pagamento é feito no final, com o atendente.'));
      var aviso = el('p', 'ok'); aviso.hidden = true;
      var acoes = el('div', 'acoes');
      [['garcom', 'Chamar garçom'], ['conta', 'Pedir a conta']].forEach(function (a) {
        var b = el('button', '', a[1]);
        b.onclick = function () {
          b.disabled = true;
          fetch('/api/chamar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ m: token, aparelho: aparelho, tipo: a[0] }) })
            .then(function (r) { return r.json(); }).then(function (r) {
              aviso.hidden = false; aviso.className = r.ok ? 'ok' : 'erro';
              aviso.textContent = r.ok ? (a[0] === 'conta' ? 'Pronto! O atendente já vem com a conta.' : 'Pronto! O garçom já foi avisado.') : (r.error || 'Não deu certo.');
            }).catch(function () { aviso.hidden = false; aviso.className = 'erro'; aviso.textContent = 'Sem conexão com a loja.'; })
            .then(function () { setTimeout(function () { b.disabled = false; }, 60000); });
        };
        acoes.appendChild(b);
      });
      caixa.appendChild(acoes); caixa.appendChild(aviso);
      if (mesa.entregarAqui) {
        var parar = el('button', 'secundario', 'Parar de receber aqui (voltar para o ' + mesa.contaEm + ')');
        parar.onclick = function () { mudar('cancelar', parar).then(function () { folha.remove(); carregarMesa(); }); };
        caixa.appendChild(parar);
      }
      var fechar = el('button', 'secundario', 'Voltar ao cardápio'); fechar.onclick = function () { folha.remove(); }; caixa.appendChild(fechar);
    }
    desenhar();
    folha.onclick = function (e) { if (e.target === folha) folha.remove(); };
    document.body.appendChild(folha);
    carregarMesa().then(function () { if (document.body.contains(folha) && mesa.eu) desenhar(); });
  }

  function lista() {
    var main = document.querySelector('main'); main.textContent = '';
    var cats = ['todas'];
    dados.produtos.forEach(function (p) { var c = p.categoria || 'Outros'; if (cats.indexOf(c) < 0) cats.push(c); });
    var barra = document.querySelector('.cats'); barra.textContent = '';
    cats.forEach(function (c) {
      var b = el('button', c === categoria ? 'ativa' : '', c === 'todas' ? 'Tudo' : c);
      b.onclick = function () { categoria = c; lista(); };
      barra.appendChild(b);
    });
    var t = termo.toLowerCase();
    var grupos = {};
    dados.produtos.forEach(function (p) {
      var c = p.categoria || 'Outros';
      if (categoria !== 'todas' && c !== categoria) return;
      if (t && p.nome.toLowerCase().indexOf(t) < 0) return;
      (grupos[c] = grupos[c] || []).push(p);
    });
    var nomes = Object.keys(grupos);
    if (!nomes.length) { main.appendChild(el('p', 'vazio', 'Nada encontrado.')); }
    nomes.forEach(function (c) {
      main.appendChild(el('h2', '', c));
      grupos[c].forEach(function (p) {
        var item = el('div', 'item');
        if (p.foto) { var img = el('img'); img.loading = 'lazy'; img.alt = ''; img.src = '/api/foto/' + p.id; item.appendChild(img); }
        var info = el('div', 'info');
        info.appendChild(el('div', 'nome', p.nome));
        var preco = el('div', 'preco', moeda(p.preco) + (p.unidade === 'kg' ? '/kg' : ''));
        if (p.precoDe) preco.appendChild(el('span', 'de', moeda(p.precoDe)));
        info.appendChild(preco);
        var esgotado = p.disponibilidade === 'esgotado';
        if (esgotado) info.appendChild(el('div', 'aviso', 'Esgotado'));
        else if (p.disponibilidade === 'poucas') info.appendChild(el('div', 'aviso', 'Últimas unidades'));
        item.appendChild(info);
        if (!esgotado) {
          var q = el('div', 'qtd');
          if (qtd(p.id) > 0) {
            var menos = el('button', 'menos', '−'); menos.setAttribute('aria-label', 'Tirar ' + p.nome);
            menos.onclick = function () { carrinho[p.id] = Math.max(0, Math.round((qtd(p.id) - passo(p)) * 1000) / 1000); if (!carrinho[p.id]) delete carrinho[p.id]; lista(); rodape(); };
            q.appendChild(menos);
            q.appendChild(el('span', '', p.unidade === 'kg' ? String(qtd(p.id)).replace('.', ',') : String(qtd(p.id))));
          }
          var mais = el('button', '', '+'); mais.setAttribute('aria-label', 'Adicionar ' + p.nome);
          mais.onclick = function () { carrinho[p.id] = Math.round((qtd(p.id) + passo(p)) * 1000) / 1000; lista(); rodape(); };
          q.appendChild(mais);
          item.appendChild(q);
        }
        main.appendChild(item);
      });
    });
  }

  function rodape() {
    var b = document.querySelector('.barra'); b.textContent = '';
    var itens = itensDoCarrinho();
    if (!itens.length) { b.hidden = true; return; }
    b.hidden = false;
    var total = itens.reduce(function (s, i) { return s + i.total; }, 0);
    var n = itens.reduce(function (s, i) { return s + (i.p.unidade === 'kg' ? 1 : i.q); }, 0);
    var botao = el('button', '', 'Ver pedido (' + n + ') · ' + moeda(total));
    botao.onclick = revisar;
    b.appendChild(botao);
  }

  function revisar() {
    var itens = itensDoCarrinho();
    var total = itens.reduce(function (s, i) { return s + i.total; }, 0);
    var folha = el('div', 'folha'), caixa = el('div');
    folha.appendChild(caixa);
    caixa.appendChild(el('h3', '', 'Seu pedido · ' + dados.mesa));
    itens.forEach(function (i) {
      var l = el('div', 'linha');
      l.appendChild(el('span', '', (i.p.unidade === 'kg' ? String(i.q).replace('.', ',') + ' kg ' : i.q + 'x ') + i.p.nome));
      l.appendChild(el('span', '', moeda(i.total)));
      caixa.appendChild(l);
    });
    var t = el('div', 'total'); t.appendChild(el('span', '', 'Total')); t.appendChild(el('span', '', moeda(total))); caixa.appendChild(t);
    caixa.appendChild(el('p', 'nota', 'No nome de: ' + ((mesa && mesa.eu && mesa.eu.nome) || cliente.nome)));
    var lObs = el('label', '', 'Observação (opcional)'); var iObs = el('input'); iObs.maxLength = 200; iObs.placeholder = 'Ex.: sem cebola'; lObs.appendChild(iObs); caixa.appendChild(lObs);
    caixa.appendChild(el('p', 'nota', 'Pagamento: na conta da mesa, no final.'));
    var erro = el('p', 'erro'); erro.hidden = true; caixa.appendChild(erro);
    var enviar = el('button', 'principal', 'Enviar pedido'); caixa.appendChild(enviar);
    var voltar = el('button', 'secundario', 'Continuar escolhendo'); caixa.appendChild(voltar);
    voltar.onclick = function () { folha.remove(); };
    folha.onclick = function (e) { if (e.target === folha) folha.remove(); };
    enviar.onclick = function () {
      if (!mesa || !mesa.eu) { folha.remove(); entrada(false); return; }
      var tel = (cliente.telefone || '').replace(/\\D/g, '');
      if (tel.length > 11 && tel.indexOf('55') === 0) tel = tel.slice(2);
      if (!/^[1-9][0-9]{9,10}$/.test(tel)) tel = '';
      enviar.disabled = true; enviar.textContent = 'Enviando...';
      var id = idPedido();
      fetch('/api/pedido', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        m: token, id: id, nome: mesa.eu.nome, telefone: tel || '', observacao: iObs.value, aparelho: aparelho,
        itens: itens.map(function (i) { return { produtoId: i.p.id, quantidade: i.q }; }),
      }) }).then(function (r) { return r.json(); }).then(function (r) {
        if (!r.ok) throw new Error(r.error || 'Não deu certo.');
        carrinho = {}; folha.remove(); rodape(); lista();
        acompanhar(id, r.aceitoSozinho); carregarMesa();
      }).catch(function (e) {
        enviar.disabled = false; enviar.textContent = 'Enviar pedido';
        erro.hidden = false; erro.textContent = e && e.message && e.message !== 'Failed to fetch' ? e.message : 'Sem conexão com a loja. Confira a sua internet (ou o Wi-Fi da loja) e tente de novo.';
      });
    };
    document.body.appendChild(folha);
  }

  function acompanhar(id, aceito) {
    var folha = el('div', 'folha'), caixa = el('div', 'status');
    folha.appendChild(caixa);
    var titulo = el('div', 'grande', aceito ? 'Pedido enviado para a cozinha!' : 'Pedido recebido!');
    var texto = el('p', 'nota', aceito ? 'Já está na conta da ' + dados.mesa + '.' : 'Um atendente vai confirmar em instantes.');
    caixa.appendChild(el('div', '', '✅')); caixa.appendChild(titulo); caixa.appendChild(texto);
    var outro = el('button', 'principal', 'Fazer outro pedido'); outro.onclick = function () { clearInterval(timer); folha.remove(); };
    caixa.appendChild(outro);
    document.body.appendChild(folha);
    var timer = setInterval(function () {
      fetch('/api/pedido?m=' + token + '&id=' + id).then(function (r) { return r.json(); }).then(function (r) {
        if (!r.ok) return;
        if (r.etapa === 'na_mesa') { titulo.textContent = 'Pedido confirmado!'; texto.textContent = 'Já está na conta da ' + dados.mesa + ' e foi para a cozinha.'; clearInterval(timer); }
        if (r.etapa === 'cancelado') { titulo.textContent = 'Pedido não confirmado'; texto.textContent = 'Fale com um atendente.'; clearInterval(timer); }
      }).catch(function () {});
    }, 4000);
  }

  var busca = document.querySelector('.busca input');
  busca.oninput = function () { termo = busca.value; lista(); };
  fetch('/api/cardapio?m=' + token).then(function (r) { return r.json(); }).then(function (r) {
    if (!r.ok) { document.querySelector('main').textContent = r.error || 'Cardápio indisponível.'; return; }
    dados = r; cabecalho(); lista(); rodape();
    carregarMesa(); // depois, de 15 em 15 s (4 s esperando a mudança): quem entrou, mesa fechada, conta
  }).catch(function () { document.querySelector('main').textContent = 'Sem conexão com a loja. Confira a sua internet (ou o Wi-Fi da loja) e tente de novo.'; });
})();
`;

function paginaDaMesa({ valida = true } = {}) {
  if (!valida) {
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR inválido</title><style>${ESTILO}</style></head>
      <body><div class="status"><div class="grande">Este QR não vale mais</div><p class="nota">Peça ajuda a um atendente.</p></div></body></html>`;
  }
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <meta name="theme-color" content="#0f6e56"><title>Cardápio</title><style>${ESTILO}</style></head>
    <body><header><div class="loja">Carregando o cardápio...</div></header>
    <div class="busca"><input type="search" placeholder="Buscar no cardápio" aria-label="Buscar no cardápio"></div>
    <nav class="cats"></nav><main></main><div class="barra" hidden></div>
    <script>${SCRIPT}</script></body></html>`;
}

function paginaSemMesa() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cardápio</title><style>${ESTILO}</style></head>
    <body><div class="status"><div class="grande">Leia o QR da sua mesa</div><p class="nota">O QR fica colado na mesa. Ele abre o cardápio já com o número da mesa.</p></div></body></html>`;
}

module.exports = { paginaDaMesa, paginaSemMesa };
