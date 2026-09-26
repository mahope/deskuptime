# Client report (`deskuptime report`) — spec

Status: **del A + del B shippet 2026-09-25** (`ceo/agency-report`), **del C
(30-dages historik) shippet 2026-09-26** (`ceo/report-history`). This document
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
`statusCode`, `uptimePercent`, `window`, `checks`, `failures`, `responseMs`,
`sslDaysRemaining`, `contentBytes`, `lastChecked`, `monitoringSince`, og en
`summary` med antal sites/checks/failures.

### 2b. Historik pr. døgn (del C)

`Uptime (all)` alene er et svagt bevis: en bureau-monitorering, der startede i
marts, har et "100 % siden start" uden at sige noget om den seneste måned. Derfor
findes et **dags-bucket pr. URL pr. døgn** i `~/.deskuptime/history.json`, skrevet
af `src/history.js`.

En bucket er **to heltal**: `checks` og `failures`. En fejlet pass tæller med i
nævneren — passet kørte, og kunden har ret til at se det. Dags er UTC-døgn, så et
pass kl. 23:30 og et kl. 00:30 ikke havner i samme bucket.

Filen er **begrænset ved konstruktion** og ikke ved håflighed:

| Grænse | Værdi | Hvorfor |
| --- | --- | --- |
| Døgn pr. URL | 35 | 30-dages vinduet plus 5 dages slæk, så vinduet ikke er tomt, fordi et døgn endnu ikke er skrevet |
| URL'er i filen | 500 | Følger sites, der fjernes igen, kan ikke vokse filen |
| Pruning | ved skrivning | `pruneHistory()` kører i hvert pass |

Historien skrives for **alle tiers**. Den er to heltal pr. site pr. døgn, og en
gratisbruger der opgraderer skal ikke starte en 30-dages rapport med en tom
måned. Det er rapporten — ikke optagelsen — der er Pro.

Historie-filen er en **anden fil** end `state.json`, af to grunde: state skrives
hvert pass og rummer licensnøglen, og historikken vokser med tiden. Blander man
dem, bliver state uafgrænset og lander tællere ved siden af nøglen. Begge filer
skrives `0600` i en `0700`-mappe og atomisk; en halvskrevet historik læses som
tom, aldrig som en fejl.

`window` i rapporten er `null`, når et site ikke har ét registreret døgn i
vinduet, og vises som `—`. Det må aldrig vise 100 % fordi der ikke er data —
samme regel som `uptimePercent`.

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

`deskuptime report [--title "Client name"] [--days N] [--json]`

- Standard: Markdown med titel, genereringstidspunkt, én tabel
  (Site / Status / Uptime (all) / Uptime (window) / Response / SSL / Last check)
  og en resumelinje. DOWN-sites står først, så en kunde ser det vigtigste uden
  at lede.
- **SSL-kolonnen er et advarselssignal, ikke et tal.** Et certifikat med ≤ 14
  dage til udløb skrives som `⚠️ 9 d — renew soon`, tælles i resumelinjen
  ("1 SSL expiring soon") og **navnes på en egen linje** med de URL'er der skal
  fornyes, så modtageren ikke skal lede i tabellen. 14 dage er samme vindue som
  `check` og `watch` bruger, defineret ét sted (`SSL_WARN_DAYS` i
  `src/status.js`) — et certifikat kan ikke advare i terminalen og se fredeligt
  ud i rapporten. Et site uden kendt udløbsdag viser `—` og advares aldrig; et
  negativt eller ugyldigt tal fra en håndskrevet state-fil er behandlet som
  ukendt, ikke som "forfalden nu". I `--json` hedder felterne
  `sslDaysRemaining`, `sslExpiringSoon` og `summary.sslExpiringSoon`.
- `--days N`: rapportvinduet, 1–35 (hvor meget historik der faktisk er gemt).
  Uden flag er det 30. Uden for intervallet fejler kommandoen med en besked,
  der siger hvorfor, i stedet for at ignorere tallet.
- `--json`: ren JSON på stdout til CI og bureauets egne systemer.
- `--title` fladtes til én kort linje (maks. 120 tegn) — titlen ender i en fil,
  der videresendes.
- Uden Pro-licens skriver kommandoen **intet**, men siger hvorfor. En kunde der
  har betalt, men hvis nøgle serveren ikke har kunnet dømme (`unverified`), får
  beskeden "genverificér nøglen" — aldrig købslinket; købslinket er kun svaret
  til en bruger uden licens. Se `docs/license-lifecycle.md` §2. Gratisbrugere
  beholder `watch --once` og `status`, som skriver de samme tal som tekst.

## 5. Pris og entitlement

- **DeskUptime Pro, $19 engang, 3 maskiner** (kontraktens link). Ingen ny
  licensstype, ingen nyt Stripe-produkt.
- Entitlements håndhæves med `isPro(state)` — samme allow-liste som resten af
  CLI'en, så `unverified` og `invalid` aldrig giver rapport.
- Matrixen i `src/features.js` er source of truth; `npm run matrix` skriver
  README, `docs/pro-alerts.md` og npm-beskrivelsen, og `test/matrix.test.js`
  fejler på drift.

## 6. Bevis og mutationstest

- `test/history.test.js` (17 tests): historikken ligger ved siden af state på
  alle platforme og følger en omdirigeret state-fil (aldrig til den rigtige
  home), UTC-dagsbucketting, at en fejlet pass tæller med, at en bucket kun
  indeholder to heltal (ingen hash/status/fejltekst), 35-dages pruning + 500-URL
  -loftet, håndskrevet/halvskrevet historik (`failures > checks` kan ikke give
  negativ uptime), filrettigheder og atomisk skrivning, at en pass der ikke kan
  skrive historien alligevel fuldføres og gemmer state, at vinduet kun tæller
  registrerede døgn (aldrig fremtidige), og at `--days` afvises i stedet for at
  ignoreres.
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
- **Dags-tidsserie pr. site** (en linje pr. døgn med antal fejl) og en graf.
  Buckets er tællere, ikke tidsserier: tidsrummet med forhåndsvisning af
  hver enkelt pass er ikke bygget, fordi det gemmer mange flere tal pr. URL.
- **Uptime-tal pr. kalenderperiode** ("august 2026"). Vinduet er rullende
  `--days N`, ikke en måned.
- **Faktura/layout, månedstal, logo.** Titlen er den eneste branding i dag.
- **Dansk rapporttekst.** CLI'en er engelsk; rapporten følger CLI'en. En
  `--lang da`-udgave er en lille, selvstændig opgave.
- **Planlagte rapporter** (skedsat, mailet direkte til kunden) hænger på
  ❓ 3 og på kanalvalg i ❓ 2.
