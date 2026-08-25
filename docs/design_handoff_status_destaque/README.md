# Handoff: Destaque de serviço fora do ar (painel de status Uptime Kuma)

## Overview
Painel de parede (TV) que mostra o status dos monitores do Uptime Kuma. Quando um ou mais serviços caem, eles ganham um bloco de destaque no topo da tela, com o histórico recente, para que o time de suporte tome ação. A cada mudança de situação o destaque pisca por 15 segundos, e o card do monitor que mudou pisca individualmente com o selo "mudou agora". A lista dos demais monitores (~50) pagina sozinha a cada 15 segundos.

## About the Design Files
Os arquivos deste pacote são **referências de design feitas em HTML** — protótipos que mostram aparência e comportamento pretendidos, não código de produção para copiar. A tarefa é **recriar estes designs no ambiente já existente do codebase** (o app Winker é Ionic 3 / Angular 5; a status page do Uptime Kuma é Vue 3), usando os padrões e bibliotecas estabelecidos. Se não houver ambiente definido para este painel, escolher o framework mais adequado e implementar lá.

Arquivos:
- **`painel-funcional.html`** + **`painel.js`** — implementação de referência executável, em JS puro (sem framework, sem build). Abra o HTML: o painel monta a partir dos dados, pagina sozinho, detecta mudança de situação e pulsa por 15 s. Os botões "Tudo normal / 1 queda / 5 quedas" no canto inferior são de demonstração e devem ser removidos em produção. `painel.js` é onde vive toda a lógica descrita em "Interactions & Behavior" — leia `monitores()`, `detectarMudanca()`, `medir()` e `render()`. Substitua `MONITORES` e `heartbeats()` pelos dados reais do Uptime Kuma; o resto do arquivo não precisa mudar.
- `fonts.css` — Plus Jakarta Sans em base64 (pesos 400–800), importada por `winker-tokens-styles.css`.
- **`referencia-visual.html`** — abra este primeiro. Arquivo único e autocontido (fonte e tokens embutidos, nenhuma dependência externa): os três estados renderizados em quadros de 1920 × 1080 px, com as animações rodando. É a referência de aparência.
- `Status - Destaque de Incidente.dc.html` — o protótipo original, com a lógica de estado comentada (detecção de mudança, pulso de 15 s, paginação medida). **Não abre no navegador**: usa o runtime do Claude Design (`<x-dc>`, `<sc-if>`, `<sc-for>`) e referencia `support.js` e o bundle do design system, que não vêm no pacote. Leia como pseudocódigo, não execute.
- `winker-tokens-styles.css` — tokens e classes `.wk-*` do Winker Design System V2. Fonte da verdade para cores, raios, sombras e tipografia. Faz `@import "./fonts.css"`, que **não** está no pacote — use os valores de token diretamente, ou extraia a fonte de `referencia-visual.html` (o `@font-face` base64 está embutido lá).

Duas rotas de implementação possíveis:
1. **Status page do Uptime Kuma** com CSS/JS customizado. Limite conhecido: o Uptime Kuma não reordena nem promove monitores por conta própria — a promoção do monitor caído para o topo, a paginação e o pulso precisam de JS injetado na página, lendo o DOM/socket do Kuma.
2. **Painel próprio** consumindo a API/socket do Uptime Kuma e renderizando esta tela. Rota recomendada: todo o comportamento abaixo depende de estado derivado (quem caiu, quem acabou de mudar, quantas linhas cabem), o que é frágil de fazer por cima do DOM do Kuma.

## Fidelity
**Hi-fi.** Cores, tipografia, espaçamentos e tamanhos são finais e devem ser reproduzidos fielmente, usando os tokens do Winker DS (`var(--*)`) em vez de hex literais para cor de marca. As dimensões abaixo pressupõem canvas fixo de **1920 × 1080 px**, sem scroll.

## Screens / Views

Uma única tela, com três estados. O estado é derivado dos dados (quantos monitores estão fora do ar); no protótipo há um botão de simulação no cabeçalho que cicla os três — **esse botão é ferramenta de demonstração e não deve existir em produção**.

### Estado A — Normal (nenhum monitor fora)
### Estado B — Uma queda
### Estado C — Várias quedas (exemplo com 5)

