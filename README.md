# veille-submit

A self-hosted PWA to collect URLs from your phone and store them in PostgreSQL. Works as an Android Share Target — share any link directly from your browser, Twitter, YouTube, etc.

## Features

- **Android Share Target** — appears in your phone's share menu, one tap to save
- **ntfy.sh integration** — receive URLs via push notifications (SSE subscription)
- **HTTP API** — `POST /submit` for programmatic access
- **Auto-enrichment** — fetches page titles, YouTube transcripts (via yt-dlp)
- **Duplicate detection** — won't add the same URL twice
- **Push notifications** — get notified via ntfy when a URL is added
- **PWA** — installable on Android home screen, works offline (cached shell)
- **Zero dependencies beyond Node + PostgreSQL** — no framework, no build step

## Quick Start

### With Docker Compose (recommended)

```bash
git clone https://github.com/YOUR_USER/veille-submit.git
cd veille-submit
cp .env.example .env
# Edit .env with your PostgreSQL credentials and ntfy topics
docker compose up -d
```

Open `http://localhost:7890` — done.

### Without Docker

```bash
# Prerequisites: Node.js 18+, PostgreSQL, yt-dlp (optional, for YouTube)
npm install
psql -f schema.sql
cp .env.example .env
# Edit .env
npm start
```

## Setup as Android Share Target

1. Open `https://your-domain.com` on your Android phone in Chrome
2. Menu ⋮ → **Add to Home screen** (or "Install app")
3. Now when you share any link, "Veille Submit" appears in the share menu

> **Note**: Share Target requires HTTPS. Use a reverse proxy (Caddy, nginx, Cloudflare Tunnel) in front.

## Architecture

```
Phone Share Sheet
    │
    ├─ GET /share?text=URL  →  instant confirmation page
    │                           └─ background: fetch title → insert DB → ntfy notification
    │
    ├─ POST /submit {url}   →  JSON response with title + item ID
    │
    └─ ntfy SSE subscription →  extract URL from message → same pipeline
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7890` | HTTP server port |
| `PGHOST` | `localhost` | PostgreSQL host |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGDATABASE` | `main` | Database name |
| `PGUSER` | `admin` | Database user |
| `PGPASSWORD` | — | Database password |
| `DB_SCHEMA` | `veille` | PostgreSQL schema |
| `DB_TABLE` | `feed_items` | Table name |
| `AGENT_ID` | `1` | Agent ID for multi-tenant setups |
| `APP_NAME` | `Veille Submit` | Displayed in notifications |
| `NTFY_SERVER` | `https://ntfy.sh` | ntfy server URL |
| `NTFY_SUBSCRIBE_TOPIC` | — | Topic to listen for incoming URLs |
| `NTFY_AUTH_USER` | — | ntfy Basic auth username |
| `NTFY_AUTH_PASS` | — | ntfy Basic auth password |
| `NTFY_NOTIFY_TOPIC` | — | Topic for sending confirmations |
| `NTFY_NOTIFY_SERVER` | same as `NTFY_SERVER` | Server for notifications |

## API

### `POST /submit`
```bash
curl -X POST http://localhost:7890/submit \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/article"}'
```

### `GET /recent`
Returns the 20 most recent submissions.

### `GET /health`
Returns `{"status": "ok", "uptime": 123.45}`.

### `GET /share?text=URL`
Used by Android Share Target. Returns an instant confirmation page and processes the URL in the background.

## License

MIT
