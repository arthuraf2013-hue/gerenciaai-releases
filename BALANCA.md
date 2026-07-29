# Integração com balança — guia

Três formas de trabalhar com produtos vendidos por peso (kg), em ordem
de quanto cada uma foi testada aqui:

1. **Peso digitado manualmente** — sempre funciona, não depende de
   nenhum hardware. Testado a fundo.
2. **Etiqueta impressa pela balança** (código de barras com o peso
   embutido) — a lógica de decodificar foi testada a fundo, mas o
   **formato exato precisa ser confirmado com uma etiqueta de verdade**
   da sua balança (ver abaixo).
3. **Balança digital conectada por porta serial** (leitura em tempo
   real) — implementada, mas **não testada contra hardware real** (não
   havia uma balança disponível pra testar). Precisa de validação
   cuidadosa antes de confiar no dia a dia — ver seção própria abaixo.

## 1. Cadastrando um produto vendido por peso

Em Produtos → Novo produto (ou editar um existente), escolha
"Unidade: Kg (vendido por peso)". Vai aparecer um campo extra "Código
do produto na balança" — esse é o código **curto** (5-6 dígitos,
diferente do código de barras normal) que você cadastra **na própria
balança** pra identificar aquele produto. Precisa bater exatamente com
o que está configurado lá.

O preço cadastrado no produto é sempre **por kg**.

## 2. Etiqueta de peso variável — confirme o formato antes de confiar

Não existe um único formato de etiqueta — cada balança é configurada
pelo fabricante/técnico. Fui atrás da documentação técnica oficial de
um fabricante brasileiro de balanças (Urano) pra confirmar os formatos
mais comuns, e implementei os 3 mais usados, configuráveis em
Configurações → Balança:

| Formato | Estrutura | Uso comum |
|---|---|---|
| `peso_cod6` (padrão) | `2` + código (6 dígitos) + peso em gramas (5 dígitos) + verificador | Um dos mais comuns entre fabricantes |
| `peso_cod5b` | `2` + código (5 dígitos) + zero + peso em gramas (5 dígitos) + verificador | Variante comum |
| `peso_prefixo20` | `20` + código (4 dígitos) + peso (6 dígitos) + verificador | Comum em balanças Toledo |

**Como confirmar que está certo**: em Configurações → Balança, tem um
campo "Testar com um código de barras" — escaneie (ou digite) uma
etiqueta de verdade impressa pela sua balança e confira se o peso
decodificado bate com o peso real do produto pesado. Se não bater,
troque o formato na lista e teste de novo.

**O dígito verificador (a parte que garante que a leitura não foi
corrompida) segue o padrão oficial EAN-13 e foi testado contra um
código real e documentado publicamente** — essa parte não muda entre
fabricantes, só a posição dos campos (código/peso) é que varia.

Se nenhum dos 3 formatos bater com a etiqueta da sua balança, me avise
com um exemplo de etiqueta (o número completo de 13 dígitos, e o peso
real correspondente) que eu adiciono um formato novo.

## 3. Balança digital (porta serial) — ⚠️ precisa de teste com hardware real

Em Configurações → Balança:
1. "Buscar portas seriais disponíveis" — lista as portas COM que o
   Windows enxerga (a balança precisa estar ligada e conectada por
   cabo serial/USB-serial antes de buscar).
2. Escolha a porta certa e a velocidade (baud rate) — consulte o
   manual da sua balança pra saber qual usar (9600 é o mais comum,
   mas varia).

**Como funciona por dentro**: quando você abre a tela de pesagem no
PDV, o app tenta se conectar na porta configurada e escuta o que a
balança manda continuamente. Pra extrair o peso do que chega, uso uma
abordagem genérica — procuro o primeiro número decimal no texto
recebido (funciona pra protocolos simples tipo `"1.234kg"`,
`"N003,500"`, etc.) — não implementei o protocolo exato de nenhuma
marca específica, porque não tive como testar contra hardware real
pra confirmar qual usar.

**Teste isto com cuidado antes do dia a dia**:
- Conecte a balança, abra Configurações → Balança, busque as portas,
  escolha a certa.
- Vá em Produtos, adicione um item "vendido por peso" no PDV — o modal
  de pesagem deve mostrar "Balança conectada: X.XXX kg" se a leitura
  estiver funcionando.
- Coloque um peso conhecido na balança e confira se o número bate.
- **Se não aparecer nada ou o número vier errado**, o formato que a sua
  balança manda pela porta serial não é compatível com a extração
  genérica que implementei — me avise com o modelo/marca da balança
  (e, se conseguir, um exemplo do que ela manda) que eu ajusto
  especificamente pro seu equipamento.

Enquanto a balança digital não estiver 100% confirmada, o peso digitado
manualmente (opção 1) sempre funciona como alternativa — nada trava
por causa disso.
