"""Teste de ponta a ponta: dois celulares (garçom e operador) no Chrome, o app
compilado apontando para os emuladores do Firebase, e o "computador"
(e2e/computador.js) com os serviços de verdade. Confere a tela E o banco."""
import asyncio, json, os, re, time, urllib.request
from playwright.async_api import async_playwright, expect

APP = 'http://127.0.0.1:4173/'
PC = 'http://127.0.0.1:7070'
FOTOS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fotos') + os.sep
os.makedirs(FOTOS, exist_ok=True)
# Chrome instalado na máquina (E2E_CHROME) ou o Chromium do Playwright.
CHROME = os.environ.get('E2E_CHROME') or None
passos = []


def pc(caminho):
    with urllib.request.urlopen(PC + caminho, timeout=20) as r:
        return json.loads(r.read())


async def esperar(descricao, cond, segundos=40):
    fim = time.time() + segundos
    ultimo = None
    while time.time() < fim:
        ultimo = pc('/estado')
        if cond(ultimo):
            passos.append(f'OK  {descricao}')
            return ultimo
        await asyncio.sleep(0.5)
    raise AssertionError(f'FALHOU: {descricao}\n{json.dumps(ultimo, ensure_ascii=False, indent=1)[:3000]}')


def ok(descricao):
    passos.append(f'OK  {descricao}')


async def parear(pagina, tipo):
    await pagina.goto(APP)
    await pagina.locator('#input-codigo').wait_for(timeout=20000)
    # O app remonta a tela de pareamento quando o login anônimo termina; espera assentar.
    await pagina.wait_for_load_state('networkidle')
    await pagina.wait_for_timeout(1500)
    codigo = pc(f'/codigo?tipo={tipo}')['codigo']
    await pagina.fill('#input-codigo', codigo)
    await pagina.click('#btn-parear')
    await pagina.get_by_role('button', name='Confirmar e entrar').click(timeout=20000)


async def no_meio(loc):
    # Como a pessoa faz: rola até o botão ficar no meio da tela (o rodapé fixo
    # e a barra de abas do PDV ficam por cima do que está na borda de baixo).
    await loc.click()


def item(pagina, nome):
    return pagina.locator('.pm-item', has_text=nome)


