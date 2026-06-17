# anything-to-chatwoot

A lightweight, self-hostable bridge that relays messages between messengers and a
[Chatwoot](https://www.chatwoot.com/) **API-channel** inbox — in both directions.

Telegram is the first supported messenger; the architecture is deliberately
pluggable so other channels (MAX, WhatsApp, VK, ...) can be added as adapters
without touching the core.

```
Customer  ->  Telegram Bot  ->  anything-to-chatwoot  ->  Chatwoot inbox  ->  Operator
Customer  <-  Telegram Bot  <-  anything-to-chatwoot  <-  Chatwoot inbox  <-  Operator
```

## Why this exists

Chatwoot has a native Telegram channel, but it validates the bot token by calling
the Telegram Bot API **from the Chatwoot server**. For self-hosted Chatwoot on
infrastructure where Telegram is blocked (for example, Russian networks where
Telegram is throttled/blocked by Roskomnadzor), that validation fails and the
inbox cannot be connected.

`anything-to-chatwoot` solves this by running as a tiny relay on a server that
*can* reach Telegram (e.g. in Europe). It talks to the Telegram Bot API on one
side and to your Chatwoot instance on the other, so your operators keep working
entirely inside Chatwoot.

## What it does

- Relays **text, media, files, voice messages and video notes ("кружочки")** both ways.
- Preserves **replies** (the quoted message is shown on both sides).
- Renders Chatwoot **interactive messages** (`input_select`, `cards`) as Telegram
inline keyboards; a tap is sent back into Chatwoot as the customer's reply.
- Optionally forwards Chatwoot **system/activity messages** (agent joined,
conversation resolved) — off by default, toggle with `FORWARD_SYSTEM_MESSAGES`.
- **Streams media** straight through; nothing is written to local disk.
- Best-effort delivery via an in-memory **retry queue** with exponential backoff.

### What it intentionally does NOT do

- Assign agents.
- Persist/download media into its own storage.
- Open, close, reopen, or change the status of conversations.
- Change operator/agent availability.

It is purely a message relay.

## Architecture

Hexagonal (ports & adapters) on top of NestJS. The application core depends only
on interfaces (ports); concrete messengers, the Chatwoot HTTP client, and storage
are pluggable implementations.

```
src/
  domain/        # UnifiedMessage model + ports (no I/O)
  application/   # InboundService, OutboundService, registry, outbox worker, mappers
  infra/         # ChatwootClient, TelegramAdapter, in-memory store
  interface/     # HTTP controllers (Chatwoot webhook, Telegram webhook, health)
  config/        # zod-validated configuration
```

State is **in-memory** in this version (no database). Chatwoot is the source of
truth: contacts and conversations are looked up / created via its API, and the
in-memory maps are just a cache plus the reply-threading index. The store sits
behind ports (`RepositoryPort`, `OutboxPort`), so a durable backend
(SQLite/Redis) can be added later without changing the core.

> Trade-off: on restart, in-flight retries and the reply-threading map are lost.
> New messages keep working and re-link via Chatwoot; only replies to messages
> sent before the restart will not show the quoted message.

## Prerequisites

1. A Telegram bot token from [@BotFather](https://t.me/BotFather).
2. A self-hosted Chatwoot instance reachable from where you deploy this service.
3. A Chatwoot **API channel** inbox and its numeric inbox id (see below).

### Create the Chatwoot API inbox

1. In Chatwoot: **Settings -> Inboxes -> Add Inbox -> API**.
2. Give it a name (e.g. "Telegram") and create it. Note the inbox id from the URL
  (`.../app/accounts/<account_id>/settings/inboxes/<inbox_id>`) — this is
   `CHATWOOT_TELEGRAM_INBOX_ID`.
3. Add an **agent/bot** to the inbox so messages can be sent.
4. Create a **webhook** so operator replies reach this service:
  **Settings -> Integrations -> Webhooks -> Add new webhook**
  - URL: `https://<your-bridge-host>/webhook`
  - Subscribe to the **Message created** event.

Get your access token from **Profile Settings -> Access Token** (or use an Agent
Bot token), and your numeric account id from the dashboard URL.

## Configuration

All configuration is via environment variables (validated at startup). Copy
`[.env.example](.env.example)` to `.env` and fill it in.


| Variable                    | Required     | Default       | Description                                        |
| --------------------------- | ------------ | ------------- | -------------------------------------------------- |
| `CHATWOOT_BASE_URL`         | yes          | —             | Chatwoot base URL, no trailing slash               |
| `CHATWOOT_API_ACCESS_TOKEN` | yes          | —             | Agent/Bot access token                             |
| `CHATWOOT_ACCOUNT_ID`       | yes          | —             | Numeric account id                                 |
| `CHATWOOT_WEBHOOK_SECRET`   | no           | *(empty)*     | HMAC secret to verify webhooks (disabled if empty) |
| `TELEGRAM_BOT_TOKEN`        | yes          | —             | Bot token from @BotFather                          |
| `CHATWOOT_TELEGRAM_INBOX_ID`| yes          | —             | Chatwoot API inbox id for this bot                 |
| `TELEGRAM_MODE`             | no           | `polling`     | `polling` or `webhook`                             |
| `TELEGRAM_WEBHOOK_DOMAIN`   | webhook only | —             | Public https URL of this service                   |
| `TELEGRAM_WEBHOOK_SECRET`   | no           | *(empty)*     | Secret token Telegram echoes back                  |
| `PORT`                      | no           | `3000`        | HTTP port                                          |
| `LOG_LEVEL`                 | no           | `log`         | `error`/`warn`/`log`/`debug`/`verbose`             |
| `NODE_ENV`                  | no           | `development` | `development`/`production`/`test`                  |
| `FORWARD_SYSTEM_MESSAGES`   | no           | `false`       | Forward Chatwoot activity messages                 |


## Running

### Docker (recommended)

```bash
cp .env.example .env   # then edit .env
docker build -t anything-to-chatwoot .
docker run --rm -p 3000:3000 --env-file .env anything-to-chatwoot
```

Or with Compose (optional convenience wrapper):

```bash
docker compose up -d
```

### Local (Node 20+)

```bash
npm install
npm run build
npm start
# or, for development with hot reload:
npm run start:dev
```

Check it is alive:

```bash
curl http://localhost:3000/health
```

## Telegram transport modes

- **Polling (default):** the bridge pulls updates from Telegram. No public URL is
required for Telegram (only Chatwoot needs to reach `/webhook`). Simplest to run.
- **Webhook:** set `TELEGRAM_MODE=webhook` and `TELEGRAM_WEBHOOK_DOMAIN` to this
service's public https URL. The bridge registers the webhook and serves it at
`/telegram/webhook`. Set `TELEGRAM_WEBHOOK_SECRET` to authenticate callbacks.

## Adding a new messenger

The core talks to messengers only through the `MessengerAdapter` port
(`[src/domain/ports.ts](src/domain/ports.ts)`). To add, say, WhatsApp:

1. Create `src/infra/whatsapp/whatsapp.adapter.ts` implementing `MessengerAdapter`
  (`channel`, `inboxId`, `start`/`stop`, `onMessage`, `sendText`/`sendMedia`/
   `sendInteractive`, `capabilities`).
2. Add its configuration to `[src/config/config.schema.ts](src/config/config.schema.ts)`.
3. Register it in `[src/app.module.ts](src/app.module.ts)` and contribute it to the
  `MESSENGER_ADAPTERS` multi-provider.

No changes to `InboundService`, `OutboundService`, or the outbox are needed:
inbound routing uses the adapter's `channel`, and outbound routing uses its
`inboxId`.

## Testing

```bash
npm test
```

Unit tests cover the Markdown-to-Telegram-HTML formatter, the Chatwoot webhook
mapper, the in-memory outbox retry behavior, and the keyed mutex.

## License

[MIT](LICENSE) (c) 2026 grentank