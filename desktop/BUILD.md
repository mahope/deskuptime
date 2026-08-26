# BUILD.md — 26. august 2026 — DeskUptime Desktop App

## Status: App bygget + udgivet + download-links live

### Bygget og klar
1. ✅ Rust engine (ping, SSL, content — ~350 linjer)
2. ✅ Frontend: HTML/JS/Tailwind dashboard med licens-UI
3. ✅ Tauri v2 app: system tray, tray-menu (Show/Quit), background monitoring
4. ✅ URL-persistens: gemmer/indlæser URLs og licensstate via `app_data_dir()`
5. ✅ LS license activation/deactivation i Rust (activate_license, deactivate_license, get_license_state, get_free_limit)
6. ✅ Free tier: 3 URLs max, Pro queries via LS API
7. ✅ CI build (GitHub Actions): macOS aarch64 + x86_64, Windows x64
8. ✅ GitHub Release v0.2.1 med .zip binaries for Mac (.exe/.msi for Windows)

### Distribuér
9. ✅ GitHub Release med binaries (macOS .dmg, Windows .msi/.exe)
10. ✅ Produktside (deskuptime/index.html) opdateret med download-kort + knapper
11. ✅ Blogpost (desktop-website-monitor-cli.html) opdateret: download-links i stedet for "under development"
12. ⏳ **Venter på LS key**: Opret produkt → license key → unlock flow i app
13. ⏳ $19 checkout → første betalende kunde

### Blokeringer
- **LS API key** i Bitwarden (ventes) — alt betalingsflow blokeret
- **npm-publish** kræver npm token (GitHub-vej virker indtil videre)

### Indtjeningsmodel

| Variant | Pris | Indtægt | Kanal |
|---------|------|---------|-------|
| Gratis CLI | $0 | — | npx github:mahope/deskuptime |
| Pro (desktop app) | $19 one-time | ~$13/køb efter LS fee | LS checkout + license key |
| Fremtid: v2 upgrade | $9 | ~$6/køb | LS checkout |

## Hvorfor desktop før SaaS?
Desktop-app er $0 leveringsomkostning, én gang betalt. SaaS kræver servere og løbende hosting.