# BUILD.md — 29. august 2026 — DeskUptime Desktop App

## Korteste vej til første betalende kunde

### Nu: Byg Tauri desktop app (SELVE PRODUKTET)
1. ✅ Portér engine til Rust (ping, SSL, content — ~350 linjer)
2. ✅ Frontend: HTML/JS/Tailwind dashboard
3. ✅ Tauri v2 app scaffold: system tray, commands, tilstandsstyring
4. 🔄 **Build**: kompilerer nu (Rust-dependencies, ~600 sec)
5. ⏳ macOS .dmg bundlet → GitHub Release
6. ⏳ Windows .msi → cross-compile eller GitHub Actions

### Efter build: Distribuér
7. ⏳ GitHub Release med binaries (masOS .dmg, Windows .msi)
8. ⏳ Produktside opdateret med download-links
9. ⏳ **Venter på LS key**: Opret produkt → license key → unlock flow i app
10. ⏳ $19 checkout → første betalende kunde

### Blokeringer
- **LS API key** i Bitwarden (ventes) — alt betalingsflow blokeret
- **npm-publish** kræver npm token (GitHub-vej virker indtil videre)

### Bygget i ventetiden
- Desktop app (Tauri v2, Rust engine) — selve produktet
- SEO-indhold til trafik ("uptime monitor desktop", "website monitor mac", etc.)

## Indtjeningsmodel

| Variant | Pris | Indtægt | Kanal |
|---------|------|---------|-------|
| Gratis CLI | $0 | — | npx github:mahope/deskuptime |
| Pro (desktop app) | $19 one-time | ~$13/køb efter LS fee | LS checkout + license key |
| Fremtid: v2 upgrade | $9 | ~$6/køb | LS checkout |

## Hvorfor desktop før SaaS?
Desktop-app er $0 leveringsomkostning, én gang betalt. SaaS kræver servere og løbende hosting.