async def main():
    async with async_playwright() as p:
        nav = await p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
        erros = []

        ctx_g = await nav.new_context(viewport={'width': 390, 'height': 800}, device_scale_factor=2)
        g = await ctx_g.new_page()
        g.on('pageerror', lambda e: erros.append(f'garçom: {e}'))

        # ---------- garçom pareia e vê as mesas ----------
        await parear(g, 'garcom')
        await esperar('celular do garçom espelhado no computador', lambda e: any(d['tipo'] == 'garcom' and d['ativo'] for d in e['dispositivos']))
        pc('/publicar')
        await g.locator('.aba[data-aba="mesas"]').wait_for(state='visible', timeout=30000)
        await expect(g.get_by_role('button', name=re.compile(r'^Mesa 1'))).to_be_visible(timeout=20000)
        ok('aba Mesas aparece sozinha e lista as mesas do computador')
        await g.screenshot(path=FOTOS + 'e2e-1-mesas.png')

        # ---------- abrir mesa e lançar por pessoa ----------
        await g.get_by_role('button', name=re.compile(r'^Mesa 1')).click()
        await g.get_by_role('button', name='Abrir e lançar').click()
        await esperar('mesa 1 aberta no computador com 2 pessoas', lambda e: e['mesas'][0]['status'] == 'ocupada' and e['mesas'][0]['pessoas'] == 2)
        await g.get_by_role('radio', name='Pessoa 1').click(timeout=15000)
        await g.get_by_role('button', name=re.compile('^Prato feito')).click()
        await g.get_by_role('radio', name='Pessoa 2').click()
        await g.get_by_role('button', name=re.compile('^Suco')).click()
        await g.get_by_role('button', name=re.compile('^Suco')).click()
        await g.get_by_role('button', name=re.compile('^Ver pedido')).click()
        linha_suco = g.locator('.pm-revisao-linha', has_text='Suco')
        await linha_suco.get_by_role('button', name='+ observação').click()
        await linha_suco.locator('input').fill('sem gelo')
        await g.get_by_role('button', name='Enviar para a comanda').click()
        await esperar('itens no computador, cada um na pessoa certa, com observação', lambda e: any(
            i['nome'] == 'Prato feito' and i['pessoa_numero'] == 1 for i in e['itens']) and any(
            i['nome'] == 'Suco' and i['pessoa_numero'] == 2 and i['quantidade'] == 2 and i['observacao'] == 'sem gelo' for i in e['itens']))
        await expect(item(g, 'Suco')).to_contain_text('aguardando', timeout=20000)
        ok('comanda no celular mostra o item vindo do computador (aguardando)')

        # ---------- produto sem estoque: o computador recusa e o celular avisa ----------
        await g.get_by_role('button', name=re.compile('^Adicionar itens')).click()
        await g.get_by_role('button', name=re.compile('^Pudim')).click()
        await g.get_by_role('button', name=re.compile('^Enviar')).click()
        await g.get_by_role('button', name=re.compile('envio com problema')).click(timeout=20000)
        await expect(g.locator('.pm-envio-erro')).to_contain_text('Estoque insuficiente')
        ok('sem estoque: o computador recusa e o celular mostra o motivo')
        await g.get_by_role('button', name='Entendi, tirar da lista').click()
        await g.get_by_role('button', name='Fechar').click()
        assert not any(i['nome'] == 'Pudim' for i in pc('/estado')['itens'])

        # ---------- cozinha marca pronto ----------
        pc('/cozinha?nome=Suco&status=pronto')
        await expect(item(g, 'Suco')).to_contain_text('pronto', timeout=20000)
        ok('status "pronto" da cozinha chega no celular')
        await g.screenshot(path=FOTOS + 'e2e-2-comanda.png', full_page=True)

        # ---------- sem internet: lançar fica na fila ----------
        await ctx_g.set_offline(True)
        await g.get_by_role('button', name=re.compile('^Adicionar itens')).click()
        await g.get_by_role('radio', name='Mesa').click()
        await g.get_by_role('button', name=re.compile('^Água')).click()
        await g.get_by_role('button', name=re.compile('^Enviar')).click()
        await expect(item(g, 'Água')).to_contain_text('na fila', timeout=10000)
        await asyncio.sleep(3)
        assert not any(i['nome'] == 'Água' for i in pc('/estado')['itens']), 'Água chegou sem internet?'
        ok('sem internet: item aparece "na fila" e não chega no computador')
        await g.screenshot(path=FOTOS + 'e2e-3-na-fila.png', full_page=True)
        await g.reload()
        await g.locator('.aba[data-aba="mesas"]').wait_for(state='visible', timeout=30000)
        ok('app abre de novo SEM internet (service worker)')
        await ctx_g.set_offline(False)
        await esperar('internet voltou: o item da fila entra na comanda (sem pessoa)', lambda e: any(
            i['nome'] == 'Água' and i['pessoa_numero'] is None for i in e['itens']), segundos=90)

        # ---------- nome da pessoa e mover item ----------
        await g.get_by_role('button', name=re.compile(r'^Mesa 1')).click()
        await g.get_by_role('radio', name='Pessoa 1').click(timeout=20000)
        await g.get_by_role('radio', name='Pessoa 1').click()
        await g.get_by_role('button', name='Dar um nome').click()
        await g.fill('#pm-texto', 'Ana')
        await g.get_by_role('button', name='Salvar').click()
        await esperar('nome "Ana" gravado no computador', lambda e: any(p['nome'] == 'Ana' and p['numero'] == 1 for p in e['pessoas']))
        await expect(g.get_by_role('radio', name='Ana')).to_be_visible(timeout=15000)
        await item(g, 'Prato feito').click()
        await g.get_by_role('button', name='Mover para outra pessoa').click()
        await g.locator('.pm-opcao', has_text='Pessoa 2').click()
        await esperar('prato movido para a pessoa 2', lambda e: any(i['nome'] == 'Prato feito' and i['pessoa_numero'] == 2 for i in e['itens']))
        await expect(g.locator('.pm-grupo', has_text='Pessoa 2')).to_contain_text('Prato feito', timeout=15000)
        await item(g, 'Prato feito').click()
        await g.get_by_role('button', name='Mover para outra pessoa').click()
        await g.locator('.pm-opcao', has_text='Ana').click()
        await esperar('prato de volta para a Ana', lambda e: any(i['nome'] == 'Prato feito' and i['pessoa_numero'] == 1 for i in e['itens']))
        # garçom não recebe nem junta
        assert await g.get_by_role('button', name=re.compile('^Fechar conta')).count() == 0
        ok('garçom não tem "Fechar conta"')

        # ---------- operador pareia e recebe a parte da Ana ----------
        ctx_o = await nav.new_context(viewport={'width': 390, 'height': 800}, device_scale_factor=2)
        o = await ctx_o.new_page()
        o.on('pageerror', lambda e: erros.append(f'operador: {e}'))
        await parear(o, 'pdv')
        await esperar('celular do operador espelhado no computador', lambda e: any(d['tipo'] == 'pdv' and d['ativo'] for d in e['dispositivos']))
        pc('/publicar')
        await o.locator('.nav-item[data-aba="mesas"]').click(timeout=40000)
        await expect(o.get_by_role('button', name=re.compile(r'^Mesa 1'))).to_be_visible(timeout=20000)
        assert await o.get_by_placeholder('Buscar produto ou código').count() == 0, 'resto da aba Vender ficou na tela de Mesas'
        ok('aba Mesas do PDV abre limpa (sem resto da aba Vender)')
        await o.get_by_role('button', name=re.compile(r'^Mesa 1')).click(timeout=20000)
        await o.get_by_role('button', name=re.compile('^Fechar conta')).click(timeout=20000)
        await o.get_by_role('tab', name='Por pessoa').click()
        await o.locator('.pm-pessoa-conta', has_text='Ana').locator('input').check()
        await expect(o.locator('.pm-a-receber')).to_contain_text('30,00')
        await no_meio(o.locator('.metodos-pagamento .metodo', has_text='Pix'))
        await o.screenshot(path=FOTOS + 'e2e-4-conta-ana.png', full_page=True)
        await no_meio(o.get_by_role('button', name=re.compile('^Receber R')))
        e = await esperar('pagamento da Ana no computador, marcado como dela', lambda e: any(
            pg['metodo'] == 'pix' and abs(pg['valor'] - 30) < 0.001 and '"grupo":"p1"' in pg['detalhes'] for pg in e['pagamentos']))
        await expect(o.locator('.pm-pessoa-conta-paga', has_text='Ana')).to_be_visible(timeout=20000)
        ok('no celular, a Ana aparece como paga')

        # ---------- garçom cancela item com conta já paga: PIN do gerente ----------
        await item(g, 'Suco').click(timeout=20000)
        await g.get_by_role('button', name='Cancelar item').click()
        await expect(g.get_by_text('Autorização do gerente')).to_be_visible(timeout=10000)
        await g.select_option('#pm-quem', label='Gerente Teste')
        await g.fill('#pm-pin', '0000')
        await g.get_by_role('button', name='Autorizar').click()
        await esperar('PIN errado: recusado, contado no bloqueio e na auditoria', lambda e: e['tentativasGerente'] == 1 and any(
            a['tipo_evento'] == 'cancelamento_item' and a['sucesso'] == 0 for a in e['auditoria']))
        await item(g, 'Suco').click()
        await g.get_by_role('button', name='Cancelar item').click()
        await g.select_option('#pm-quem', label='Gerente Teste')
        await g.fill('#pm-pin', '1234')
        await g.get_by_role('button', name='Autorizar').click()
        await esperar('PIN certo: suco cancelado no computador', lambda e: any(i['nome'] == 'Suco' and i['cancelado'] == 1 for i in e['itens']))
        await expect(item(g, 'Suco')).to_have_count(0, timeout=15000)
        ok('suco some da comanda no celular')

        # ---------- operador fecha o resto em dinheiro com troco ----------
        await o.get_by_role('tab', name='Mesa inteira').click()
        await expect(o.locator('.pm-a-receber')).to_contain_text('4,50', timeout=20000)
        await no_meio(o.locator('.metodos-pagamento .metodo', has_text='Dinheiro'))
        await o.locator('[id^="rec-"]').fill('10')
        await expect(o.get_by_text(re.compile('Troco'))).to_contain_text('5,50')
        await no_meio(o.get_by_role('button', name=re.compile('^Receber R')))
        await esperar('conta toda paga: venda finalizada e mesa aguardando limpeza', lambda e: e['mesas'][0]['status'] == 'aguardando_limpeza'
                      and any(v['status'] == 'finalizada' for v in e['vendas']))
        e = pc('/estado')
        dinheiro = [pg for pg in e['pagamentos'] if pg['metodo'] == 'dinheiro'][0]
        assert abs(dinheiro['valor'] - 4.5) < 0.001 and '"troco":5.5' in dinheiro['detalhes'], dinheiro
        ok('dinheiro entra só R$ 4,50 no caixa, troco R$ 5,50 registrado')
        await expect(o.get_by_role('button', name=re.compile(r'^Mesa 1'))).to_contain_text('limpeza', timeout=20000)
        ok('operador volta para as mesas e vê a mesa 1 em limpeza')

        # ---------- garçom marca a mesa limpa ----------
        await g.get_by_role('button', name=re.compile('Voltar para as mesas')).first.click(timeout=20000)
        await g.get_by_role('button', name=re.compile(r'^Mesa 1')).click()
        await g.get_by_role('button', name='Marcar como limpa').click()
        await esperar('mesa 1 livre de novo', lambda e: e['mesas'][0]['status'] == 'livre')

        # ---------- meu turno ----------
        await o.locator('.nav-item[data-aba="vendas"]').click()
        await expect(o.locator('#meu-turno')).to_contain_text('Recebi nas mesas', timeout=30000)
        await expect(o.locator('#meu-turno')).to_contain_text('34,50')
        ok('"Meu turno" mostra R$ 34,50 recebidos nas mesas')
        await o.screenshot(path=FOTOS + 'e2e-5-meu-turno.png', full_page=True)

        # ---------- mesas unidas: a principal mostra o grupo, o caixa separa pelo cartão da unida ----------
        def mesa(e, n):
            return next(m for m in e['mesas'] if m['numero'] == n)
        assert pc('/juntar?principal=3&outra=4')['ok']
        await o.locator('.nav-item[data-aba="mesas"]').click()
        await expect(o.get_by_role('button', name=re.compile(r'^Mesa 3 \+ 4'))).to_contain_text('unida com 4', timeout=20000)
        await expect(o.get_by_role('button', name=re.compile(r'^Mesa 4'))).to_contain_text('unida à mesa 3')
        ok('principal mostra "Mesa 3 + 4 · unida com 4"; a 4 mostra "unida à mesa 3"')
        await o.get_by_role('button', name=re.compile(r'^Mesa 4')).click()
        await expect(o.get_by_role('button', name=re.compile(r'^Abrir a comanda \(Mesa 3 \+ 4\)'))).to_be_visible(timeout=10000)
        await o.wait_for_timeout(500)  # folha terminando de subir
        await o.screenshot(path=FOTOS + 'e2e-6-unida-opcoes.png', full_page=True)
        await o.get_by_role('button', name=re.compile('^Separar a Mesa 4')).click()
        await esperar('caixa separou a mesa 4 pelo cartão dela', lambda e: mesa(e, '4')['status'] == 'aguardando_limpeza'
                      and mesa(e, '4')['unida_a'] is None and mesa(e, '3')['status'] == 'ocupada')
        await expect(o.get_by_role('button', name=re.compile(r'^Mesa 4'))).to_contain_text('limpeza', timeout=20000)
        await o.get_by_role('button', name=re.compile(r'^Mesa 4')).click()
        await o.get_by_role('button', name='Marcar como limpa').click()
        await esperar('mesa 4 livre de novo', lambda e: mesa(e, '4')['status'] == 'livre')

        # garçom: tocar na unida abre direto a comanda do grupo
        assert pc('/juntar?principal=3&outra=4')['ok']
        await expect(g.get_by_role('button', name=re.compile(r'^Mesa 4'))).to_contain_text('unida à mesa 3', timeout=20000)
        await g.get_by_role('button', name=re.compile(r'^Mesa 4')).click()
        await expect(g.locator('.pm-barra')).to_contain_text('Mesa 3', timeout=20000)
        assert await g.get_by_role('button', name=re.compile('^Separar')).count() == 0
        ok('garçom: tocar na mesa 4 abre a comanda da mesa 3, sem separar')

        # nome da pessoa dado na tela de lançar vai para o computador
        await g.get_by_role('button', name=re.compile('^Adicionar itens para')).click()
        await g.get_by_role('radio', name='Pessoa 1', exact=True).click()
        await g.get_by_role('radio', name='Pessoa 1', exact=True).click()
        await g.fill('#pm-texto', 'Bia')
        await g.wait_for_timeout(500)  # folha terminando de subir
        await g.screenshot(path=FOTOS + 'e2e-8a-lancar-dar-nome.png')
        await g.get_by_role('button', name='Salvar', exact=True).click()
        await esperar('nome "Bia" dado na tela de lançar gravado no computador', lambda e: any(
            p['nome'] == 'Bia' and p['numero'] == 1 and p['sale_id'] == mesa(e, '3')['sale_id'] for p in e['pessoas']))
        await expect(g.get_by_role('radio', name='Bia', exact=True)).to_be_visible(timeout=20000)
        await expect(g.locator('.pm-barra')).to_contain_text('Para: Bia')
        await g.wait_for_timeout(300)
        await g.screenshot(path=FOTOS + 'e2e-8-lancar-nome.png')
        ok('tela de lançar mostra "Bia" no botão e em "Para:"')

        # a Bia é cliente do cadastro: o garçom liga a pessoa da mesa a ela pelo celular
        await g.get_by_role('button', name='Voltar para a comanda').click()
        # 1º toque escolhe a pessoa; tocar na pessoa já escolhida abre as opções dela.
        await g.get_by_role('radio', name='Bia', exact=True).click(timeout=20000)
        await g.wait_for_timeout(300)
        if await g.get_by_role('button', name=re.compile('^Ligar a um cliente do cadastro')).count() == 0:
            await g.get_by_role('radio', name='Bia', exact=True).click()
        await g.get_by_role('button', name=re.compile('^Ligar a um cliente do cadastro')).click()
        await g.fill('#pm-busca-cliente', 'mari')
        await expect(g.get_by_role('button', name=re.compile('^Mariana Teste'))).to_contain_text('terminado em 5678', timeout=20000)
        await g.wait_for_timeout(300)
        await g.screenshot(path=FOTOS + 'e2e-9-ligar-cliente.png')
        await g.get_by_role('button', name=re.compile('^Mariana Teste')).click()
        await esperar('pessoa 1 da mesa 3 ligada à cliente Mariana (o apelido "Bia" fica)', lambda e: any(
            p['numero'] == 1 and p['customer_id'] == 'cli-mariana' and p['nome'] == 'Bia' and p['sale_id'] == mesa(e, '3')['sale_id'] for p in e['pessoas']))
        await expect(g.locator('.pm-chip-cliente', has_text='Bia')).to_be_visible(timeout=20000)
        ok('celular mostra a Bia marcada como cliente do cadastro')

        # grupo quebrado no banco (como o do cliente): o computador conserta e o celular não fica preso
        pc('/quebrar-grupo?principal=3')
        await esperar('computador conserta a mesa 4 (sai do grupo, vai para limpeza)', lambda e: mesa(e, '4')['unida_a'] is None
                      and mesa(e, '4')['status'] == 'aguardando_limpeza' and mesa(e, '3')['status'] == 'livre')
        await expect(o.get_by_role('button', name=re.compile(r'^Mesa 4'))).to_contain_text('limpeza', timeout=20000)
        await expect(o.get_by_role('button', name=re.compile(r'^Mesa 3'))).to_contain_text('livre')
        await expect(o.get_by_text('unida à mesa')).to_have_count(0)
        ok('celular mostra a mesa 4 em limpeza e a 3 livre -- nada de "unida" sem grupo')
        await o.screenshot(path=FOTOS + 'e2e-7-grupo-consertado.png', full_page=True)

        e = pc('/estado')
        erros_cmd = [c for c in e['comandos'] if not c['ok']]
        print('\n'.join(passos))
        print('comandos:', len(e['comandos']), '| recusados:', erros_cmd)
        print('erros de página:', erros)
        assert not erros, erros
        await nav.close()


async def com_foto():
    try:
        await main()
    except Exception:
        print('\n'.join(passos))
        raise

asyncio.run(com_foto())
