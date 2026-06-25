# bedevere-feedback (Cloudflare Worker)

Tiny POST receiver for the in-app feedback form. Stores submissions in
Cloudflare D1; an admin GET route returns recent rows as JSON for the
maintainer to read via `curl`.

Deployed independently of the main app (the app ships via Cloudflare
Workers static assets; this is a separate Worker on `*.workers.dev`).

## One-time setup

```bash
cd cloudflare/feedback-worker
bun install

# Authenticate locally (opens a browser).
bunx wrangler login

# Create the D1 database. Copy the printed `database_id` into wrangler.toml.
bunx wrangler d1 create bedevere-feedback
$EDITOR wrangler.toml   # paste database_id

# Apply the schema (remote = production D1; --local for the dev sandbox).
bun run schema:apply

# Set the secrets — random hex string for admin, and the EXACT origin of
# the deployed app's origin (no trailing slash).
bunx wrangler secret put FEEDBACK_ADMIN_SECRET
bunx wrangler secret put ALLOWED_ORIGIN     # e.g. https://bedevere.example.com

bun run deploy
```

The deploy prints the worker's URL (e.g. `https://bedevere-feedback.<your-subdomain>.workers.dev`).
Set that URL as `VITE_FEEDBACK_URL` in the main app's deploy environment
(its Cloudflare Workers project → Settings → Variables) and redeploy.

## Local development

```bash
bun run dev   # spins up wrangler with a local D1 sandbox
bun run schema:apply-local
```

The worker is reachable at `http://localhost:8787`. Override
`VITE_FEEDBACK_URL` to point at it:

```bash
# repo root
echo "VITE_FEEDBACK_URL=http://localhost:8787" > .env.local
bun run dev   # main app on :3000, talks to worker on :8787
```

## Reading submissions

```bash
SECRET="..."   # the FEEDBACK_ADMIN_SECRET you set above
WORKER="https://bedevere-feedback.<your-subdomain>.workers.dev"

curl "$WORKER/admin/feedback?secret=$SECRET&limit=50" | jq
```

For a quick CSV dump from the comfort of `wrangler`:

```bash
bunx wrangler d1 execute bedevere-feedback --remote \
  --command "SELECT id, datetime(created_at/1000,'unixepoch'), category, email, message FROM feedback ORDER BY created_at DESC LIMIT 50" \
  --json | jq -r '.[0].results[] | [.["id"], .["datetime(created_at/1000,'\''unixepoch'\'')"], .category, .email, .message] | @csv'
```

## Costs (free tier as of 2026-04)

- Workers free tier: 100,000 requests/day, 10ms CPU/request.
- D1 free tier: 5 GB storage, 5M reads/day, 100k writes/day, 1 DB.
- Custom domain (optional): $0 (Cloudflare-issued cert), but your
  domain registrar charges its own annual fee.

The endpoint will cost $0/mo until you have ~100k feedback submissions
in a day, which is a wonderful problem to have.

## Security notes

- The `ALLOWED_ORIGIN` secret pins CORS to a single origin. Browser-side
  forms from any other site are blocked by the browser before the
  request lands. This is not a hard guarantee against scripted clients
  (those skip CORS entirely) — it's defence-in-depth alongside the
  honeypot field, the per-IP rate limit, and Cloudflare's platform
  rate-limit rules (configure those in the dashboard).
- Raw IPs are NOT stored. The rate-limiter compares a SHA-256 hash of
  `ip + ALLOWED_ORIGIN` so the same client within the rate window is
  detected, but the raw IP can't be recovered from the database.
- `FEEDBACK_ADMIN_SECRET` is the read gate. If you suspect leakage,
  rotate via `bunx wrangler secret put FEEDBACK_ADMIN_SECRET` and the
  next deploy invalidates the old value.
