> Versão completa em português. [English summary](../README.md)

# GVPI — media server de vídeo com máscaras para o Raspberry Pi 4

Um pequeno media server para um ecrã HDMI. Vários vídeos curtos, em loop e sem áudio, são compostos com
**máscaras PNG**, posição, escala e **corner pin** (perspetiva). Controlas tudo, em tempo real, por uma
webapp acessível na rede local (telemóvel ou computador).

- **Player:** uma página no Chromium em modo kiosk, em ecrã inteiro, que desenha as layers (DOM/CSS).
- **Painel:** a webapp servida pelo próprio Pi. Fala com o player por WebSocket.
- **Servidor:** Node.js (Express + ws). Converte os vídeos com ffmpeg e guarda a configuração num JSON.

Desenvolvido e testado no Raspberry Pi 5; adaptado ao Raspberry Pi 4 (Bookworm 64-bit, labwc/Wayland, Chromium 156, Node.js 18), ainda por validar com carga real.

## Como funciona

```
telemóvel / computador ──(WebSocket + HTTP)──▶ servidor Node (:8080) ──(WebSocket)──▶ player (Chromium kiosk) ──▶ HDMI
        painel                                       │
                                          data/config.json + data/media/
```

- **Vídeos:** H.264 descodificado em software (o Pi 4 tem descodificação H.264 por hardware, mas o Chromium não a usa aqui). Como os
  vídeos são pequenos (máx. 640×480 ou 800×600), o CPU chega bem.
- **A máscara define a layer:** o tamanho da máscara dá a caixa da layer e o vídeo encaixa lá dentro em
  *cover*. Trocar de vídeo não muda a máscara. Detalhes e ordem das transformações em
  [`MODELO.md`](MODELO.md).
- **Pré-visualização igual ao ecrã:** o player e o painel usam o mesmo ficheiro de geometria
  (`public/shared/geometry.js`).

## Instalação de raiz

Num Raspberry Pi 4 com Raspberry Pi OS Bookworm 64-bit (a versão com ambiente de trabalho) e ligado à rede:

```bash
# 1. Dependências do sistema
sudo apt update
sudo apt install -y nodejs npm ffmpeg chromium curl avahi-daemon

# 2. Código (copia esta pasta para o Pi, por exemplo para ~/RaspberryPI-VPT) e dependências Node
cd ~/RaspberryPI-VPT/server
npm install --omit=dev

# 3. Serviço do servidor (arranca com o Pi; pede sudo uma vez)
cd ~/RaspberryPI-VPT
deploy/install-service.sh

# 4. (opcional) Abrir o player no ecrã HDMI sempre que o Pi arranca
./kiosk on
```

Depois abre o painel num browser da mesma rede: `http://<IP-do-Pi>:8080` ou `http://<nome-do-Pi>.local:8080`.
O endereço, com um QR code, aparece também no ecrã HDMI quando não há layers (e nos primeiros 10 s).

> O nome `.local` depende do `avahi-daemon` (já vem no Raspberry Pi OS) e do nome da máquina
> (`hostname`). Em alguns Android pode não funcionar: usa o IP.

## Arrancar, parar e ver o estado

O servidor corre como serviço `systemd` chamado `video-server`:

```bash
sudo systemctl status video-server      # estado
sudo systemctl restart video-server     # reiniciar (depois de mudar o código)
sudo systemctl stop video-server        # parar
sudo systemctl start video-server       # arrancar
journalctl -u video-server -f           # registos em direto
deploy/install-service.sh remove        # desinstalar o serviço
```

O modo **kiosk** (o Pi abre direto no player em ecrã inteiro) liga-se e desliga-se com um comando:

```bash
./kiosk on       # a partir do próximo arranque
./kiosk off      # volta ao arranque normal, com o ambiente de trabalho
./kiosk status
```

`./kiosk on` só cria o ficheiro `~/.config/labwc/autostart` e `./kiosk off` apaga-o. Não toca em `/etc`.
Recusa mexer num `autostart` que não tenha criado ele. Para abrir o player **agora** sem esperar pelo
arranque: `deploy/kiosk-session.sh &`. Para o fechar: `pkill -x kiosk-session.s; pkill -x chromium` (o
script volta a abrir o Chromium se só fechares o Chromium).

Se estiveres em kiosk e precisares do ambiente de trabalho sem teclado, faz SSH e corre `./kiosk off`.

## Usar o painel

- **Layers:** `+ Layer` adiciona. ▲ ▼ reordenam (topo da lista = layer de cima), ⧉ duplica, ✕ apaga, ● mostra/esconde.
- **Propriedades:** vídeo, máscara (e modo), posição, escala e corner pin. Nos campos numéricos arrasta na
  horizontal para mudar o valor, toca/clica para escrever, e usa ↑↓ para afinar (Shift = 10×).
