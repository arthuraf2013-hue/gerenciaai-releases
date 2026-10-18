# GerenciaAI PDV — PDV mobile autônomo (Android)

App de ponto de venda que roda **só no celular**, sem computador: vende com
e sem internet, guarda tudo no SQLite do aparelho e continua controlado pela
Central (licença, bloqueios, backup). Feito para vender o sistema a quem não
tem computador. Quando o cliente compra um computador depois, os dados vão
para o GerenciaAI do computador (migração) e o celular pode virar **terminal**
dele.

Não confundir com o "PDV móvel" do `pwa-mobile/` (celular pareado que só vende
através do computador, sempre online).

## Estrutura

| Pasta | O que tem |
|---|---|
| `src/db/` | `Banco` (fila única de acesso + transações), drivers (SQLite nativo no Android via `@capacitor-community/sqlite`; sql.js no navegador e nos testes) e `schema.js` (migrações numeradas — migração publicada nunca muda). |
| `src/services/` | Regras de negócio, sem UI: `vendas`, `caixa`, `produtos`, `clientes` (fiado), `usuarios` (PIN), `pix`, `relatorios`, `licenca`, `backup`, `terminal`, `nuvem` (Firebase), `nuvemDemo` (nuvem simulada do navegador). |
| `src/ui/` | React (telas em `telas/`, componentes em `comp/`). |
| `src/app/` | Ligação com a plataforma (Capacitor x navegador) e `iniciar.js` (sobe os serviços na ordem). |
| `tests/` | `node --test`, banco sql.js em memória e uma nuvem falsa com o mesmo contrato da de verdade. |
| `scripts/gerarFixtureMigracao.mjs` | Gera, com o PRÓPRIO código do app, os backups e eventos usados nos testes do desktop (`tests/fixtures/`). Rode de novo sempre que mudar o formato do backup ou dos eventos. |

Regras que valem para o banco inteiro: dinheiro em **centavos inteiros**,
quantidade em **milésimos** (1 un = 1000), IDs UUID gerados no aparelho, datas
ISO em UTC. Estoque e fiado são **livro + saldo em cache** atualizados na mesma
transação.

## Licença (Central)

- Ativação com código de 8 caracteres gerado na Central para o cliente
  (`ativacoes_mobile/{codigo}`); cria `installations/{id}` com
  `tipo: 'pdv_mobile_autonomo'`.
- Congelada: 2 dias de aviso vendendo, depois só consulta. Bloqueio imediato:
  trava na hora. **3 dias sem falar com a Central: trava** (aviso a partir do
  2º dia). Relógio do celular voltado para trás: trava.
- O relógio confiável é o maior horário já visto (aparelho ou servidor), então
  atrasar o relógio não estica prazo nenhum.

## Backup na nuvem

- Automático a cada 1 h (a Central muda de 1 a 24 h), só quando algo mudou.
- Arquivo `gerenciaai-pdv-mobile-backup` v1 (JSON compactado) em
  `backups/{installId}/mobile-*.json.gz` no Storage + registro em
  `installations/{id}/backups`. Guarda tudo das últimas 48 h e depois um por
  dia até 30 dias (a Central define até quanto).
- A Central pode pedir backup agora e pedir restauração; antes de restaurar o
  celular sempre salva o estado atual.
- Dados "do aparelho" ficam fora do backup: licença, relógio, fila do modo
  terminal (`sync_saida`) e o vínculo com o computador.

## Migração para um computador

No GerenciaAI do computador (Configurações → "Trazer dados de um PDV mobile",
admin): pede um backup novo ao celular, mostra uma conferência celular ×
computador e só grava se tudo bater. Pode repetir (traz só o novo). Ver
`electron/services/pdvMobileMigracaoService.js`. A Central marca o celular
como "Migrado p/ <computador>" e guarda os backups dele por 30 dias.

## Modo terminal (celular vinculado ao computador)

Depois da migração, na Central: **"Usar como terminal"** na linha do celular.

- O celular continua vendendo igual, **inclusive offline**, no caixa dele.
- Cada fato vira um evento na tabela `sync_saida`, gravado **na mesma
  transação** do fato: venda, venda cancelada, fiado recebido, cliente
  novo/editado. Ao virar terminal entra também o "atraso" (tudo desde a
  migração, inclusive entrada/contagem de estoque).
