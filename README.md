# DeskUptime

**Desktop website monitor.** Check uptime, SSL certificates, and content changes from your terminal or desktop — no monthly SaaS fees.

```
npx github:mahope/deskuptime check https://example.com
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
npx github:mahope/deskuptime check https://yoursite.com

# Check multiple URLs
npx github:mahope/deskuptime check https://site1.com https://site2.com

# Machine-readable output for scripts/CI (exit code 2 if any site is down)
npx github:mahope/deskuptime check https://yoursite.com --json | jq '.[0].sslDaysRemaining'

# Monitor URLs in the background — alerts on UP/DOWN/SSL/content changes (free, up to 3 URLs)
npx github:mahope/deskuptime watch https://yoursite.com --interval 300

# Run a single monitoring pass (great for cron) and exit
npx github:mahope/deskuptime watch https://yoursite.com --once

# Show current status of monitored URLs without checking
npx github:mahope/deskuptime watch --status

# Show help
npx github:mahope/deskuptime --help
```

Watch mode stores state in `~/.deskuptime/state.json` and resumes where it left off.
It prints a line on every status change: site down 🚨, back up ✅, SSL expiring within
14 days ⚠️, or content changed 🔄.

## Pro features (license key — $19 one-time)

- **Desktop app** with system tray + native notifications
- **More than 3 monitored URLs**
- **Email/Slack/webhook alerts** on status changes

## Pro license

A one-time $19 purchase via [Lemon Squeezy](https://lemonsqueezy.com). License key unlocks
the desktop app, native notifications and unlimited URLs. 3 activations per license.

Coming soon — sign up for updates at [the landing page](https://auditedwp.pages.dev/deskuptime/).

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
| `fail-on-down` | `true` | Fail the step (exit 2) if any URL is unreachable |
| `fail-on-ssl-expiry-days` | `0` | Also fail if SSL expires within N days (`0` = off) |
| `summary` | `true` | Write a Markdown table to the job summary |

Outputs: `json` (full results array) and `down-count`.

Exit codes: `0` all up · `2` one or more down · `3` SSL expiring/invalid.

## Install

**Homebrew (macOS/Linux):**

```bash
brew install mahope/tap/deskuptime
```

**curl (macOS/Linux, no package manager needed):**

```bash
curl -fsSL https://raw.githubusercontent.com/mahope/deskuptime/main/tools/install.sh | bash
```

Installs the `deskuptime` CLI to `~/.local/bin`.

**npm (when published):**

```bash
npx github:mahope/deskuptime check <url>
```

## Development

```bash
git clone https://github.com/mahope/deskuptime
cd deskuptime
npm test
```

## License

MIT — the core engine is open source. Pro features require a license key.

---

Built by [Mahope](https://github.com/mahope).