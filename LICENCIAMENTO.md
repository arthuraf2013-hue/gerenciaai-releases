# Licenciamento — guia de configuração

Este documento explica como colocar o sistema de licenciamento pra
funcionar. É um passo a passo — leia até o fim antes de começar,
porque a ordem importa.

## O que foi construído

- **No app** (`electron/services/licenseService.js`): a cada 6 horas
  (e ao abrir), confere com um servidor central se a instalação está
  ativa. Se estiver congelada, mostra um aviso e continua funcionando
  por **2 dias**; depois disso, bloqueia. Se não conseguir falar com o
  servidor de jeito nenhum (sem internet), continua funcionando por
  **3 dias** antes de bloquear — pra não travar alguém só por falha de
  rede.
- **O painel** (`admin-panel/index.html`): um site simples, sem
  precisar de build, onde você vê todas as instalações, o status de
  cada uma, e pode congelar ou reativar com um clique.

Os dois falam com o **mesmo projeto Firebase** — um projeto **seu**,
separado do Firebase que cada cliente configura pra sincronizar PDVs
entre si (aquilo é opcional e por conta de cada cliente; isto aqui é
seu, embutido em todo instalador, igual pra todo mundo).

## Passo 1 — Criar o projeto Firebase

1. Acesse [console.firebase.google.com](https://console.firebase.google.com)
   e crie um projeto novo (ex: "gerenciaai-licencas").
2. No menu lateral, entre em **Firestore Database** → "Criar banco de
   dados" → modo produção → escolha a região mais próxima (ex:
   `southamerica-east1`).
3. Ainda no menu lateral, entre em **Authentication** → "Vamos
   começar" → ative o provedor **E-mail/senha**.
4. Em Authentication → aba "Users" → "Add user" → cadastre **seu
   próprio e-mail e uma senha forte**. Esse é o login que você vai usar
   no painel — não dá acesso a mais ninguém além de quem você
   cadastrar aqui manualmente.

## Passo 2 — Pegar a configuração do projeto

1. No Firebase, clique na engrenagem (⚙) → "Configurações do
   projeto".
2. Role até "Seus apps" → clique no ícone `</>` (Web) → dê um nome
   qualquer (ex: "gerenciaai") → "Registrar app".
3. Vai aparecer um bloco `firebaseConfig` com `apiKey`, `authDomain`,
   `projectId`, etc. **Copie esse bloco inteiro.**

## Passo 3 — Aplicar as regras de segurança

Isso é importante: sem essas regras, qualquer instalação do app
conseguiria se autoreativar direto no banco, ou qualquer pessoa na
internet conseguiria ler/mexer nos dados. No Firebase, vá em
**Firestore Database → Regras**, apague o que estiver lá e cole:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /installations/{installId} {
      // Qualquer instalação pode criar o próprio documento na primeira
      // vez que fala com o servidor — sempre começando ativa e sem
      // bloqueio (o congelamento ou bloqueio é sempre uma ação manual
      // sua, depois, pelo painel).
      allow create: if request.resource.data.ativo == true
        && request.resource.data.bloqueioImediato == false;

      // Qualquer um pode ler (só expõe status de licença, nada sensível)
      allow read: if true;

      // Uma instalação pode atualizar SÓ os campos de "sinal de vida"
      // e de progresso da própria atualização obrigatória (nunca
      // `ativo`, `bloqueioImediato`, `clienteId` ou `nomeNegocio`
      // sozinha) — só um admin autenticado (você, logado no painel)
      // pode mudar esses campos.
      allow update: if (
        request.resource.data.diff(resource.data).affectedKeys()
          .hasOnly([
            'ultimoContato', 'versaoApp',
            'atualizacaoBaixando', 'atualizacaoProgresso', 'atualizacaoBaixado', 'atualizacaoVersaoAlvo'
          ])
      ) || request.auth != null;

      allow delete: if request.auth != null;
    }

    // "clientes" é só usado pelo painel administrativo — o app em si
    // nunca lê nem escreve aqui, só agrupa instalações visualmente e
    // permite ações em bloco (bloquear todas as máquinas de um dono
    // de uma vez). Por isso é 100% restrito a admin autenticado.
    match /clientes/{clienteId} {
      allow read, write: if request.auth != null;
    }

    // "config/atualizacao" e "config/mensagem" são documentos únicos
    // onde o painel publica, respectivamente, a versão mínima
    // obrigatória e o aviso/imagem da tela inicial — qualquer
    // instalação precisa LER os dois (o "{configId}" abaixo cobre
    // qualquer documento dentro de "config", não só um), mas só você
    // (autenticado no painel) pode publicar ou desativar qualquer um
    // dos dois. Não precisa de regra nova quando adicionar outro
    // documento de config no futuro — essa já cobre.
    match /config/{configId} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}
