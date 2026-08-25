# DeskUptime

**Desktop website monitor.** Check uptime, SSL certificates, and content changes from your terminal or desktop — no monthly SaaS fees.

```
npx deskuptime check https://example.com
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
npx deskuptime check https://yoursite.com

# Check multiple URLs
npx deskuptime check https://site1.com https://site2.com

# Monitor URLs in the background — alerts on UP/DOWN/SSL/content changes (free, up to 3 URLs)
npx deskuptime watch https://yoursite.com --interval 300

# Show help
npx deskuptime --help
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

Coming soon — sign up for updates at [the landing page](https://hermes-passiv.pages.dev/deskuptime/).

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