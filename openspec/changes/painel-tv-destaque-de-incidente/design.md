## Context

O time de suporte quer um telão. O que existe hoje é a status page do cliente
(`/status/<slug>`), que serve a outro propósito: comunicar estado a quem visita, na ordem de
leitura, sem hierarquia visual. Numa TV a 4 metros, uma linha vermelha entre 50 não é um alarme.

O design já está fechado e entregue em `docs/design_handoff_status_destaque/`:
- `README.md` — spec hi-fi (medidas, tokens, estados, comportamento, gerência de estado).
- `referencia-visual.html` — os três estados renderizados, autocontido (fonte e tokens
  embutidos, zero dependência externa). É a referência de aparência.
- `painel-funcional.html` + `painel.js` — implementação de referência **executável**, JS puro,
  sem build. É onde a lógica de paginação medida, detecção de mudança e pulso está resolvida.
- `winker-tokens-styles.css` + `fonts.css` — tokens `.wk-*` e Plus Jakarta Sans em base64.

O trabalho não é inventar a tela; é encaixá-la no Uptime Kuma sem quebrar o que já roda e sem
encarecer o merge do upstream.

**Estado atual relevante do código:**
- `Heartbeat.toPublicJSON()` (`server/model/heartbeat.js:19-26`) zera `msg` de propósito
  (`"Hide for public"`). O valor cru vem de `bean.msg = error.message`
  (`server/model/monitor.js:918`) e carrega IP, porta, host e query.
- A status page pública não abre socket (`noSocketIOPages`, `src/mixins/socket.js:19-21`); é
  polling REST. `/api/status-page/heartbeat/:slug` tem `cache("1 minutes")` e
  `/api/status-page/:slug` tem `cache("5 minutes")`.
- Monitor tipo `group` vai a `DOWN` quando qualquer filho cai
  (`server/monitor-types/group.js`).
- A expansão de filhos de grupo já existe (change `status-page-monitores-do-grupo`:
  `monitor_group.show_children`, `Group.toPublicJSON` devolve `childrenList`).
- `src/pages/StatusPage.vue` está **idêntico ao upstream** desde o revert `0baf0056`.

## Goals / Non-Goals

**Goals:**
- Painel em rota própria, com o design reproduzido fielmente em canvas fixo 1920 × 1080.
- Reusar a curadoria da status page como fonte da lista — mudar o telão é editar a página.
- Entregar a linha do erro sem publicar detalhe de infraestrutura.
- Custo de merge com o upstream próximo de zero: quase tudo em arquivo novo.
- Cobrir os quatro estados do Kuma, inclusive `MAINTENANCE`, que o design não previu.

**Non-Goals:**
- Alterar a status page do cliente. É a separação que motiva esta mudança.
- Tempo real. Fica no modelo de polling do upstream, com a latência que isso implica.
- Responsividade, interação, som, histórico de incidentes no painel.
- Corrigir o `feedInterval` duplicado do `mounted()` de `StatusPage.vue` (upstream).

## Decisions

### 1. Página Vue nova na SPA, não CSS/JS injetado na status page

**Decisão:** rota `/status/<slug>/tv` servida por uma página Vue nova, com componentes próprios.

O README levanta duas rotas de implementação. A rota 1 (status page + customização) não é
viável aqui: o Uptime Kuma aceita apenas `customCSS` na status page — **não existe campo de JS
customizado**. Promoção do caído, paginação medida e pulso são estado derivado; fazê-los por
cima do DOM da status page significaria editar `StatusPage.vue` (1.832 linhas, arquivo quente do
upstream) ou injetar script por fora, frágil e invisível para o teste.

*Alternativas descartadas:* (a) app separado consumindo a API — dobra deploy, imagem e
observabilidade para uma tela; a SPA já está construída e servida. (b) Reaproveitar
`StatusPage.vue` com uma prop `tv` — é o caminho direto para o conflito de merge e para a
regressão na tela do cliente.

**Divergência do upstream:** rota e página são exclusivas do fork. Custo de merge: 1 linha em
`src/router.js` (aditiva, no meio do array — conflito trivial se o upstream mexer perto) e 1
linha em `noSocketIOPages` de `src/mixins/socket.js`. Todo o resto é arquivo novo.

