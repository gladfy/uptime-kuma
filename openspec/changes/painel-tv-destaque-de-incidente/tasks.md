## 1. Saneador da mensagem de erro (backend, isolado e testável primeiro)

- [x] 1.1 Criar `server/util/sanitize-heartbeat-message.js` com a allowlist da decisão 3 do design: reconhece o padrão e **renderiza** o rótulo; o que não casar devolve o genérico `Sem resposta`. Nenhum caminho repassa a entrada.
- [x] 1.2 Incluir o mapa local de código HTTP → texto canônico (só os códigos que os monitores produzem). Não usar o `statusText` da resposta remota — é texto controlado por terceiro.
- [x] 1.3 Escrever `test/backend-test/test-sanitize-heartbeat-message.js` caso a caso: os padrões da tabela, o grupo (`Child monitors down: …` não pode conter nome de filho), a manutenção, mensagem vazia/ausente e as que devem cair no default deny.
- [x] 1.4 Acrescentar ao mesmo teste a asserção de conjunto fechado: qualquer entrada produz um dos rótulos declarados, e uma entrada com host/IP/porta/credencial não deixa nenhum trecho na saída.

## 2. Endpoint do painel

- [x] 2.1 Acrescentar `GET /api/status-page/:slug/tv` **no fim** de `server/routers/status-page-router.js` (aditivo, para não conflitar no merge), com `cache("1 minutes")` — alinhado ao refresh de 60 s.
- [x] 2.2 Montar o payload único: lista de monitores (id, nome, tipo) + estado atual + heartbeats recentes (`status`, `time`) + rótulo saneado, tudo na mesma resposta e sob o mesmo cache. Reusar a consulta de `monitor_group` e a expansão `show_children` do `/heartbeat/:slug` como referência.
- [x] 2.3 Omitir o rótulo para monitor em `UP` (não publicar o `200 - OK` do heartbeat de sucesso).
- [x] 2.4 Recusar com 404 quando `status_page.published = 0` e quando o slug não existe — as duas respostas indistinguíveis. Não alterar o `/heartbeat/:slug` existente.
- [x] 2.5 Aplicar a regra do grupo: monitor tipo `group` com `show_children` ligado sai do payload (os filhos o representam); grupo sem expansão permanece.
- [x] 2.6 Escrever `test/backend-test/test-status-page-tv-endpoint.js`: payload completo, rótulo ausente em `UP`, 404 do despublicado, dedupe do grupo expandido, e a asserção sobre o **corpo inteiro** normalizado provando que a mensagem original plantada não aparece em campo nenhum — com controle positivo no mesmo teste (a busca tem de achar o identificador quando ele está lá).

## 3. Página do painel (frontend)

- [x] 3.1 Criar `src/pages/StatusPageTv.vue` como página nova. Não importar nem alterar `StatusPage.vue`.
- [x] 3.2 Registrar a rota `/status/:slug/tv` em `src/router.js` — feita com import **lazy**, senão a fonte do painel (~250 KB) entra no CSS que toda página do app baixa (medido: bundle 322 KB → 583 KB). `src/mixins/socket.js` **não precisou de mudança**: o padrão `/^\/status/` que já existe em `noSocketIOPages` cobre a rota nova — um arquivo quente a menos no merge.
- [x] 3.3 Servir Plus Jakarta Sans com escopo na página, a partir dos `@font-face` base64 já prontos em `docs/design_handoff_status_destaque/fonts.css`. Sem CDN e sem alterar a tipografia do resto da aplicação.
- [x] 3.4 Montar a casca 1920 × 1080 com os tokens de `winker-tokens-styles.css` e o `transform: scale` que encaixa o quadro em qualquer janela (referência: `painel-funcional.html`).

## 4. Comportamento do painel