- Com internet, a fila sobe para `installations/{celular}/terminal_eventos`;
  o computador aplica cada evento uma vez só e responde em `terminal_acks`
  (com a NFC-e, se ligada lá). Ver `electron/services/pdvMobileTerminalService.js`.
- Produtos, preços, estoque e clientes passam a vir do computador
  (`terminal_catalogo`). Cadastro de produto e estoque ficam travados no
  celular. O estoque mostrado = o do computador menos o que este celular
  vendeu e o computador ainda não confirmou.
- NFC-e: o celular nunca emite. O computador pode emitir quando a venda chega
  (desligado por padrão, com janela de minutos — a nota sai com a hora em que
  foi emitida).
- **"Voltar a autônomo"** na Central só é liberado sem nada pendente; o que
  ainda estiver na fila continua indo para o computador.

## Desenvolvimento

```bash
npm ci
npm test          # vendas, caixa, licença, backup, terminal
npm run dev       # modo navegador, com nuvem simulada (código de ativação DEMO2026)
```

No modo navegador, `window.__pdvDemo` expõe os serviços — por exemplo, para
simular a Central e o computador:

```js
const id = __pdvDemo.licenca.estado.installId;
__pdvDemo.nuvem.simularPainel(id, { migradoPara: 'pc', migradoCorteMs: Date.now() });
__pdvDemo.nuvem.simularPainel(id, { modoOperacao: 'terminal', servidorInstallId: 'pc', servidorNome: 'Caixa do balcão' });
__pdvDemo.nuvem.computador.publicarCatalogo(id, { versao: 'v1', produtos: [...], clientes: [] });
__pdvDemo.nuvem.computador.confirmarTodos(id);
```

`?nuvem=real` na URL usa o Firebase de verdade a partir do navegador.

## Gerar o APK

Requisitos locais: Node 22+, JDK 21, Android SDK (plataforma 36).

```bash
npm run android:apk-debug     # APK de teste (assinatura de debug)
npm run android:apk-release   # APK de produção (precisa da chave, abaixo)
```

Pelo GitHub (recomendado): `.github/workflows/mobile-android.yml`.
- Aba Actions → "PDV mobile — build do APK Android" → Run workflow: gera o APK
  como artefato, para testar.
- Publicar versão: ajuste `version` em `mobile/package.json` e crie a tag
  `mobile-vX.Y.Z` (igual à versão). Sai uma release **pré-lançamento** com o
  APK — nunca vira "latest", então o atualizador do desktop ignora.

O `versionCode` do Android vem da versão (1.2.3 → 10203): cada versão
publicada precisa ser maior que a anterior para instalar por cima.

### Chave de assinatura

**Todas as versões precisam ser assinadas com a mesma chave** — sem ela os
celulares dos clientes não aceitam a atualização (teriam que desinstalar e
perder os dados locais). Guarde o arquivo e as senhas em dois lugares seguros.

Gerar uma vez:

```bash
keytool -genkeypair -v -keystore gerenciaai-pdv.jks -alias gerenciaai -keyalg RSA -keysize 2048 -validity 10000
```

Para o GitHub Actions, cadastre 4 secrets no repositório (Settings → Secrets
and variables → Actions):

| Secret | Valor |
|---|---|
| `GERENCIAAI_KEYSTORE_BASE64` | o `.jks` inteiro em base64 (`base64 -w0 gerenciaai-pdv.jks`; no Windows: `certutil -encode gerenciaai-pdv.jks saida.txt` e copie sem as linhas BEGIN/END) |
| `GERENCIAAI_KEYSTORE_PASSWORD` | senha do arquivo |
| `GERENCIAAI_KEY_ALIAS` | `gerenciaai` (ou o alias que usou) |
| `GERENCIAAI_KEY_PASSWORD` | senha da chave |

Para gerar o APK de produção na sua máquina, crie
`mobile/android/keystore.properties` (já está no `.gitignore`, nunca suba):

```properties
storeFile=C:/caminho/gerenciaai-pdv.jks
storePassword=...
keyAlias=gerenciaai
keyPassword=...
```

## Publicar o que o app usa no Firebase

As regras ficam na raiz do repositório:

```bash
firebase deploy --only firestore:rules
```

`firestore.rules` já tem `ativacoes_mobile` e as subcoleções do modo terminal
(`terminal_eventos`, `terminal_acks`, `terminal_catalogo`). O Storage usa a
mesma regra de `backups/{installId}/...` do backup do desktop
(LICENCIAMENTO.md, Passo 3.6).