- **Pré-visualização:** arrasta as 4 pegas para o corner pin; arrasta a layer para a mover; toca numa layer
  para a selecionar. Mostra miniaturas, e não vídeo ao vivo.
- **Media:** envia vídeos e PNGs (galeria do telemóvel, ou arrastar e largar no computador). Os vídeos são
  convertidos um de cada vez; só aparecem nas layers quando terminam. Podes renomear e apagar, com aviso se
  o ficheiro estiver em uso.
- **Definições:** resolução de saída, tamanho máximo e fps da conversão, e PIN.
- **Debug:** mostra FPS do ecrã, frames perdidos, CPU, GPU e temperatura.

### Conversão de vídeos

Os vídeos enviados (qualquer formato: 1080p/4K, HEVC, HDR, vertical, com áudio, fps variável) são
convertidos com ffmpeg para H.264 yuv420p, no máximo 640×480 (ou 800×600), mantendo a proporção e sem
ampliar, fps constante (25 ou 30), sem áudio, `+faststart` e GOP curto sem B-frames (ajuda o loop).
O HDR passa para SDR. Os PNGs entram diretamente como máscaras.

**Sem conversão:** nas Definições podes desligar *Converter vídeos ao enviar* (por exemplo se já comprimiste e
redimensionaste no HandBrake). Os vídeos H.264, VP8, VP9 ou AV1 em `.mp4`, `.m4v`, `.mov` ou `.webm` entram tal
como estão, sem reencodar, o que é instantâneo e sem perdas. Outros formatos (HEVC, `.mkv`, `.avi`...) são
convertidos na mesma, porque o Chromium não os toca. Neste modo o tamanho e os fps das Definições não se aplicam:
usa vídeos já no tamanho e fps finais (o ideal é um fps constante, sem áudio é opcional).

As máscaras podem ser formas de qualquer cor sobre fundo **transparente** (modo *Alpha*, o normal), ou
imagens planas a preto e branco (modo *Luminância*: branco = visível).

### PIN

Por defeito **não há PIN**: qualquer pessoa na rede local controla o ecrã. Define um em Definições (4 a 8
dígitos). Com PIN, o painel pede-o, há bloqueio de 30 s após 5 tentativas erradas, e a sessão dura 30 dias.
O player, que corre no próprio Pi (localhost), não precisa de PIN. O PIN guarda-se como hash, nunca em texto.

## Onde estão os ficheiros

```
RaspberryPI-VPT/
├── kiosk                      interruptor do modo kiosk (on / off / status)
├── deploy/
│   ├── install-service.sh     instala/remove o serviço systemd
│   ├── video-server.service.in modelo do serviço
│   └── kiosk-session.sh       abre o Chromium em kiosk e reabre-o se falhar
├── server/                    servidor Node (index.js, lib/, test/)
├── public/
│   ├── player/                página do player (ecrã inteiro)
│   ├── panel/                 painel de controlo
│   └── shared/geometry.js     geometria comum ao player e à pré-visualização
├── docs/MODELO.md             modelo de dados e ordem das transformações
├── phase0/                    testes de desempenho (DOM vs WebGL); pode apagar-se
└── data/                      os TEUS dados (não vai para o git)
    ├── config.json            configuração (layers, resolução, hash do PIN)
    ├── config.json.bak        versão anterior, criada a cada gravação
    ├── media/                 vídeos convertidos e máscaras PNG
    ├── thumbs/                miniaturas dos vídeos (geradas sozinhas)
    ├── uploads/               envios à espera de conversão (temporário)
    └── .secret                chave das sessões (apagar = terminar todas as sessões)
```

Fora do projeto: o serviço está em `/etc/systemd/system/video-server.service`, o kiosk (se ligado) em
`~/.config/labwc/autostart`, e o perfil do Chromium do kiosk em `~/.config/video-player-chromium`.

Variáveis de ambiente do servidor: `PORT` (por omissão `8080`) e `DATA_DIR` (por omissão `./data`).

## Backup da configuração

A configuração são as layers e as definições. Os ficheiros de media são maiores.

```bash
cd ~/RaspberryPI-VPT
# só a configuração (pequena)
cp data/config.json ~/config-$(date +%F).json

# tudo o que é teu: configuração + media (sem miniaturas, que se refazem)
tar czf ~/gvpi-backup-$(date +%F).tar.gz data/config.json data/media
```

Repor: pára o serviço, copia os ficheiros de volta e volta a arrancá-lo.

