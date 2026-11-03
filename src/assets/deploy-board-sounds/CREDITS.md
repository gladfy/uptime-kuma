# Sons do painel de deploys

Gravações reais do [Freesound](https://freesound.org), escolhidas de ouvido pelo Erik em 02/11/2026.
Cada arquivo é um trecho da prévia em MP3 do som original, com entrada e saída suavizadas, volume
igualado em -16 LUFS (pico de no máximo -1,5 dBTP), mono, 44,1 kHz e 96 kbit/s, feito com `ffmpeg`.

| Arquivo | Evento | Origem | Autor | Licença | Trecho |
|---|---|---|---|---|---|
| `started.mp3` | Deploy iniciado: um toque longo | [ship horn very close](https://freesound.org/s/420716/) | tierrafilm | CC0 1.0 | 0,10 s a 1,60 s, saída de 0,45 s |
| `rolling.mp3` | Deploy em andamento: dois toques curtos | mesma buzina | tierrafilm | CC0 1.0 | 0,10 s a 0,60 s, duas vezes, a segunda em 0,75 s |
| `failed.mp3` | Deploy falhou: buzina grave e cinco toques curtos (sinal de perigo do RIPEAM) | mesma buzina | tierrafilm | CC0 1.0 | 0,10 s a 1,20 s a 80% da velocidade (mais grave), depois cinco toques de 0,28 s a cada 0,40 s a partir de 1,50 s |
| `built.mp3` | Build concluído | [steam train horn 02](https://freesound.org/people/eliasheuninck/sounds/170848/) | eliasheuninck | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 0,72 s a 2,72 s, saída de 0,6 s |
| `done.mp3` | Deploy concluído: sino de bordo, dois toques | [Ship Bell Two Chimes](https://freesound.org/s/353232/) | Sojan | CC0 1.0 | 0,55 s a 2,90 s, saída de 0,6 s |
| `service-down.mp3` | Serviço fora do ar: sirene de dois tons dos bombeiros alemães | [German fire engine](https://freesound.org/s/465700/) | Breviceps | CC0 1.0 | 0,00 s a 3,50 s, saída de 0,5 s; volume igualado aos outros (-16,4 LUFS medido pelo `loudnorm`), pico -3,8 dBTP. Escolhida pelo Erik em 03/11/2026 entre três sirenes |

O `built.mp3` é CC BY 4.0: o crédito ao autor também aparece no painel, no texto de ajuda do botão
de som (`deployBoardSoundCredits`). Quem trocar esse arquivo troca o crédito junto.