```

Clique em "Publicar".

**Se você já tinha publicado as regras antigas** (antes do bloqueio
imediato, dos clientes, ou da atualização obrigatória existirem):
precisa republicar com esse bloco novo de novo — **isso vale ainda
mais agora**, já que sem a parte de `config/atualizacao` e os campos
novos no `hasOnly` de `installations`, a atualização obrigatória
simplesmente não vai funcionar (o app não vai conseguir nem ler se
tem atualização publicada, nem reportar o progresso do download pro
painel).

**Antes de confiar nisso em produção**: eu não tenho como testar essas
regras ao vivo aqui (não tenho acesso a um projeto Firebase de
verdade) — eu escrevi com cuidado e segui o padrão documentado do
Firestore, mas teste você mesmo antes de depender disso: tente, pelo
simulador de regras do próprio Firebase (aba "Regras" → "Simulador"),
simular uma escrita não-autenticada tentando mudar `ativo` — deve ser
negada.

## Passo 4 — Preencher a configuração no app

Abra `electron/services/licenseService.js` e substitua o bloco
`LICENSE_FIREBASE_CONFIG` pelos valores que você copiou no Passo 2:

```js
const LICENSE_FIREBASE_CONFIG = {
  apiKey: 'AIzaSy...',
  authDomain: 'gerenciaai-licencas.firebaseapp.com',
  projectId: 'gerenciaai-licencas',
  storageBucket: 'gerenciaai-licencas.appspot.com',
  messagingSenderId: '123456789',
  appId: '1:123456789:web:abcdef',
};
```

Depois disso, publique uma versão nova (`npm version patch`) pra essa
config ir pros instaladores.

## Passo 5 — Preencher a configuração no painel

Abra `admin-panel/index.html`, ache o mesmo bloco `firebaseConfig`
(perto do topo do `<script>`) e cole os mesmos valores.

## Passo 6 — Publicar o painel

Duas opções:

**A. Rodar localmente (mais simples pra começar)** — é só abrir o
arquivo `admin-panel/index.html` direto no navegador (duplo clique).
Funciona porque o Firebase é consultado direto do navegador, não
precisa de servidor nenhum rodando.

**B. Hospedar de verdade (pra acessar de qualquer lugar, não só do seu
PC)** — usa o Firebase Hosting, que já vem junto do mesmo projeto:

```powershell
npm install -g firebase-tools
firebase login
cd admin-panel
firebase init hosting
# escolha o projeto que você criou, pasta pública = "." (a atual), sem SPA
firebase deploy
```

Isso te dá uma URL tipo `https://gerenciaai-licencas.web.app` — acesse
de qualquer navegador, faz login com o e-mail/senha do Passo 1.

## Testando

1. Rode o app localmente uma vez (`npm run dev:electron`) — isso cria
   o documento da instalação no Firestore automaticamente (sempre
   começa ativa).
2. Abra o painel, faça login — a instalação deve aparecer na lista.
3. Clique em "Congelar" — dentro de até 6h (o intervalo de checagem do
   app) ou reabrindo o app manualmente, deve aparecer o aviso de
   pendência.
4. Clique em "Reativar" — o aviso deve sumir na próxima checagem.

## O que eu não consegui testar por aqui

Não tenho acesso a um projeto Firebase de verdade neste ambiente —
tudo que escrevi (lógica de carência, regras de segurança, o painel)
foi testado isoladamente (simulações e casos de borda), mas a
integração real com o Firebase só você vai poder confirmar,
seguindo os passos acima. Recomendo testar com uma instalação de
teste antes de confiar nisso pra congelar cliente de verdade.
