# DeskUptime

**Desktop website monitor.** Check uptime, SSL certificates, and content changes from your terminal or desktop — no monthly SaaS fees.

```
npx @mahope/deskuptime check https://example.com
```

✅ Status: 200 OK | Response: 85ms | 🔒 SSL: 63 days remaining

## Features

- **Uptime checking** — HTTP status code + response time measurement
- **SSL certificate validation** — expiry countdown, issuer, cipher info
- **Content change detection** — SHA-256 hash comparison between checks
- **Cross-platform** — CLI (npm) + desktop app (Tauri, Mac/Windows)
- **Universal** — works on any website, any CMS, any stack
- **Free CLI** — check URLs from your terminal, no account needed

## Quick start

```bash
# Check a single URL
npx @mahope/deskuptime check https://yoursite.com

# Check multiple URLs
npx @mahope/deskuptime check https://site1.com https://site2.com

# Machine-readable output for scripts/CI (exit code 2 if any site is down)
npx @mahope/deskuptime check https://yoursite.com --json | jq '.[0].sslDaysRemaining'

# Override the 15-second network timeout when needed
npx @mahope/deskuptime check https://yoursite.com --timeout 30000

# Monitor URLs in the background — alerts on UP/DOWN/SSL/content changes (free, up to 3 URLs)
npx @mahope/deskuptime watch https://yoursite.com --interval 300

# Run a single monitoring pass (great for cron) and exit
npx @mahope/deskuptime watch https://yoursite.com --once

# Show current status of monitored URLs without checking
npx @mahope/deskuptime watch --status

# Show help
npx @mahope/deskuptime --help
```

Watch mode stores state in `~/.deskuptime/state.json` (or the native user profile on Windows) and resumes where it left off.
The first pass records a baseline for every URL. `--once` runs exactly one pass, saves state, and exits with code `0` when all monitored URLs are healthy, `2` when any URL is DOWN, or `1` for invalid usage. `watch --status` only reads the saved state and never contacts monitored URLs.
It prints a line on every status change: site down 🚨, back up ✅, SSL expiring within 14 days ⚠️, or content changed 🔄. An SSL warning is emitted once per crossing of the 14-day threshold; recovery resets it.

## Status policy

A site is **healthy/UP** when a response was received with final HTTP status `200–399`.
HTTP `400–599`, timeouts, refused connections and other network failures are **DOWN**.
`reachable` in JSON only means that an HTTP response was received, so a `404` or `500`
has `reachable: true` but `healthy: false`. Redirects are followed and the final status
is evaluated. A multi-URL check validates every URL before sending any request; one
invalid URL fails the complete check with exit code `1`.

## Pro features (license key — $19 one-time)

- **Desktop app** with system tray + native notifications
- **More than 3 monitored URLs**
- **Email/Slack/webhook alerts** on status changes

## Pro license

A one-time $19 purchase. The license key unlocks the desktop app, native notifications
and unlimited URLs on up to 3 machines.

The CLI in this repository is open source (MIT). DeskUptime Desktop Pro is a paid, closed-source app: download it from https://deskuptime.com/ and unlock it with your license key.

**[Buy DeskUptime Pro](https://buy.stripe.com/7sY9AS9eX3Iu418fJ5bMQ01)** — the key is shown right after checkout and sent by email.

```bash
deskuptime activate <license-key>   # unlock Pro on this machine
deskuptime deactivate               # free this machine's seat for another one
```

The CLI and the desktop app on the same machine share one seat. The license is re-checked
periodically; if the license server is unreachable, Pro keeps working for 7 days.

Like the free tools? [Support open source development](https://donate.stripe.com/7sYeVcbn50wieFM8gDbMQ0c).

## How it works

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│  ping.js │    │  ssl.js  │    │ content  │
│ HTTP     │    │ TLS cert │    │ .js      │
│ status   │    │ validity │    │ hash     │
│ time     │    │ issuer   │    │ compare  │
└──────────┘    └──────────┘    └──────────┘
       │              │              │
       └──────────────┼──────────────┘
                      ▼
             ┌────────────────┐
             │   engine.js    │
             │  (universal)   │
             └───┬──────┬────┘
                 │      │
         ┌───────┘      └───────┐
         ▼                      ▼
   ┌──────────┐          ┌──────────┐
   │ cli.js   │          │ Tauri    │
   │ (npm)    │          │ desktop  │
   └──────────┘          └──────────┘
```

The engine is **universal** — same logic powers the CLI, the desktop app, and any future
integration (API, CI/CD, Homebrew). No platform lock-in.

## Use in GitHub Actions

Run uptime checks in your CI — the job fails if a site is down, and a status
table lands in the job summary. No account, no API key:

```yaml
name: Monitor
on:
  schedule:
    - cron: '*/30 * * * *'   # every 30 minutes
  workflow_dispatch:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: mahope/deskuptime@v0
        with:
          urls: |
            https://yoursite.com
            https://api.yoursite.com/health
      - name: Alert on failure
        if: failure()
        run: echo "A monitored site is down!" # wire to Slack/email/webhook here
```

Inputs:

| Input | Default | Description |
|-------|---------|-------------|
| `urls` | (required) | Space- or newline-separated URLs |
| `fail-on-down` | `true` | Fail the step (exit 2) if any URL returns HTTP 4xx/5xx or has a network error |
| `fail-on-ssl-expiry-days` | `0` | Also fail if SSL expires within N days (`0` = off) |
| `summary` | `true` | Write a Markdown table to the job summary |

Outputs: `json` (full results array) and `down-count`.

Exit codes: `0` all up · `2` one or more down · `3` SSL expiring/invalid.

## Install

Requires Node.js 24 or newer.

**Homebrew (macOS/Linux):**

```bash
brew install mahope/tap/deskuptime
```

**curl (macOS/Linux, no package manager needed):**

```bash
curl -fsSL https://raw.githubusercontent.com/mahope/deskuptime/main/tools/install.sh | bash
```

Installs the `deskuptime` CLI to `~/.local/bin`.

**npm:**

```bash
npx @mahope/deskuptime check <url>
```

## Development

```bash
git clone https://github.com/mahope/deskuptime
cd deskuptime
npm test
```

## Links

Product page and desktop app downloads: **https://deskuptime.com/**
Buy Pro: **https://buy.stripe.com/7sY9AS9eX3Iu418fJ5bMQ01**

## Releasing

`npm run release -- patch` (or `minor`/`major`) bumps the version, commits and pushes the tag.
CI publishes to npm and creates the GitHub release.

## License

MIT — the core engine is open source. Pro features require a license key.

## Author

Built by Mads Holst Jensen — developer and technical partner for small businesses, Odense, Denmark. https://mahoje.dk
