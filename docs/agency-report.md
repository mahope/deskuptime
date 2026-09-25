# Client report (`deskuptime report`) — spec

Status: **del A + del B shippet 2026-09-25** (`ceo/agency-report`). This document
is the source of truth for the report's data model, privacy and format. It also
records what is deliberately *not* built yet.

## 1. Målgruppe

En lille bureau eller frilansende IT-mand, der overvåger en kundes site og skal
kunne **levere et bevis** — typisk månedligt, ved aflevering eller når der har
været en hændelse. Kunden skal ikke logge ind på noget, og bureauet skal ikke
stille en server op for at kunne svare.

Det er derfor rapporten er en *fil* og ikke et dashboard: en Markdown-fil kan
lægges i en mail eller et ticket, JSON kan gå videre i bureauets eget system.

## 2. Datamodel

Rapporten læser **kun** `state.urls` i `~/.deskuptime/state.json`. Den skriver
intet og foretager ingen requests, så den beskriver altid den seneste
gennemførte pass. For en frisk pass: `deskuptime watch <url> --once`.

To heltal per URL gemmes pr. pass, skrevet af `recordPass()` i `src/report.js`:

| Felt | Betydning |
| --- | --- |
| `checks` | Antal gennemførte passes for denne URL |
| `checksUp` | Hvor mange af dem svarede UP (HTTP 200–399) |
| `lastResponseMs` | Svartid fra det seneste pass |

Uptime er **kun** `checksUp / checks`, defineret ét sted (`uptimePercent()`), så
skriver og læser aldrig kan blive uvede. Uden en gennemført pass er værdien
`null` og vises som `—`; den må aldrig vise 100 % fordi ingen data er samlet.

`wasUp`, `lastStatus`, `sslValidDays`, `lastContentLength`, `lastChecked` og
`addedAt` læses fra den eksisterende state, som `watch` allerede skriver.

Rapporten dækker pr. site: `url`, `status` (`up`/`down`/`unknown`),
`statusCode`, `uptimePercent`, `checks`, `failures`, `responseMs`,
`sslDaysRemaining`, `contentBytes`, `lastChecked`, `monitoringSince`, og en
`summary` med antal sites/checks/failures.

## 3. Privacy og redaktion

Det er her bureauet bliver solgt, og derfor er reglerne hårde:

- **Licensen kommer aldrig med.** `buildReport()` modtager kun `state.urls`;
  `state.license` (nøgle, device id) er ikke læst, ikke kopieret og kan ikke
  nå output. `test/report.test.js` lægger en nøgle i state og fejler, hvis den
  dukker op i Markdown eller JSON.
- **Intet sideindhold.** Ingen svarbody, ingen headere, ingen cookie, ingen
  content-hash, ingen IP-adresser, ingen request- eller DNS-log.
- **Ingen upload.** Intet forlader maskinen. Rapporten er read-only og kan
  køre offline.
- **Brugernavn i tabellen.** URL'en er URL'en — det er kundens eget site, og det
  er pointen. Titles og felter escapes, så en URL med `|`, `<` eller newline
  ikke kan ødelægge tabellen eller blive til markup i den modtager.

## 4. Report-format

`deskuptime report [--title "Client name"] [--json]`

- Standard: Markdown med titel, genereringstidspunkt, én tabel
  (Site / Status / Uptime / Response / SSL / Last check) og en resumelinje.
  DOWN-sites står først, så en kunde ser det vigtigste uden at lede.
- `--json`: ren JSON på stdout til CI og bureauets egne systemer.
- `--title` fladtes til én kort linje (maks. 120 tegn) — titlen ender i en fil,
  der videresendes.
- Uden Pro-licens skriver kommandoen **intet**, men siger hvorfor og peger på
  købslinket. Gratisbrugere beholder `watch --once` og `status`, som skriver de
  samme tal som tekst.

## 5. Pris og entitlement

- **DeskUptime Pro, $19 engang, 3 maskiner** (kontraktens link). Ingen ny
  licensstype, ingen nyt Stripe-produkt.
- Entitlements håndhæves med `isPro(state)` — samme allow-liste som resten af
  CLI'en, så `unverified` og `invalid` aldrig giver rapport.
- Matrixen i `src/features.js` er source of truth; `npm run matrix` skriver
  README, `docs/pro-alerts.md` og npm-beskrivelsen, og `test/matrix.test.js`
  fejler på drift.

## 6. Bevis og mutationstest

- `test/report.test.js`: uptime-matematik inkl. nul-passes, `recordPass`-
  tælling via rigtige `runPass`-kald, at en DOWN-side står først, at
  `|`/`<script>`/newline i en URL ikke kan ødelægge tabellen, at licensnøglen
  ikke lækker til Markdown eller JSON, Pro-gaten med købslink, `--json` og
  `--title`.
- Mutation: at slette `recordPass`-kaldet i `runPass` giver fejl i
  uptime-testen; at gøre `isPro`-gaten væk giver fejl i gaten.

## 7. Ikke bygget (bevidst)

- **Hostet status-side** med offentligt URL og flere læsere. Kræver en server,
  et domæne og en driftsaftale — ikke denne iteration, og uden Mads' beslutning
  (❓ 3 i `IMPLEMENTATION_PLAN.md`).
- **Historik per døgn.** Tællerne er all-time og vokser ikke med tiden; en
  30-dages tidsserie kræver enten ring-buffer pr. URL eller et separat format.
- **Faktura/layout, månedstal, logo.** Titlen er den eneste branding i dag.
- **Dansk rapporttekst.** CLI'en er engelsk; rapporten følger CLI'en. En
  `--lang da`-udgave er en lille, selvstændig opgave.
- **Planlagte rapporter** (skedsat, mailet direkte til kunden) hænger på
  ❓ 3 og på kanalvalg i ❓ 2.
