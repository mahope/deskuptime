# DECISION — 29. august 2026 — DeskUptime: Desktop website monitor

## Beslutning: HOLDER. Tauri desktop app bygget.

## Hvad: DeskUptime — Desktop website monitor

| | |
|---|---|
| **Produkttype** | Tauri desktop app (macOS, Windows coming) + CLI |
| **Målgruppe** | Webdevelopere, freelancere, små teams der vil overvåge websites |
| **Problem** | Uptime-monitorering SaaS koster $10-50/md. En desktop app gør det samme uden løbende serveromkostninger |
| **Pris** | **$19 one-time**, licensnøgle til 3 maskiner |
| **Platform** | Salg via Stripe Payment Link (https://buy.stripe.com/7sY9AS9eX3Iu418fJ5bMQ01), licens via mahope.tools. Distribuér: GitHub Releases + npm (CLI) |
| **Indtjeningsmodel** | Licensnøgle via Stripe. Desktop = differentiering fra SaaS |
| **Status** | Desktop app BYGGET. Produktside LIVE. Betaling via Stripe siden 24/9-2026. |

## Hvorfor valgt frem for alternativer

| Alternativ | Hvorfor ikke |
|---|---|
| **CLI tool (html→md)** | Gratis alternativer er gode nok |
| **VS Code extension** | Kræver publisher account → Mads |
| **Chrome extension** | Kræver CWS API key → Bitwarden |
| **SaaS** | Kræver servere + betaling + drift — desktop er $0 at levere |

## Hvad kan slå det ihjel
- Betalingsudbyderen falder væk (skete med den første udbyder i 9/2026) — løst med Stripe + egen licensserver
- Ingen finder produktet — 0 trafik er det reelle problem. Løsning: SEO + indhold
- Konkurrence fra gratis tools — differentierer via privacy, one-time price, desktop UX