```bash
sudo systemctl stop video-server
cp ~/config-2026-11-08.json data/config.json        # ou: tar xzf ~/gvpi-backup-....tar.gz
sudo systemctl start video-server
```

A gravação do `config.json` é atómica (ficheiro temporário + `rename`): se a corrente falhar a meio, o ficheiro
não fica corrompido. Se mesmo assim estiver inválido, o servidor usa `config.json.bak`, e guarda o estragado
como `config.json.corrupt-<hora>`. Podes também editar o `config.json` à mão com o serviço a correr: é recarregado sozinho.

## Problemas comuns

**O painel não abre noutro aparelho (o `ping` responde).**
- No **Mac**, o browser precisa da permissão *Definições do Sistema → Privacidade e Segurança → Rede Local*.
  Liga-a para o browser que usas (o `curl` funciona sem ela).
- Confirma que escreveste `http://` (não `https://`) e o `:8080`, e que o aparelho está na mesma rede
  (não numa rede de convidados) e sem VPN.

**O IP mudou.** O router pode atribuir outro IP. Usa `http://<nome-do-Pi>.local:8080` ou reserva o IP do Pi no router.

**O ecrã HDMI mostra o ambiente de trabalho e não o player.** O kiosk está desligado (`./kiosk status`). Liga-o com
`./kiosk on` e reinicia, ou corre `deploy/kiosk-session.sh &` para abrir já.

**O ecrã fica preto ou mostra "a ligar".** Vê se o serviço está ativo: `systemctl status video-server` e
`journalctl -u video-server -n 50`. O kiosk espera até 2 minutos pelo servidor.

**Esqueci-me do PIN.** Pára o serviço, abre `data/config.json`, deixa `"pinHash": ""` (vazio) e arranca outra vez:
`sudo systemctl stop video-server`, edita, `sudo systemctl start video-server`. Para terminar todas as sessões,
apaga `data/.secret`.

**A conversão de um vídeo falha.** O painel mostra o erro no ecrã Media. Causas habituais: ficheiro que não é
vídeo, formato que o ffmpeg não lê, ou falta de espaço (`df -h`). Um ficheiro por converter que fique em
`data/uploads/` volta à fila quando o serviço reinicia.

**A máscara aparece invertida ou o vídeo desaparece.** Experimenta o outro modo (*Alpha* / *Luminância*). Máscaras
com formas pretas sobre transparente só funcionam em *Alpha*.

**O vídeo "salta" ou há frames perdidos.** Liga o **Debug** no painel e vê o CPU, a GPU, a temperatura e os frames
perdidos nos últimos 10 s. Os perdidos nos primeiros segundos depois de abrir o player são normais. Se o
CPU ou a temperatura estiverem altos, usa menos layers ou vídeos mais pequenos.

**O loop mostra um pequeno soluço.** Há cerca de 1 frame parado por volta, por layer. É uma limitação conhecida do
Chromium ao reiniciar vídeos. O player já alterna dois elementos `<video>` por layer para o reduzir.

**Mudei a resolução para 1280×720 e a imagem não ficou nítida.** A resolução das Definições é a do player
(lógica). O modo do ecrã HDMI tem de ser mudado à parte, com
`wlr-randr --output HDMI-A-1 --mode 1280x720`. Sem isso, o player é escalado para o ecrã.

## Desenvolvimento

```bash
cd server
npm install        # com as dependências de desenvolvimento
npm test           # 25 testes: modelo, gravação, recuperação, PIN e geometria
node index.js      # arranca o servidor à mão (pára o serviço antes: usa a mesma porta)
```

Dependências Node (só três): `express`, `ws` e `qrcode`. O resto são módulos do próprio Node.

### Desempenho medido (Fase 0, num Pi 5 — ainda não medido no Pi 4)

No Pi 4 a resolução por omissão é 1280×720. Os valores abaixo são do Pi 5, a 1920×1080, com vídeos 640×480@30 (1 fundo em ecrã inteiro + vídeos à frente, todos com máscara):

| Layers | DOM/CSS (usado) | WebGL |
|---|---|---|
| 2 | CPU 10 %, GPU 25 % | CPU 15 %, GPU 30 % |
| 4 | CPU 16 %, GPU 30 % | — |
| 8 | CPU 26 %, GPU 33 % | CPU 36 % (picos 75 %), GPU 67 % (picos 95 %) |

Sem *throttling* em nenhum teste e com mais de 99,6 % dos frames apresentados. Por isso o player usa DOM/CSS.
Não foram medidos 12 layers nem 1280×720. Os scripts estão em `phase0/`.

## Ideias para mais tarde

Pi como hotspot Wi-Fi próprio, importação a partir de pen USB, e presets/cenas guardadas.