### 2. Um endpoint só, com tudo que o painel precisa

**Decisão:** `GET /api/status-page/<slug>/tv` devolve, numa resposta, a lista de monitores (id,
nome, tipo), o estado atual, os heartbeats recentes e o rótulo de erro saneado.

Compor o painel com os dois endpoints existentes (`/api/status-page/:slug` para a lista, cache
de 5 min; `/heartbeat/:slug` para as batidas, cache de 1 min) traz um defeito conhecido de
graça: **caches diferentes desalinham as duas metades**. Um monitor recém-adicionado já tem
heartbeat e ainda não está na lista — e some do painel por até 5 minutos, sem erro. Um consumidor
de propósito único merece um payload de propósito único.

*Alternativa descartada:* acrescentar o campo saneado ao `/heartbeat/:slug` existente. Mistura
duas audiências no mesmo endpoint (a status page pública não deve ganhar mensagem de erro por
efeito colateral) e amarra o cache de um ao ciclo do outro.

**Custo de merge:** um `router.get` no fim de `server/routers/status-page-router.js` — aditivo.

### 3. Saneamento por allowlist que RENDERIZA rótulo, com default deny

**Decisão:** o saneador reconhece um padrão e **devolve um rótulo próprio**; nunca repassa a
string de entrada. O que não casa vira `Sem resposta`.

Mapa inicial (derivado do que o código realmente grava):

| Entrada (`heartbeat.msg`) | Rótulo |
|---|---|
| `Request failed with status code <n>` | `HTTP <n> · <texto canônico do código>` |
| `timeout by AbortSignal (<n>s)` | `timeout <n>s` |
| contém `ECONNREFUSED` | `Conexão recusada` |
| contém `ENOTFOUND` / `EAI_AGAIN` | `Host não encontrado` |
| contém `ETIMEDOUT` / `ESOCKETTIMEDOUT` | `Sem resposta a tempo` |
| contém `CERT_HAS_EXPIRED` / `certificate` | `Certificado inválido` |
| `Monitor under maintenance` | `Em manutenção` |
| `Child monitors down: …` | `Serviços do grupo fora do ar` |
| qualquer outra coisa | `Sem resposta` |

O ponto não é a lista — é a **direção**. Blocklist (redigir IP, host, senha por regex) falha no
caso que ninguém previu, e o caso que ninguém previu é exatamente o que vaza. Allowlist que
renderiza falha fechada: uma mensagem nova de um monitor type novo cai no genérico até alguém
decidir o rótulo dela.

O rótulo do status HTTP sai de um mapa código → texto **local**, não do `statusText` da resposta:
`statusText` vem do servidor remoto e é texto arbitrário controlado por terceiro.

*Alternativa descartada:* mandar a mensagem crua e tratar no navegador. O dado já teria saído do
servidor — o navegador é tarde demais.

### 4. `MAINTENANCE` não é queda, e grupo expandido não conta duas vezes

Dois casos em que o design, escrito antes do encaixe, produziria número errado no telão:

- **Manutenção:** o design tem três estados e o Kuma tem quatro. Sem regra, o monitor em janela
  de manutenção programada entra no bloco vermelho e some da lista — alarme falso, e o time
  aprende a ignorar o painel. **Decisão:** `MAINTENANCE` fica na lista, com cor própria, e não
  entra no destaque nem na contagem de fora do ar.
- **Grupo expandido:** com `show_children` ligado, grupo e filhos estão os dois no painel. Um
  filho cai → o filho vai a `DOWN` **e** o grupo vai a `DOWN`: a mesma queda apareceria duas
  vezes no destaque e contaria dois no "N de 50". **Decisão:** monitor tipo `group` com
  expansão ligada sai do universo do painel — os filhos já carregam a mesma informação com mais
  detalhe. Grupo **sem** expansão continua como linha única e pode ser promovido normalmente.

### 5. Teto do destaque: 9 cards

O canvas é fixo com `overflow: hidden` e o bloco de destaque é `flex:0 0 auto` — ele não encolhe,
ele **transborda e é cortado em silêncio**, no cenário em que o painel mais importa.

Orçamento vertical de 1080 px (padding 40 × 2 → 1000 úteis, `gap: 28`):

