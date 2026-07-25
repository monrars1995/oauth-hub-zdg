# NeuroHub Meta — by @goldneuron.io

Hub **standalone**, **multi-app** e **whitelabel** para conectar canais da **Meta** — WhatsApp Business (Cloud API / Embedded Signup), **Messenger** (Páginas) e **Instagram** (Instagram Login) — **receber + visualizar** as interações (webhooks) e **rotear (encaminhar)** esses webhooks, por app, para outros sistemas.

Não valida licença e não depende de nenhum backend externo. Guarda os apps, canais e interações localmente (arquivos JSON) e mostra tudo num painel. Ideal para demonstrar o fluxo OAuth + recebimento de webhooks (por exemplo, no vídeo de revisão do app na Meta) e para servir de hub de integração simples.

> Fork operacional mantido pela **[@goldneuron.io](https://goldneuron.io/)** com identidade NeurOS.

---

## Recursos

- **Multi-app** — cadastre vários apps Meta, cada um com credenciais, **URL de webhook própria** (`/webhook/app/<id>`), config IDs e destinos de encaminhamento próprios.
- **Conexão de canais via OAuth** (por app)
  - WhatsApp — Embedded Signup (FB SDK + `config_id`), troca de código no servidor, `subscribed_apps`.
  - Messenger — Facebook Login for Business (`config_id`) ou diálogo clássico; lista e assina Páginas.
  - Instagram — Instagram Login, token de longa duração e assinatura da conta.
- **Webhooks por app** — verificação por Verify Token do app e recebimento; tudo aparece no feed “Interações”.
- **Roteamento / encaminhamento** — cada app pode repassar seus webhooks para uma ou mais URLs (“outros pontos”), com filtro por produto. Cada entrega leva o corpo original, `X-Hub-App`, timestamp anti-replay e `X-NeuroHub-Signature-256`, assinada com um segredo dedicado por destino.
- **Modo histórico × transacional** — por app, escolha **salvar histórico** no painel ou apenas **encaminhar** (ponta a ponta) sem guardar nada.
- **Botões de embed** — gere um botão de conexão para colar **fora do painel** (em qualquer site), por app/canal.
- **Segurança** — App Secret só no servidor e nunca é compartilhado com parceiros; secrets/tokens/URLs de forwarding são criptografados em disco com AES-256-GCM; tokens de canal nunca vão ao navegador; webhooks são rejeitados sem `X-Hub-Signature-256` válida; encaminhamentos usam segredo dedicado, timestamp e HMAC próprio; sessão administrativa em cookie HttpOnly; produção exige senha, segredo de sessão, chave de dados e HTTPS; encaminhamentos bloqueiam redes privadas, redirects e DNS rebinding com o IP validado fixado no socket.
- **Painel operacional** — **visão geral** (KPIs + gráfico de atividade da última hora + mix de canais), **console ao vivo** das interações (filtros, busca, payload com realce de sintaxe, som opcional), **canais como health cards** (status do webhook + sparkline), **command palette** (`Ctrl`/`⌘`+`K`), **tema claro/escuro**, layout **responsivo (mobile)** e **i18n** (pt / en / es).

---

## Requisitos & instalação

- Node.js 18+ (usa `fetch` e `crypto` nativos).

```bash
# fork @goldneuron.io:
git clone https://github.com/monrars1995/oauth-hub-zdg.git && cd oauth-hub-zdg

npm install
cp .env.example .env   # opcional — dá para configurar tudo pelo painel
npm run build
npm start              # dev: npm run dev
```

Abra `http://localhost:3300`.

### Subir com Docker

Há `Dockerfile`, `.dockerignore` e `docker-compose.yml` prontos. A imagem é multi-stage (compila o TypeScript e mantém só as dependências de produção), roda como usuário não-root e expõe `GET /health` como healthcheck. Os dados (`data/`) persistem num volume e os segredos vêm do `.env` — **nenhuma credencial é embutida na imagem**.

```bash
cd oauth-hub-zdg
cp .env.example .env          # preencha PUBLIC_URL, SESSION_SECRET, DATA_ENCRYPTION_KEY, ADMIN_PASSWORD…
docker compose up -d --build
```

- A porta **interna** do container é fixa em `3300`; escolha a do host com `HOST_PORT` (padrão `3300`): `HOST_PORT=8080 docker compose up -d`.
- Logs: `docker compose logs -f` · atualizar: `docker compose up -d --build` · parar: `docker compose down` (os dados ficam no volume `goldneuron-meta-apphub-data`).

Sem Compose (build/run direto):

```bash
docker build -t goldneuron-meta-apphub .
docker run -d --name goldneuron-meta-apphub \
  --env-file .env -e PORT=3300 \
  -p 3300:3300 \
  -v goldneuron-meta-apphub-data:/app/data \
  goldneuron-meta-apphub
```

---

## Configuração

Gerencie os **apps** pela aba **Apps** do painel (cada app tem suas credenciais e webhook). As variáveis `.env` são opcionais:

| Variável | Função |
|----------|--------|
| `PORT` | Porta HTTP (padrão 3300) |
| `PUBLIC_URL` | URL pública do hub, sem barra final (usada em redirect_uri e nas URLs de webhook) |
| `ADMIN_PASSWORD` | Senha do painel. Vazio = painel **sem** autenticação (apenas dev) |
| `SESSION_SECRET` | Segredo HMAC do state OAuth e dos cookies de sessão. Obrigatório em produção |
| `DATA_ENCRYPTION_KEY` | Chave da criptografia AES-256-GCM dos secrets/tokens armazenados. Obrigatória em produção; ao promover um volume dev, use o conteúdo de `data/.data-encryption-key` |
| `ADMIN_PASSWORD_FILE` | Arquivo Docker/Kubernetes Secret alternativo a `ADMIN_PASSWORD` |
| `SESSION_SECRET_FILE` | Arquivo Docker/Kubernetes Secret alternativo a `SESSION_SECRET` |
| `DATA_ENCRYPTION_KEY_FILE` | Arquivo Docker/Kubernetes Secret alternativo a `DATA_ENCRYPTION_KEY` |
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

**Documentação pública para integrações**
- `GET /documentacao` (alias: `/docs`) — guia humano para parceiros.
- `GET /openapi.json` — contrato OpenAPI 3.1 do onboarding, health e webhook de forwarding.
- Verifique `X-NeuroHub-Signature-256` sobre `X-NeuroHub-Timestamp + "." + corpo bruto` usando somente o segredo dedicado do destino.

**Documentos legais públicos**
- `GET /politica-privacidade`
- `GET /termos-servico`
- `GET /lgpd`

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

Campos sensíveis são gravados como envelopes AES-256-GCM. Cada mutação usa arquivo
temporário + `rename`, só atualiza o cache após confirmação do disco e retorna erro HTTP
se a persistência falhar. Exclusões em cascata preparam os três arquivos e restauram as
versões anteriores quando um write/rename falha durante a operação. Ainda assim, mantenha
o volume persistente e backups regulares para proteção contra falha física ou perda do host.

---

## Licença

Licenciado sob a **[GNU Affero General Public License v3.0](./LICENSE)**.

Por ser um serviço de rede, a AGPL (§13) exige que os usuários que interagem com o
hub remotamente possam obter o **código-fonte correspondente** da versão em execução.
O painel oferece o link **"Repositório público"** em **Configuração → Sobre**, apontando
para o código da versão publicada (`SOURCE_URL`, padrão
<https://github.com/monrars1995/oauth-hub-zdg>). Se você modificar e publicar uma
instância, mantenha esse acesso disponível e atualizado para a sua versão.

---

Fork mantido por **[@goldneuron.io](https://goldneuron.io/)**. Baseado no projeto
original [`pedroherpeto/oauth-hub-zdg`](https://github.com/pedroherpeto/oauth-hub-zdg),
com os avisos de copyright preservados em `LICENSE`, `NOTICE.md` e nos cabeçalhos do código.
