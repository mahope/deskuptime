# BUILD — DeskUptime: Korteste vej til første betalende kunde

## Produkt
Desktop website monitor (uptime + SSL + content changes). CLI gratis, Pro $19 via LS license key.

## Trappe til betaling

### Trin 1 ✅ — Engine + CLI (28/8)
- [x] Core engine: ping, SSL, content change detection (src/engine.js + checkers/)
- [x] CLI: `deskuptime check <url>` — virker, testet på 2 URLs
- [x] README med features, usage, pricing

### Trin 2 ✅ — Landing page (28/8)
- [x] site/deskuptime/index.html — produktbeskrivelse, features, $19 pris, waitlist
- [x] Navlink fra hovedsite
- [x] Deployet og verificeret live

### Trin 3 🟡 — LS license flow (klar til key)
- [x] src/license.js — validate, activate, deactivate via LS License API
- [ ] Når LS key kommer: opret produkt "Deskuptime Pro" på LS
- [ ] Opret variant "$19 one-time" med license key generation
- [ ] Kør ls-setup.sh med API key → checkout URL
- [ ] Opdater landing page med checkout link + license unlock flow
- [ ] Copy checkout URL to clipboard + go

### Trin 4.5 ✅ — Watch mode i CLI (28/8, iteration 401)
- [x] src/watch.js — baggrundsloop, state i ~/.deskuptime/state.json, resume
- [x] UP/DOWN-detektion, SSL-advarsel ≤14 dage, content-change alerts
- [x] Testet live: example.com (UP) + localhost:9999 (DOWN begivenhed)
- [x] Landing page + README opdateret: watch er gratis, Pro = desktop app, notifikationer, >3 URLs
- [x] Deployet + verificeret på hermes-passiv.pages.dev

### Trin 4.6 ✅ — v0.1.3: watch --once, --status + release automation (26/8, iter 427)
- [x] `deskuptime watch --once <url>` — enkelt pass, exit; godt til cron
- [x] `deskuptime watch --status` — status fra state.json, ingen netværkskald
- [x] `.github/workflows/release-cli.yml` — bygger tarball ved tag, opretter release, auto-opdaterer Homebrew-tap sha
- [x] Homebrew-formel fixet: `Dir["src/*.js"]` flader ud → `libexec.install "src"` bevarer mappestrukturen
- [x] v0.1.3-cli tag udgivet, tarball deployet, tap opdateret, virker med `brew install mahope/tap/deskuptime`

### Trin 4 — Tauri desktop app (kan bygges parallelt)
- [ ] `cargo tauri init` i deskuptime/
- [ ] Window med: URL list, status, logs
- [ ] System tray integration (background monitor)
- [ ] Import engine.js via Node.js sidecar
- [ ] License key activation form i GUI
- [ ] Build + GitHub release

### Trin 5 — Distribution + marketing
- [ ] GitHub release med binaries (Mac + Windows)
- [ ] npm publish `deskuptime` (free CLI)
- [ ] Homebrew tap for CLI
- [ ] Produktside SEO: title, description, structured data, sitemap
- [ ] Blog post: "Why I built a desktop uptime checker — and killed my $144/year SaaS bill"
- [ ] Product Hunt launch prep

## Når LS key kommer (estimateret — 5 min arbejde)

```bash
LEMONSQUEEZY_API_KEY=ls_xxx ./scripts/ls-setup.sh
# ↑ opretter produkt, variant, checkout link, automatisk
```

Da LS har API: alt kan scriptes. Én kørsel → produkt eksisterer → checkout link → plaster på landing page → klar til at sælge.

## Ventetid er arbejdstid

Mens LS key ikke er her:
1. ✅ Engine bygget
2. ✅ CLI bygget + testet
3. ✅ Landing page bygget + deployet
4. ✅ LS license module bygget
5. ⬜ Tauri desktop app
6. ✅ Release workflow + Homebrew tap (auto-publish CLI tarball)
7. ⬜ SEO/content til landing page
8. ⬜ Blog post