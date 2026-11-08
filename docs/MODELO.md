# Modelo de dados

A configuração vive em `data/config.json`. O código está em `server/lib/model.js` (modelo, limites, operações)
e `server/lib/config.js` (gravação em disco). O player desenha em `public/player/player.js`.

## Estrutura

```json
{
  "version": 1,
  "rev": 42,
  "output": { "width": 1280, "height": 720 },
  "pinHash": "",
  "layers": [ { "...": "ver abaixo" } ]
}
```

| Campo | Descrição |
|---|---|
| `version` | Versão do formato (para migrações futuras). |
| `rev` | Sobe a cada alteração. Serve para os clientes saberem se estão atualizados. |
| `output` | Resolução de saída: só `1920×1080` ou `1280×720`. Outro valor volta a 1280×720 (por omissão no Pi 4). |
| `pinHash` | Hash scrypt com sal do PIN (4 a 8 dígitos). Vazio = sem PIN. **Nunca é enviado aos clientes**; estes recebem apenas `hasPin`. |
| `layers` | Lista **da de baixo para a de cima**: índice 0 = fundo, último = topo (é o z-index). Máximo 32. |

## Layer

| Campo | Padrão | Limites | Significado |
|---|---|---|---|
| `id` | gerado | `[\w-]{1,40}` | Identificador estável; nunca muda. |
| `name` | `Layer` | 80 car. | Nome no painel. |
| `visible` | `true` | | Escondida = fica em pausa. |
| `video` | `null` | nome de ficheiro | Ficheiro em `data/media/` (só o nome, sem caminhos). |
| `mask` | `null` | nome de ficheiro | PNG em `data/media/`. |
| `maskScale` | 1 | 0,01 a 20 | Escala da máscara dentro da caixa (1 = tamanho exato do PNG). |
| `maskMode` | `alpha` | `alpha`\|`luminance` | `alpha`: opaco = visível. `luminance`: branco = visível. |
| `videoScale` | 1 | 0,01 a 20 | Escala extra do vídeo, por cima do *cover* (1 = encher a caixa). |
| `videoOffsetX/Y` | 0 | ±5000 | Deslocamento do vídeo dentro da caixa (px da caixa). |
| `x`, `y` | centro do ecrã | ±10000 | Posição do **centro** da layer, em píxeis de saída. |
| `scale` | 1 | 0,01 a 20 | Escala da layer, em torno do seu centro. |
| `pins` | 4×`{0,0}` | ±3000 | Corner pin: deslocamento de cada canto, em píxeis de saída. Ordem: TL, TR, BR, BL. |

Valores fora dos limites são cortados; valores inválidos voltam ao padrão. Nomes de ficheiro com `/`, `\` ou
a começar por `.` são rejeitados (sem `../`).

## Ordem de aplicação das transformações

**A máscara define a caixa.** A caixa da layer tem o tamanho nativo do PNG da máscara (ex.: 800×600) e é ela
que fixa a posição global e a proporção da layer. Sem máscara, a caixa tem o tamanho nativo do vídeo. Assim,
trocar de vídeo (de qualquer resolução ou proporção) não mexe na máscara: só muda o conteúdo lá dentro.

Para cada layer, por esta ordem:

1. **Vídeo dentro da caixa (*cover*).** O vídeo é escalado até encher a caixa sem se deformar (o excesso é
   cortado), centrado. Por cima disso aplicam-se `videoScale` (em torno do centro) e `videoOffsetX/Y`.
2. **Máscara no espaço da layer.** A máscara tem o tamanho da caixa, escalada por `maskScale` (1 = exata) e
   centrada. Aplica-se à caixa já com o vídeo. Ainda não há posição nem corner pin: a máscara acompanha tudo
   o que vem a seguir.
3. **Posição e escala da layer.** A caixa é escalada por `scale` em torno do seu centro e colocada com o
   centro em `(x, y)`, no espaço da saída.
4. **Corner pin (afinação final).** Cada um dos 4 cantos da caixa, já posicionada, é deslocado por `pins[i]`.
   O resultado é uma transformação de perspetiva (homografia) da caixa para o quadrilátero final.

Os passos 3 e 4 resumem-se a uma única `matrix3d`. Como a máscara está no mesmo elemento que recebe a
`matrix3d`, ela é deformada pelo corner pin em conjunto com o vídeo. O código está em
`public/shared/geometry.js`, usado pelo player e pela pré-visualização do painel (para coincidirem).

## Operações

Todas as alterações passam por `applyOp` (função pura: devolve uma configuração nova e sobe o `rev`). Será
este o formato das mensagens do painel (Fase 3).

| `op` | Parâmetros | Efeito |
|---|---|---|
| `addLayer` | `layer?` | Acrescenta uma layer ao topo. |
| `removeLayer` | `id` | Remove. |
| `duplicateLayer` | `id` | Copia para logo acima do original, com id novo e deslocada 40 px. |
| `moveLayer` | `id`, `index` | Reordena (0 = fundo). |
| `updateLayer` | `id`, `patch` | Altera só os campos permitidos (nunca o `id`). |
| `setOutput` | `width`, `height` | Muda a resolução e escala `x`, `y`, `scale` e `pins` para manter a composição. |
| `setPin` | `pin` | 4 a 8 dígitos; `""` remove o PIN. |

Operações inválidas lançam `OpError` e não alteram nada.

## Persistência e segurança dos dados

- **Escrita atómica:** grava num ficheiro temporário no mesmo diretório, faz `fsync` e só depois `rename`.
  Se a corrente falhar a meio, `config.json` fica intacto.
- **Cópia anterior:** antes de cada substituição, a versão anterior fica em `config.json.bak`.
- **Recuperação no arranque:** temporários deixados por uma falha são apagados. Se `config.json` estiver
  corrompido, copia-o para `config.json.corrupt-<hora>` e usa o `.bak`. Se também falhar, arranca vazio.
- **Junção de escritas:** alterações seguidas (ex.: arrastar um slider) vão para a memória e para os
  clientes de imediato, mas só vão para o disco 250 ms depois da última. `flush()` grava logo ao terminar o servidor.
- **Edição à mão:** o servidor vigia o ficheiro e recarrega-o se mudar por fora. Se estiver inválido, ignora-o.

## Testes

`cd server && npm test` (25 testes: normalização, limites, operações, PIN, falhas de escrita, recuperação).