**Raiz (todos os estados)**
- `width: 1920px; height: 1080px; overflow: hidden; box-sizing: border-box`
- `padding: 40px 64px`; `display:flex; flex-direction:column; gap:28px`
- `background: var(--canvas)` (#f4f5f7), `color: var(--text-strong)` (#3d3d3d), `font-family: var(--font)` (Plus Jakarta Sans)

**1. Cabeçalho** (todos os estados) — `flex` com `justify-content:space-between; align-items:flex-end; gap:40px`
- Eyebrow: "Winker · Monitoramento" — 22px / 700 / `letter-spacing:.14em` / uppercase / `var(--color-primary)`
- Título: "Status dos serviços" — 64px / 800 / `letter-spacing:-.02em` / `line-height:1`
- À direita, coluna alinhada à direita, `gap:4px`, 24px / `var(--text-secondary)`:
  - "Atualizado 18:38:20"
  - "Próxima leitura em 00:MM" (contador regressivo de 60s, decresce 1/s)
- Botão de simulação (`.wk-btn .wk-btn--outline`, `min-height:56px`, 20px) — **remover em produção**.

**2. Bloco de destaque** (estados B e C) — `flex:0 0 auto` (não pode ser comprimido pela lista)
- `border: 3px solid var(--color-danger)`; `border-radius: var(--r-card)` (16px); `box-shadow: var(--shadow-alert)`; `overflow:hidden`
- Faixa superior: `background: var(--color-danger)` (#f53d3d), texto #fff, `padding:22px 36px`, `display:flex; align-items:center; gap:20px`
  - Ponto pulsante: 22×22px, `border-radius:99px`, #fff, animação `pulseDot` 1.1s ease-in-out infinite (`opacity 1→.3`, `scale 1→.8`)
  - Título: "Serviço fora do ar" / "Serviços fora do ar" (plural quando > 1) — 34px / 800 / `letter-spacing:.06em` / uppercase
  - À direita (`margin-left:auto`): "N de 50 monitores" — 30px / 700

- **Corpo, variante B (exatamente 1 fora):** card grande, `background: var(--surface)`, `padding:28px 36px`, `display:flex; flex-direction:column; gap:20px`, `border-top:1px solid var(--divider)`
  - Linha: nome do monitor — `h2` 48px / 800 / `letter-spacing:-.02em` / `line-height:1.05`; ao lado, pílula `padding:12px 22px`, `border-radius: var(--r-badge)`, `background: rgba(245,61,61,.1)`, com ponto 14px `var(--color-danger)` + texto do erro 28px / 800 `var(--color-danger)` (ex.: "HTTP 000 · timeout 30s"). Gap entre os dois: 40px.
  - Bloco de histórico: rótulo "Histórico · últimos 60 minutos" — 20px / 700 / `letter-spacing:.08em` / uppercase / `var(--text-secondary)`; barras: `display:flex; gap:6px; align-items:flex-end`, cada barra `width:24px; height:52px; border-radius:4px`; rodapé com "35m" à esquerda e "agora" à direita, 20px `var(--text-secondary)`.

- **Corpo, variante C (2 ou mais fora):** grade de cards compactos
  - Container: `background: var(--surface)`, `padding:16px`, `display:grid; grid-template-columns:repeat(3, 1fr); gap:12px`, `border-top:1px solid var(--divider)`
  - Card: `background: rgba(245,61,61,.06)`, `border:2px solid rgba(245,61,61,.35)`, `border-radius: var(--r-card)`, `padding:14px 18px`, `display:flex; flex-direction:column; gap:10px`
    - Linha do topo (`display:flex; gap:12px; align-items:flex-start`): nome — `h3` 30px / 800 / `line-height:1.15`, `flex:1 1 auto`; selo condicional "mudou agora" — `.wk-badge`, `background: var(--color-danger)`, #fff, 16px, `letter-spacing:.06em`, `white-space:nowrap; flex:0 0 auto`
    - Erro: 22px / 700 / `var(--color-danger)`
    - Histórico: `margin-top:auto`, `display:flex; gap:3px; align-items:flex-end`, barras `width:8px; height:34px; border-radius:2px`

**3. Card "tudo normal"** (estado A) — `flex:0 0 auto`, `background: var(--surface)`, `border:1px solid var(--divider)`, `border-radius: var(--r-card)`, `box-shadow: var(--shadow-card)`, `padding:40px 36px`, `display:flex; align-items:center; gap:22px`; ponto 22px `var(--color-success)` + texto "Todos os serviços operando normalmente" 44px / 800.

**4. Lista de monitores** (todos os estados) — wrapper `flex:1 1 auto; min-height:0; display:flex; flex-direction:column; gap:12px`
- Cabeçalho da seção: "Serviços" — 34px / 800; ao lado, resumo 24px `var(--text-secondary)`:
  - com incidente: "Demais monitores · 45 de 50 · página 2/3"
  - sem incidente: "50 monitores · todos normais · página 1/3"
- Grade: `flex:1 1 auto; min-height:0; overflow:hidden`, `display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); column-gap:1px; align-content:start`, `background: var(--divider)` (produz as linhas divisórias), `border:1px solid var(--divider)`, `border-radius: var(--r-card)`, `box-shadow: var(--shadow-card)`
  - **`minmax(0,1fr)` é obrigatório** — com `1fr` as linhas estouram a largura do container.
- Linha: `display:flex; align-items:center; gap:20px; padding:14px 28px; border-top:1px solid var(--divider)`; fundo `var(--surface)`, ou `rgba(245,61,61,.07)` se fora do ar, ou `rgba(255,165,0,.1)` se degradado
  - Marcador vertical: `width:8px; align-self:stretch; border-radius:99px`, cor conforme status
  - Nome: 24px / 700, `flex:1 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`
  - Status: `width:130px; flex:0 0 auto`, 20px / 700, cor conforme status ("Normal" / "Degradado" / "Fora do ar")
  - Histórico curto: `display:flex; gap:2px`, **últimas 22 batidas**, barras `width:6px; height:26px; border-radius:2px` (o histórico completo aparece só no destaque; 45 barras estouram a coluna)

## Interactions & Behavior

- **Promoção do afetado:** monitores fora do ar aparecem **apenas** no bloco de destaque; a lista de baixo mostra somente os não afetados. Sem incidente, a lista mostra todos.
- **Formato do destaque por quantidade:** 1 fora → card grande; 2+ → grade de 3 colunas com cards compactos.
- **Pulso de 15s a cada mudança de situação:** compare o conjunto de ids fora do ar com o anterior; se mudou, ativa o pulso e agenda desligamento em 15000ms (limpando o timer anterior).
  - Bloco de destaque: `alertaPisca 1s ease-in-out infinite` — `box-shadow: var(--shadow-alert), 0 0 0 0 rgba(245,61,61,.55)` → `0 0 0 18px rgba(245,61,61,0)`; `border-color: var(--color-danger)` → `rgba(245,61,61,.35)`
  - Card "tudo normal": `okPisca 1s ease-in-out infinite` — `0 0 0 0 rgba(34,197,94,.5)` → `0 0 0 16px rgba(34,197,94,0)`
  - Card individual que **acabou de** mudar: `cardPisca .9s ease-in-out infinite` — `background rgba(245,61,61,.16)` → `rgba(245,61,61,.04)`; `border-color var(--color-danger)` → `rgba(245,61,61,.3)`; `box-shadow 0 0 0 0 rgba(245,61,61,.5)` → `0 0 0 12px rgba(245,61,61,0)`; mais o selo "mudou agora". Os que já estavam fora ficam estáticos.
- **Paginação automática da lista:** troca de página a cada 15000ms. O número de itens por página é **medido**, não constante: `linhas = floor(grid.clientHeight / alturaDaPrimeiraLinha)` e `porPagina = max(2, linhas * 2)`. Medir com o primeiro **elemento** filho (`firstElementChild` — `firstChild` pode ser nó de texto) após mount (`requestAnimationFrame`) e a cada update, com guarda `linhas !== estadoAtual` para não entrar em loop.
- **Última página cheia:** `inicio = min(pagina * porPagina, max(0, total - porPagina))` — a última página retrocede para preencher a tela em vez de mostrar só o resto.
- **Contador de refresh:** decresce 1/s de 60 a 0 e reinicia.
- Sem hover/click: é painel de parede, não interativo.

## State Management
- `foraDoAr: string[]` — ids dos monitores em down (derivado dos dados do Kuma).
- `idsAnteriores: string[]` — para detectar mudança de situação.
- `mudaram: string[]` — ids que entraram em down na última mudança; usado no pulso individual e no selo.
- `piscando: boolean` — true por 15s após qualquer mudança.
- `pagina: number` — incrementa a cada 15s; usado módulo o total de páginas.
- `linhas: number` — capacidade medida da grade.
- `segundos: number` — contador do próximo refresh.
- Timers: intervalo de 1s (contador), intervalo de 15s (paginação), timeout de 15s (pulso). Limpar todos no unmount.

Dados: consumir do Uptime Kuma (socket.io ou `/api/status-page/<slug>` + `/heartbeat`). Por monitor são necessários: id, nome, status atual (up/down/pending), último erro/código HTTP, e os heartbeats recentes (mínimo 45 pontos para o histórico do destaque).

## Design Tokens
Todos vêm de `winker-tokens-styles.css` (`:root`). Usar `var(--*)`; **nunca** hardcode a cor de marca (é white-label, sobrescrita em runtime).

- Marca: `--color-primary` #b11655 · `--color-primary-contrast` #ffffff · `--color-primary-rgb` 177,22,85 · `--color-secondary` #f89c27
- Semânticas: `--color-success` forestgreen · `--color-warning` orange · `--color-danger` #f53d3d · `--color-info` #0288d1
- Neutras: `--text-strong` #3d3d3d · `--text-secondary` #656565 · `--surface` #ffffff · `--surface-alert` #f6f6f6 · `--border` #dcdcdc · `--divider` #eef0f3 · `--canvas` #f4f5f7
- Raios: `--r-btn` 12px · `--r-outline` 4px · `--r-card` 16px · `--r-alert` 20px · `--r-badge` 99px · `--r-sheet` 24px
- Sombras: `--shadow-card` 0 4px 12px rgba(0,0,0,.08) · `--shadow-alert` 0 20px 25px -5px rgba(0,0,0,.1), 0 8px 10px -6px rgba(0,0,0,.1)
- Tipografia: `--font` 'Plus Jakarta Sans', system fallbacks. **Plus Jakarta Sans não existe no Uptime Kuma** (a status page usa a stack do sistema) nem em `app.scss` fora do bloco `.new-layout`: a fonte precisa ser servida/embutida junto com o painel. Os `@font-face` em base64 (pesos 400–800) estão dentro de `referencia-visual.html`, prontos para copiar; sem eles o layout muda de métrica e os tamanhos abaixo não fecham. Escala usada: 64 / 48 / 44 / 34 / 30 / 28 / 24 / 22 / 20 / 19 / 17 px; pesos 600, 700, 800.
- Cores das barras de histórico: up → `var(--color-success)`; pending/lento → `var(--color-warning)`; down → `var(--color-danger)`; sem dado → #e6e8eb
- Classes do DS usadas: `.wk-btn`, `.wk-btn--outline`, `.wk-badge`, `.t-btn-outline`, `.t-badge`

## Assets
Nenhuma imagem ou ícone externo. O único ícone é o ponto pulsante (div circular). A fonte Plus Jakarta Sans vem embutida em `fonts.css` do design system (importada por `styles.css`).

## Files
- `painel-funcional.html` / `painel.js` — implementação de referência executável em JS puro.
- `fonts.css` — fonte embutida em base64.
- `Status - Destaque de Incidente.dc.html` — protótipo completo, com template e a lógica de estado/pulso/paginação comentada.
- `winker-tokens-styles.css` — tokens `:root` + classes `.wk-*`.
- No repo do app, a fonte canônica do estilo V2 é `winker-components/src/app/app.scss`, bloco `.new-layout`.

## Dados de exemplo no protótipo
Grupo Situator com 10 monitores nomeados (JF - Arch Home, Guardian, STV - Canoas, API Winker - Produção, Notificações push, Portaria remota - Canoas, Emissão de boletos, App morador, Câmeras - Arch Home) mais 40 gerados no padrão "Produto - Cidade" para chegar a 50. Erros de exemplo: HTTP 000 · timeout 30s, HTTP 502 · bad gateway, HTTP 504 · gateway timeout, HTTP 500 · internal error, ECONNREFUSED, HTTP 429 · rate limit.
