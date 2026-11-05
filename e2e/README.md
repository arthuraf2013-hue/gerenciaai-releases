# Teste de ponta a ponta: celular + Firestore + computador

Dois celulares de verdade (Chrome, tela de 390 px) usando o app do celular
compilado, os emuladores do Firebase com as regras deste repositório
(`firestore.rules`), e o "computador da loja" (`computador.js`) com os
serviços de verdade do GerenciaAI e um banco de teste em memória. O
`celular.py` faz o caminho inteiro e confere a tela E o banco:

pareamento por código → aba Mesas → abrir mesa → lançar por pessoa com
observação → item sem estoque recusado → cozinha marca pronto → sem internet
(item na fila, app abre offline, entra quando volta) → nome da pessoa → mover
item → operador pareia → recebe a parte da Ana (Pix) → garçom cancela item
com PIN de gerente (errado e certo) → operador recebe o resto em dinheiro com
troco → venda finalizada, mesa em limpeza → garçom marca limpa → Meu turno.

Precisa de Java (emulador), Python 3 com Playwright e Node 22+.

```bash
npm install -g firebase-tools
pip install playwright && python -m playwright install chromium
npm --prefix pwa-mobile run build:e2e

# três terminais:
firebase emulators:start --config firebase.e2e.json --only firestore,auth --project demo-gerenciaai
node e2e/computador.js          # reinicie a cada rodada (começa do zero)
npm --prefix pwa-mobile run preview:e2e

# quarto terminal:
python e2e/celular.py           # fotos em e2e/fotos/
```

O build `build:e2e` liga o app nos emuladores (`.env.e2e`); o build normal
(`npm run build`) não tem nada disso.
