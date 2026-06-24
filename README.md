# Hub Meta Apps — oauth-hub

Hub **standalone**, **multi-app** e **whitelabel** para conectar canais da **Meta** — WhatsApp Business (Cloud API / Embedded Signup), **Messenger** (Páginas) e **Instagram** (Instagram Login) — **receber + visualizar** as interações (webhooks) e **rotear (encaminhar)** esses webhooks, por app, para outros sistemas.

Não valida licença e não depende de nenhum backend externo. Guarda os apps, canais e interações localmente (arquivos JSON) e mostra tudo num painel. Ideal para demonstrar o fluxo OAuth + recebimento de webhooks (por exemplo, no vídeo de revisão do app na Meta) e para servir de hub de integração simples.

> Projeto gratuito da **Comunidade ZDG** · conheça o **[Z-PRO — Multiatendimento](https://zpro.zdg.com.br/)**.

---

## Recursos

- **Multi-app** — cadastre vários apps Meta, cada um com credenciais, **URL de webhook própria** (`/webhook/app/<id>`), config IDs e destinos de encaminhamento próprios.
- **Conexão de canais via OAuth** (por app)
  - WhatsApp — Embedded Signup (FB SDK + `config_id`), troca de código no servidor, `subscribed_apps`.
  - Messenger — Facebook Login for Business (`config_id`) ou diálogo clássico; lista e assina Páginas.
  - Instagram — Instagram Login, token de longa duração e assinatura da conta.
- **Webhooks por app** — verificação por Verify Token do app e recebimento; tudo aparece no feed “Interações”.
- **Roteamento / encaminhamento** — cada app pode repassar seus webhooks para uma ou mais URLs (“outros pontos”), com filtro por produto. POST com o corpo original + cabeçalho `X-Hub-App` (e `X-Hub-Signature-256`, quando houver).
- **Modo histórico × transacional** — por app, escolha **salvar histórico** no painel ou apenas **encaminhar** (ponta a ponta) sem guardar nada.
- **Botões de embed** — gere um botão de conexão para colar **fora do painel** (em qualquer site), por app/canal.
- **Segurança** — App Secret só no servidor; tokens de canal nunca vão ao navegador; webhooks verificados por `X-Hub-Signature-256`; painel protegido por senha (opcional).

---

## Requisitos & instalação

- Node.js 18+ (usa `fetch` e `crypto` nativos).

```bash
cd extra/oauth-hub
npm install
cp .env.example .env   # opcional — dá para configurar tudo pelo painel
npm run build
npm start              # dev: npm run dev
```

Abra `http://localhost:3300`.

### Subir com Docker

Há `Dockerfile`, `.dockerignore` e `docker-compose.yml` prontos. A imagem é multi-stage (compila o TypeScript e mantém só as dependências de produção), roda como usuário não-root e expõe `GET /health` como healthcheck. Os dados (`data/`) persistem num volume e os segredos vêm do `.env` — **nenhuma credencial é embutida na imagem**.

```bash
cd extra/oauth-hub
cp .env.example .env          # preencha PUBLIC_URL, SESSION_SECRET, ADMIN_PASSWORD…
docker compose up -d --build
```

- A porta **interna** do container é fixa em `3300`; escolha a do host com `HOST_PORT` (padrão `3300`): `HOST_PORT=8080 docker compose up -d`.
- Logs: `docker compose logs -f` · atualizar: `docker compose up -d --build` · parar: `docker compose down` (os dados ficam no volume `oauth-hub-data`).

Sem Compose (build/run direto):

```bash
docker build -t oauth-hub .
docker run -d --name oauth-hub \
  --env-file .env -e PORT=3300 \
  -p 3300:3300 \
  -v oauth-hub-data:/app/data \
  oauth-hub
```

---

## Configuração

Gerencie os **apps** pela aba **Apps** do painel (cada app tem suas credenciais e webhook). As variáveis `.env` são opcionais:

| Variável | Função |
|----------|--------|
| `PORT` | Porta HTTP (padrão 3300) |
| `PUBLIC_URL` | URL pública do hub, sem barra final (usada em redirect_uri e nas URLs de webhook) |
| `ADMIN_PASSWORD` | Senha do painel. Vazio = painel **sem** autenticação (apenas dev) |
| `SESSION_SECRET` | Segredo HMAC (state OAuth + sessão + assinatura). Defina em produção |
| `BRAND_NAME` | Nome de marca do painel |
| `META_API_VERSION` | Versão padrão da Graph API ao criar apps |
| `FORWARD_TIMEOUT_MS` | Timeout do encaminhamento (padrão 10000) |
| `META_APP_*`, `INSTAGRAM_APP_*`, `WEBHOOK_VERIFY_TOKEN` | **Seed opcional** de um app no primeiro boot (só se `META_APP_ID` estiver setado e não houver apps) |

---

## No App Dashboard da Meta (por app)

No card de cada app o painel mostra as URLs prontas para copiar:

- **Webhook (callback URL):** `https://SEU_DOMINIO/webhook/app/<idDoApp>` (com o **Verify Token** do app). Há aliases por produto `.../waba`, `.../messenger`, `.../instagram`.
- **Instagram → Redirect URI:** `https://SEU_DOMINIO/connect/instagram/callback`.
- Configure os produtos do app: WhatsApp (Embedded Signup `config_id`), Facebook Login for Business (`config_id`) e Instagram (Instagram Login), e adicione o domínio do hub aos domínios permitidos.

Coloque o serviço atrás de **HTTPS** — a Meta exige HTTPS para OAuth e webhooks.

---

## Endpoints (visão geral)

**Painel / admin** (exigem sessão quando há `ADMIN_PASSWORD`)
- `GET /api/bootstrap` · `POST /api/login`
- `GET /api/config` · `POST /api/settings` (marca)
- `GET/POST /api/apps` · `PUT/DELETE /api/apps/:id`
- `GET /api/channels` · `DELETE /api/channels/:id`
- `GET /api/events?since=ISO` · `POST /api/events/clear`
- `POST /api/connect/:channel/init` (body `{ appId }`)

**Conexão**
- `GET /connect/waba|messenger|instagram` · `GET /connect/instagram/callback`
- `POST /api/connect/waba|messenger/exchange` (protegidos pelo `state` assinado)

**Embed (público, sem auth — gated por `embedEnabled` do app)**
- `GET /embed/connect?app=<id>&channel=<waba|messenger|instagram>` → abre a conexão daquele app.

**Webhooks (a Meta chama)**
- `GET|POST /webhook/app/:appKey` (+ `/:product`) — por app (recomendado)
- `GET|POST /webhook` (+ `/:product`) — genérico (resolve por canal quando possível)

**Saúde:** `GET /health`.

---

## Dados persistentes (`data/`, ignorado pelo git)

- `settings.json` — marca/preferências globais.
- `apps.json` — apps cadastrados (inclui App Secret — **proteja o disco**).
- `channels.json` — canais conectados (inclui tokens).
- `events.json` — últimas interações (ring de `WEBHOOK_EVENTS_MAX`).

---

Projeto de código aberto oferecido pela **[Comunidade ZDG](https://www.youtube.com/channel/UCrPbAoQKz42Gm0mLdWatAEA)**. Conheça o **[Z-PRO](https://zpro.zdg.com.br/)**.