```
cabeçalho ...................  98   (eyebrow 26 + gap 8 + título 64)
gap .........................  28
destaque .................... 111 + 155 × linhas   (borda 6 + faixa 85 + padding 32; card 143 + gap 12)
gap .........................  28
seção lista (mínimo) ........ 109   (título 41 + gap 12 + 1 linha 56)
                              ----
sobra para o destaque ....... 737  →  linhas ≤ 4,04
```

Quatro linhas cabem por 5 px e deixam a lista com **uma** linha — um painel que só mostra o que
está quebrado deixa de responder "e o resto está bom?". **Decisão:** teto de **9** cards
(3 × 3). Sobram ~155 px, que a medição da lista converte em 2–3 linhas úteis.

**Revisão de 2026-08-25 — queda em massa.** A primeira versão resumia o excedente em "e mais N
fora do ar" na faixa. Em produção, com 32 de 48 fora, isso deixou 23 quedas invisíveis: nem no
destaque (teto de 9) nem na lista (que exclui os caídos) — o número na faixa era a única
evidência delas. Acima do teto, os cards saem de cena: fica só a faixa de contagem e a lista
assume com TODOS os monitores, caídos primeiro (ordenação estável por gravidade, curadoria
preservada dentro de cada estado) e com o rótulo saneado da causa ao lado do nome. A lista
recupera a altura dos cards (~24 linhas por página em 2 colunas) e a rotação de 15 s varre tudo
em ~30 s. Dentro do teto, nada muda.

Os números acima usam entrelinha aproximada: a implementação **confere no render real** com o
cenário de 50 monitores fora, e o teto é constante nomeada, num lugar só.

### 6. O refresh vem da configuração da status page (revisto em 25/08/2026)

**Decisão original:** painel atualiza a cada 60 s fixos; o endpoint usa `cache("1 minutes")`.

**Revisão:** o intervalo passa a ser o **"Intervalo de atualização" da própria status page**
(`status_page.auto_refresh_interval`), publicado no payload e relido a cada ciclo — com padrão de
60 s e piso de 5 s. Havia uma configuração na tela que o painel ignorava: a página `situator`
estava em 30 s e o telão lia de 60 em 60.

O que derrubou a premissa original ("pedir mais rápido devolve o mesmo dado"): `apicache.clear()`
dispara a cada heartbeat **importante** (`server/model/monitor.js`), ou seja, toda mudança de
status invalida o cache na hora. Ler mais rápido que o cache não devolve dado velho quando o que
importa mudou — devolve a queda mais cedo. O cache de 1 minuto segue protegendo o banco do
regime permanente.

Por isso a leitura virou uma **cadeia de `setTimeout`**, e não um `setInterval`: só assim mudar a
configuração vale sem alguém ir até a TV recarregar a página.

Consequência que continua valendo: entre a queda real e o destaque acender passa até um ciclo. O
pulso de 30 s marca "mudou nesta leitura", não "mudou neste instante".

### 7. Fonte embutida como asset do build

Plus Jakarta Sans não existe no Uptime Kuma (`src/assets/app.scss` usa a stack do sistema). Sem
ela as métricas do design não fecham. **Decisão:** os `@font-face` em base64 já prontos no pacote
de handoff entram como CSS próprio do painel, com escopo na página — sem CDN (o painel roda em
rede interna) e sem alterar a tipografia do resto da aplicação.

### 8. Despublicar fecha o painel

O endpoint novo expõe mais que a status page (o rótulo de erro). **Decisão:** ele recusa com 404
quando `status_page.published = 0`.

**Divergência do upstream, deliberada:** o `/heartbeat/:slug` existente **não** checa `published`
(`isPublished` é computado em `StatusPage.vue:773` e não é usado em lugar nenhum). Não corrijo o
endpoint do upstream de carona — mas a superfície nova nasce com a regra estrita, para que
"despublicar" signifique o que o administrador espera. Custo de merge: zero, é arquivo/rota nova.

### 9. Onda contínua na faixa, e o pulso em dois níveis

O destaque tinha um único estado forte — o pulso de 15 s — e depois dele ficava parado. Numa parede
que ninguém observa, parado é invisível: a queda de duas horas some da atenção junto com o pulso.