- [x] 4.1 Cabeçalho: eyebrow, título, horário da última leitura e contagem regressiva de 60 s. O ciclo de atualização e o cache do endpoint são o **mesmo** número — constante nomeada, num lugar só.
- [x] 4.2 Derivar o quadro: quem está em `DOWN` vai ao destaque e sai da lista; sem ninguém em `DOWN`, cartão de tudo normal e lista completa. `MAINTENANCE` fica na lista com cor própria e **não** conta como fora do ar; `PENDING` fica na lista como degradado.
- [x] 4.3 Destaque por quantidade: card grande com histórico completo para um só; grade de 3 colunas com cards compactos para dois ou mais.
- [x] 4.4 Teto de 9 cards no destaque com o excedente resumido ("e mais N fora do ar"). Conferir no render real com 50 monitores fora que nada é cortado e que a lista mantém pelo menos uma linha — os números do orçamento vertical do design são aproximados de propósito.
- [x] 4.5 Revisão (2026-08-25): acima do teto os cards saem e a lista assume com todos os monitores, caídos primeiro e com a causa na linha — o resumo "e mais N" escondia 23 de 32 quedas em produção. Verificado no render real com o payload de produção (48 monitores, 32 fora).
- [x] 4.5 Pulso de 15 s na mudança do conjunto de ids em `DOWN`, cancelando o temporizador anterior; selo "mudou agora" e pulso individual só em quem **entrou** nessa mudança. Recuperação total também pulsa (cartão de tudo normal).
- [x] 4.6 Paginação da lista a cada 15 s com capacidade **medida no DOM** (altura da grade ÷ altura da primeira linha real, via `firstElementChild` após `requestAnimationFrame`), com guarda para não entrar em laço de atualização. Última página retrocede para encher a tela.
- [x] 4.7 Rótulo da janela do histórico derivado do `time` dos heartbeats exibidos, nunca texto fixo. Posições sem dado aparecem vazias.
- [x] 4.8 Limpar todos os temporizadores no unmount (contador, paginação, pulso) e manter o último quadro conhecido quando uma atualização falhar, voltando a tentar no ciclo seguinte.
- [x] 4.9 Conferir que nenhum controle de demonstração sobreviveu (os botões "Tudo normal / 1 queda / 5 quedas" do `painel-funcional.html` são de bancada) e que não há hover, clique ou filtro.

## 5. i18n

- [x] 5.1 Extrair as strings de UI do painel para chaves novas em `src/lang/en.json` **e** `src/lang/pt-BR.json`, inseridas no MEIO do json, perto de chaves relacionadas de status page — nunca no fim.

## 6. Verificação

- [x] 6.1 Verificar no navegador os três estados com dado real (tudo normal, uma queda, várias quedas), o pulso, o selo e a virada de página — mudança de tela não fecha só com teste unitário.
- [x] 6.2 Verificar que `/status/<slug>` continua idêntica ao upstream e que `git diff upstream/master -- src/pages/StatusPage.vue` sai vazio.
- [x] 6.3 Rodar `npm run build`, `npm run test-backend`, `npm run lint` e `node extra/check-lang-json.js`. Sem migration nesta mudança, então `check-knex-filenames.mjs` não se aplica.

## 7. Defeitos achados na revisão (abertos)

Revisão em 24/08/2026 sobre a implementação dos grupos 1–6. Os sete são reais e confirmados por
leitura do código; três quebram o painel em produção. **Nenhum foi corrigido** — a entrega dos
grupos 1–6 subiu com eles.

Os três primeiros moram todos em `tvMonitorIDList` (`server/routers/status-page-router.js`), que é
o ponto fraco desta mudança: a consulta foi derivada do `/heartbeat/:slug`, que devolve um mapa por
id e por isso nunca precisou de ordem nem de filtro de `active`.

