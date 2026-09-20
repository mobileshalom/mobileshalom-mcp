# mobileshalom-mcp

A read-only [MCP](https://modelcontextprotocol.io) server that lets MCP client applications
search and read articles from the [mobileShalom](https://mobileshalom.com) blog.

It runs over **Streamable HTTP**, so it can be hosted at a public URL rather than run locally over stdio.

## What it can do

| Tool | Purpose |
| --- | --- |
| `search_posts` | Search blog posts by keyword |
| `list_recent_posts` | List the newest posts |
| `get_post` | Read one full post, by slug or id |
| `list_categories` | Browse the blog's topic categories |

## What it deliberately cannot do

The endpoint is public and requires no login, so it is strictly read-only:

- It only reads content that is already public on mobileshalom.com.
- It cannot create, edit or delete anything.
- It holds no credentials, sends no email, and touches no database directly.

It reads through the site's public WordPress REST API (`/wp-json/wp/v2/`).

## Endpoints

- `GET /` — health check / status JSON
- `POST /mcp` — the MCP endpoint

## Running locally

```bash
npm install
npm start
```

Then point the MCP Inspector at it:

```bash
npx @modelcontextprotocol/inspector
```

Use transport **Streamable HTTP** and URL `http://localhost:3000/mcp`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on (set automatically by most hosts) |
| `SITE_URL` | `https://mobileshalom.com` | WordPress site to read from |

No secrets or API keys are required.

## Deployment

Deployed on Sevalla from this repository:

- Build command: `npm install`
- Start command: `npm start`
- Port: provided via `PORT`

Public URL: `https://mcp.mobileshalom.com/mcp`