**Decisão:** dois níveis. (a) **Estado**, enquanto houver queda: três senóides brancas em
velocidades diferentes atravessam a faixa vermelha, no espírito da onda dos assistentes de IA —
movimento permanente, baixo contraste, sem piscar. (b) **Notícia**, durante o pulso: a onda cresce e
clareia, a faixa bate entre o vermelho de erro e um mais fundo, o anel do bloco vai a 32 px e o
ponto branco vira farol. E o pulso passa de 15 s para **30 s**, porque quinze segundos cabem
inteiros entre duas olhadas.

**Por que faixa mais fundo, e não mais clara:** o texto de cima é branco. Clarear o fundo é perder
contraste justo no instante em que ele devia chamar mais.

**Custo:** três `<svg>` animados por `transform: translateX`, sempre que houver queda. É o
compositor, não layout; a translação fica nas camadas e a amplitude no pai, para os dois transforms
não disputarem o mesmo elemento. Nada aqui é mais novo que CSS transforms — a mesma régua da
correção de encaixe, ditada pelo browser da TV.

## Risks / Trade-offs

- **[Mensagem nova de monitor type novo vira `Sem resposta` genérico]** → É o comportamento
  desejado (falha fechada), mas degrada a tela em silêncio. Mitigação: teste do saneador
  enumera as entradas conhecidas, e o rótulo genérico é distinguível na revisão de tela.

- **[O saneador é a peça com regra de segurança e roda num caminho público]** → Mitigação: teste
  em `test/backend-test/` caso a caso, incluindo os que devem cair no default deny; e uma
  asserção sobre o **corpo inteiro** da resposta (normalizado) provando que o identificador
  plantado não aparece em campo nenhum. Asserção de ausência precisa de controle positivo no
  mesmo teste — provar que a busca acharia o identificador se ele estivesse lá — senão ela passa
  por engano quando a rota devolve vazio.

- **[Latência de um ciclo entre a queda e o telão]** → Aceito. Registrado em "Pendências
  futuras" do proposal, com socket como saída se virar problema real.

- **[Canvas fixo numa TV de resolução diferente]** → O quadro inteiro é escalado por
  `transform: scale`, como faz o `painel-funcional.html`. Não reflui; abaixo de 1920 o texto
  encolhe proporcionalmente.

- **[Painel público expõe nomes de monitor e agora rótulo de erro]** → Os nomes já eram públicos
  na status page. O que muda é o rótulo, que por construção não carrega endereço. Despublicar
  fecha a porta (decisão 8).

- **[Merge do upstream mexer em `router.js` ou `noSocketIOPages`]** → Conflito de 1 linha em cada,
  resolução óbvia. É o piso de custo de qualquer rota nova no fork.

- **[A regra do grupo expandido esconde o nome do grupo do telão]** → Trade-off aceito: os filhos
  dizem mais que o agregado. Se o nome do grupo fizer falta como contexto, ele volta como prefixo
  no nome do filho — decisão de tela, não de dado.

## Migration Plan

Não há migration de banco: o painel só lê, e a coluna de que ele depende (`show_children`) já
existe.

1. Backend (saneador + endpoint) com teste, sem tocar em nada existente.
2. Frontend (página, componentes, fonte, rota, `noSocketIOPages`).
3. `npm run build` — a página nova entra no `dist/`; a imagem do fork copia `dist/` cirurgicamente
   (`docker/winker.dockerfile`), sem `COPY` novo a ajustar.
4. Deploy normal em `monitor-clientes.winker.com.br`; abrir `/status/<slug>/tv` na TV.

**Rollback:** reverter o commit. Nada fora da rota nova muda de comportamento — a status page do
cliente, o endpoint público existente e o schema ficam intocados, então o rollback não tem efeito
colateral.

## Open Questions

- **Qual slug alimenta o telão?** A decisão de arquitetura é "um slug de status page"; qual deles
  (ou se nasce um novo, dedicado, com a curadoria do NOC) é operacional e pode ser resolvido na
  implementação.
- **O texto canônico dos códigos HTTP** sai de um mapa próprio ou de uma dependência já presente?
  Decidir na implementação, preferindo mapa próprio pequeno aos códigos que os monitores de fato
  produzem.
- **45 s vs 60 s** — fica 60 s por ora (proposal, "Pendências futuras"). Trocar é mudar as duas
  constantes juntas.