- [ ] 7.1 **Ordem da curadoria ignorada.** Não há `ORDER BY monitor_group.weight`, e o laço empilha os filhos de grupo ANTES dos monitores listados diretamente — então filhos sempre aparecem no topo. O painel é a única tela que depende dessa consulta para ordenar (a status page ordena no `/api/status-page/:slug`), então a ordem que o gestor configurou não chega ao telão.
- [ ] 7.2 **Grupo expandido sem nenhum filho ativo desaparece.** O grupo entra no set `expanded` e é removido; os filhos inativos não entram. Um grupo em `DOWN` some do painel inteiro — a falha exata que o painel existe para não ter.
- [ ] 7.3 **Monitor pausado fica no bloco vermelho para sempre.** A consulta dos filhos filtra `active = 1`, a dos listados diretamente não. Heartbeat `DOWN` antigo de um monitor pausado ocupa o destaque indefinidamente. Decidir o comportamento (esconder pausado, ou marcá-lo como pausado) e aplicar a MESMA regra nas duas consultas.
- [ ] 7.4 **O cliente engole o 404 e anula o gate de despublicação.** O `catch()` de `fetchData` existe para manter o último quadro quando a rede falha, mas não distingue falha de rede de 404: um telão já aberto continua exibindo nomes e rótulos depois de a status page ser despublicada. O requisito de RF "despublicar fecha essa porta" passa no backend e falha na tela.
- [ ] 7.5 **Pulso espúrio por comparar sequência em vez de conjunto.** `downIds.join(",")` é sensível à ordem; combinado com 7.1, o mesmo conjunto de quedas pode reserializar diferente e disparar 15 s de pulso no bloco inteiro com `changedIds` vazio — pisca sem nada ter mudado e sem selo. Ordenar os ids antes de serializar.
- [ ] 7.6 **`rowClass` sem ramo para `status: null`.** Monitor sem heartbeat nenhum ganha o acento verde de sucesso enquanto o texto ao lado diz "Sem dados".
- [ ] 7.7 **N+1 de consultas.** Uma `R.getRow` de monitor mais uma de heartbeats por monitor (~102 consultas para 50 monitores). O cache de 1 minuto não amortiza porque `apicache.clear()` dispara a cada heartbeat importante. Dá para resolver em duas consultas.

- [ ] 7.8 **Cobrir nos testes o que passou batido.** Os 9 testes de `test-status-page-tv-endpoint.js` passam COM os defeitos 7.1, 7.2 e 7.3 presentes: o cenário semeia só monitores ativos, nunca asserta ordem, e o grupo expandido sempre tem filho ativo. A cobertura tem o formato do que foi imaginado, não do contrato escrito no spec.

## 8. Ajuste de intensidade do destaque (25/08/2026)

- [x] 8.1 Pulso de 15 s para 30 s (`PULSE_MS`), com o spec e os quatro cenários atualizados junto.
- [x] 8.2 Onda contínua na faixa do destaque (três senóides, decisão 9 do design), presente enquanto houver queda e intensificada durante o pulso.
- [x] 8.3 Pulso mais forte: anel de 18 px para 32 px e sempre saturado (antes a borda desbotava no meio do ciclo), faixa batendo para um vermelho mais fundo, ponto branco com anel de farol, halo permanente no bloco.
- [x] 8.4 Verificado no navegador: a onda anda (transform muda entre dois instantes), o pulso disparado por mudança real ainda está ativo em t=29 s e apagado em t=33 s, e o conteúdo continua dentro do canvas em 940x530 e 1920x1080.
- [x] 8.5 O painel passa a usar o "Intervalo de atualização" da status page: o endpoint publica `status_page.auto_refresh_interval` e a leitura virou cadeia de `setTimeout`, relendo o valor a cada ciclo. Dois testes novos no `test-status-page-tv-endpoint.js` (valor configurado e fallback).
- [x] 8.6 **Separar os dois ritmos** (decisão 6, segunda revisão): a situação passa a ser relida a cada 30 s fixos e o intervalo configurado passa a recarregar a TELA INTEIRA (`location.reload()`, padrão 300 s, piso 120 s, adiado enquanto o pulso estiver ativo). Sem isso, uma página no default do app levaria cinco minutos para mostrar um serviço caído. Medido no navegador: com a config em 300 s a queda apareceu em **27 s** e não houve recarregamento; com 120 s a tela recarregou em 120 s; com 30 s (abaixo do piso) nenhum recarregamento em 75 s e as leituras seguiram de 30 em 30. Medido também que um reload pega versão nova: o HTML sai com ETag e sem `max-age`, e o asset tem hash no nome.
