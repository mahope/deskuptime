# IMPLEMENTATION_PLAN.md

STATUS: I GANG
Iteration: 21 — 2026-09-26
Arbejdsgrene: `ceo/report-ssl-warning` (P1-2 del D)
Næste handling: **P1-2 del D er færdig** — kunderapporten kunne ikke se et certifikat, der skulle fornyes. Missionen lover "SSL-udløbsvarsler" som bureau-værdi, men kun den ene af tre overflader, der viser samme certifikat, havde et advarselsvindue: `watch.js` hårdkodede `14` to steder, `engine.js` (summarize) hårdkodede `14`, og **rapporten havde ingen tærskel overhovedet** — den skrev `SSL | 9 d` i den rapport, et bureau sender til sin kunde. Den flade, der er mest synlig for kunden, var den svageste. Nu er `SSL_WARN_DAYS = 14` ét sted i `src/status.js` med `isSslExpiringSoon()`, alle tre overflader bruger det, og rapporten markerer `⚠️ 9 d — renew soon`, tæller i resumelinjen og **navner de URL'er der skal fornyes** på en egen linje; `--json` får `sslExpiringSoon` + `summary.sslExpiringSoon`. Min egen test fandt en reel fejl undervejs: `Number.isFinite(-3)` er sand, så en håndskrevet `sslValidDays: -3` ville have renderet "⚠️ -3 d — renew soon" i en kunderapport — negativt og ugyldigt er nu *ukendt* (`—`), aldrig "forfalden nu". 3 nye tests → **191/191**. Næste iteration: ❓ 2/❓ 3 hvis besvaret, ellers ny research-iteration. P1-1 AC3 (sitekilder) er `BLOCKED` på ❓ 8.

## Mission

Dette offentlige repo leverer den gratis, fuldt brugbare DeskUptime-CLI (MIT). Desktop Pro ligger i det private repo `mahope/deskuptime-desktop`. Pro er den markant bedre løsning for små bureauer og IT-teams: ubegrænsede URLs, rapporter/status-side, flere lokationer, kanaler som mail og Slack/Discord/Teams-webhooks, automatisering og prioriteret support/compliance-dokumentation. Stripe Payment Link og licens-API må kun bruges i den aftalte form; der oprettes ikke nye produkter eller priser.

## Faste regler

- Default-branch er `main`; implementering på `ceo/<kort-slug>` og merge først efter grøn gate.
- Må ikke lave git-tags, releases, npm-publicering, deploys, produktionsmigreringer eller nye services.
- `.env*`, credentials og rå licensnøgler læses, skrives, logges eller committes aldrig.
- Produktion og ekstern checkout må ikke røres. Stripe-linket og den eksterne batch-deployer verificeres kun ved læsning.
- Én større funktion ad gangen; skriv en spec i `docs/` før større Pro-funktioner.
- Hver opgave skal have begrundelse, konkrete filer og verificerbare acceptkriterier.

## Baseline fra research

### Kvalitetsgate

Den aktuelle gate-definition er registreret her:

- Root: `npm ci --ignore-scripts` skal lykkes med den committede lockfil.
- Root: `npm test` (124 tests, 124 passed på Node 26.7.0 efter P2-1 del A: 118 + 6 nye action/TLS-tests). **Bemærk:** på en maskine med kun Node 22 fejler de 7 installtests + action-testen, fordi `install.sh` og `action.yml` korrekt kræver Node 24+; brug den installerede `PATH`-node (26.7.0), ellers er gate ikke grøn af miljøårsager.
- Root: `npm run audit` skal rapportere 0 sårbarheder.
- Root: `npm run lint` findes ikke i `package.json`; rapporteres som manglende gate, ikke som grønt.
- Root: `npm run build` findes ikke i `package.json`; der er ingen JS-build/typecheck-script.
- CI, CLI-release og npm-publish bruger Node 24.
- Desktop-gates fra iteration 2 er historiske; `desktop/` findes ikke lenger i det offentlige repo.

### Sikkerhed og afhængigheder

- Den bekræftede `glib 0.18.5`-advisory (`GHSA-wrw7-89jp-8q8g` / `RUSTSEC-2024-0429`) tilhører nu det private desktoprepo og skal lukkes dér; den kan ikke scannes eller rettes i dette offentlige CLI-repo.
- Desktop-CSP-, bridge- og frontendfund fra iteration 2 blev rettet i historikken og flyttet derefter til `mahope/deskuptime-desktop`.
- Pakken har nul runtime-/dev-dependencies. En committed lockfil v3 og `npm run audit` gør tomme afhængigheder og fremtidige additions auditerbare.
- Runtime: Node 24 er den aktive LTS og er nu ensrettet i `engines`, `.nvmrc`, CI, release, publish, Action og curl-installer.

### Korrekthed og brugerrejse

- `src/checkers/ping.js` og `src/engine.js` skelnerer nu mellem `reachable` (HTTP-svar modtaget) og `healthy` (final status 200–399); timeouts og connection refusal har strukturerede `errorType`.
- `src/cli.js` afviser nu alle URLs før første request, hvis blot én er ugyldig, og understøtter `--timeout` til deterministiske fejltests.
- `watch --once` gør én gemt pass med exit 0/2/1, låser state mod samtidige cron-kørsler og afviser configfejl før request; `watch --status` er read-only.
- `src/watch.js` gemmer DOWN-baseline, latcher SSL-advarsel gennem unavailable checks til recovery over 14 dage og bruger gemt content-hash ved næste pass.
- `docs/pro-alerts.md` er source of truth for kanaler, payload, offline-adfærd og privacy; `test/claims.test.js` låser README/help mod den.
- `src/watch.js` sender nu webhook med 10 s hard timeout og uden retry (best-effort), returnerer true/false, og `--webhook` uden aktiv Pro-licens advarer med købslink i stedet for at tie.
- `deskuptime.com` er live (HTTP 200 verificeret 2026-09-25) men har ingen desktop-download; det reelle download er GitHub-releasen `desktop-v0.2.7` med macOS/Windows-assets.
- Den eksterne produktside og Stripe-fulfillment ligger uden for repoet og kan ikke verificeres endeligt her.
- Desktopparitet, IPC- og UI-fund er overført til `mahope/deskuptime-desktop`; de skal ikke genåbnes i dette offentlige CLI-repo.
- `src/license.js:14,40-42` bruger `os.hostname()`, mens Rust bruger `COMPUTERNAME` på Windows. **Løst i `e344531`:** `getDeviceId` bruger nu ikke-tom `COMPUTERNAME` på native Windows; scheme'et er låst i `test/fixtures/device-id.golden.json`. Gamle gemte `license.instance`/`instance_id` migrerer fortsat ikke automatisk, og det er bevidst overlådt til det private desktoprepo (P0-6, privat follow-up).
- Licenslifecycle er hærdet og dokumenteret i `docs/license-lifecycle.md`: hard timeout, transient vs. permanent klassificering (malformed 200 er transient), fire synlige tilstande, `0600`-fil i `0700`-mappe, valideret licensrecord og `redactSecrets()` på alle fejlstrenge. `deskuptime status` er read-only og foretager ingen netværkskald.
- `src/checkers/ssl.js` sender ikke længere SNI for IP-literal-værter. Node 24+ afviser det, hvilket brød SSL-udløbsvarselet for enhver HTTPS-monitorering på IP-adresse (P2-1 del A).
- `action.yml` verificerer sit resultat-payload før `down-count` beregnes, så et tomt eller mangelfuldt resultat ikke kan give en grøn kørsel (P2-1 del A).
- `tools/make_tarball.sh:14` udelader `src/checkers/headers.js`; `tools/install.sh:6` er fastsat til 0.1.4; npm/tarball/desktop-versioner er ikke synkroniserede.

## Prioriteret kø

### P0-1 — AFSLUTTET I DETTE REPO — Desktop sikkerhed (flyttet til privat repo)

**Begrundelse:** Den betalte desktopapp er kernedifferentieringen. Den daværende frontend kunne være uden Tauri-bridge, og remote script + rå nøgle gjorde webview'en tillidskritisk.

**Omfang:**

- Giv Tauri-v2 en verificeret global/local bridge og test den i en rigtig desktop-build.
- Ret frontendens IPC-DTO, så `CheckResultSummary` og manuelle checks bruger samme snake_case-contract som Rust.
- Fjern remote executable Tailwind-runtime; bundl lokal CSS eller en anden verificeret lokal asset. Stram CSP'en.
- Returnér en redigeret licens-DTO til frontend; hold rå nøgle i backend-lagring og aldrig i UI-state, events eller logs.
- Valider og canonicalisér kun `http`/`https` i Rust-backend; frontend-input må ikke være eneste barriere.
- Erstat URL-/result-interpolation med sikker DOM-rendering.

**Acceptkriterier for det offentlige repo:**

1. Malicious URL-streng med quotes, `<`, `>` og event-handler-tekst renderes som tekst og skaber ingen ekstra DOM-node eller request.
2. `get_license_state` og alle frontend-events har ingen `license_key`/rå nøgle.
3. Der er ingen remote script-kilde eller bred `script-src` i produktions-CSP.
4. IPC-regressionstest dækker reachable, down, status, timing, SSL-null og fejl.

**Privat follow-up:** Packet macOS-/Windows-smoke og persistence efter genstart blev ikke verificeret og er ikke acceptkriterier i dette offentlige repo; de skal verificeres i `mahope/deskuptime-desktop`.

**Status 2026-09-25:** Implementeret på `ceo/desktop-security`: Tauri bridge og lokal CSS uden remote executable assets, stram CSP, minimal event capability, canonical URL-validering i Rust, snake_case IPC, sikker DOM-rendering og redigeret licens-DTO. `npm test` var grøn med 32/32; `cargo check --locked` og `cargo test --locked` var grønne med 10 tests. `cargo tauri build --debug` byggede macOS-appen og DMG'en. Fresh review fandt ingen P1; stale event-resultater, URL-state-race og query-streng i notifikationer blev rettet.

**Lukning i offentligt repo 2026-09-25:** Commit `39c434f` flyttede desktopkilde, tests og workflows til `mahope/deskuptime-desktop`. Dette checkout har hverken desktopkilde eller byggetartefakt, så Windows/interaktiv smoke kan ikke udføres eller dokumenteres her troværdigt. P0-1 regnes som lukket for dette repo; licenslifecycle, desktop-paritet og Cargo/GTK-afhængigheder følger i det private repo.

**Fjernede filer:** `desktop/frontend/index.html`, `desktop/frontend/app.js`, `desktop/frontend/styles.css`, `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/capabilities/default.json`, `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/src/monitor.rs`, `test/desktop.test.js`.

### P0-2 — FÆRDIG — Ret offentlig runtime, lockfile og auditstrategi

**Begrundelse:** En reproducerbar npm-pakke og én understøttet runtime gør gratis-CLI'en nemmere at bygge, køre og auditere uden skjulte buildvalg.

**Scope:** Cargo/GTK-advisoryen og Tauri-gates er ikke offentlige CLI-opgaver; de følger i `mahope/deskuptime-desktop`. Denne iteration retter kun Node-runtime, lockfile og npm-audit.

**Acceptkriterier:**

1. `engines`, `.nvmrc`, CI, CLI-release, npm-publish, Action, README og curl-installer kræver Node 24.
2. En committed lockfil v3 gør `npm ci --ignore-scripts` reproducerbar; pakkens nul runtime-/dev-dependencies bevares.
3. CI og npm-publish kører `npm run audit`, som rapporterer 0 sårbarheder.
4. Node 18 → 24 er den eneste major-opgradering i committen; der er ingen npm-pakkemajor at opgradere, og ingen executable logik ændres. CLI-help og én kildekommentar opdateres, og help-regressionen dækkes.
5. Node under 24 giver en deterministisk fejl i installeren og den offentlige GitHub Action; alle interne og dokumenterede Action-forbrugere væller Node 24 først.

**Filer:** `.nvmrc`, `package.json`, `package-lock.json`, `.github/workflows/ci.yml`, `.github/workflows/release-cli.yml`, `.github/workflows/publish.yml`, `.github/workflows/self-monitor.yml`, `action.yml`, `tools/install.sh`, `README.md`, `src/cli.js`, `src/checkers/ping.js`, `test/test.js`.

**Status 2026-09-25:** Færdig på `ceo/runtime-audit`. Node 24.21.0, `npm ci --ignore-scripts`, 26/26 tests og `npm run audit` med 0 sårbarheder er grønne; YAML, shell, JavaScript-syntax og diff-check er grønne. Fresh review fandt ingen P0/P1; sidste P2-planfund blev rettet.

### P0-3 — FÆRDIG — Gør uptime-status og fejlhåndtering sand

**Begrundelse:** En 404/500 må ikke rapporteres som UP; det er den mest konkrete fejl i købs- og CI-flowet.

**Statuspolitik:** `reachable` betyder blot, at et HTTP-svar blev modtaget. `healthy` er sand kun for final status 200–399 efter redirects; 400–599, timeout, connection refusal og andre netværksfejl er DOWN. CLI-exit 2 og Action `down-count` følger `healthy`, ikke `reachable`.

**Acceptkriterier:**

1. Statuspolitikken er dokumenteret og centraliseret: `reachable` = svar modtaget og `healthy`/DOWN = final status `>=400`; Node CLI og Action bruger samme beslutning. Rust-pariteten følger i det private desktoprepo.
2. Deterministic lokale fixtures dækker 200, 204, redirect-til-200, 400, 404, 410, 500, timeout og connection refusal.
3. CLI JSON, human output, exit codes og Action `down-count` er enige for hver fixture. Desktop UI/notification-pariteten følger i `mahope/deskuptime-desktop`, efter at desktopkilden blev flyttet ud af dette offentlige repo.
4. Én ugyldig URL i en fler-URL-kørsel fejler konfigurationskørslen i stedet for at blive sprunget over.
5. `headers`-fejl returnerer et struktureret resultat og kan ikke crashinge output/loop.

**Status 2026-09-25:** Færdig i `5f8ff4c` på `ceo/status-semantics`. Lokale fixtures dækker 200, 204, redirect-til-200, 400, 404, 410, 500, redirect-til-500, timeout og connection refusal. CLI JSON/human/exit, watch-state og Action `down-count` bruger samme `healthy`-beslutning; CLI, engine og watch validerer hele batchen før request. Headers-fejl efter redirect bevarer origin-schema og er strukturerede. Node 24-gate: 32/32 tests, audit 0/0, syntax/diff grøn; fresh review fandt ingen P0/P1. Desktop Rust-pariteten følger i `mahope/deskuptime-desktop`.

### P0-4 — FÆRDIG — Gør watch-kommandoerne ægte

**Begrundelse:** README's cron-opskrift `watch --once` og statusvisning `watch --status` er aktive, men regressionen kan efterlade cron-processer kørende.

**Acceptkriterier:**

1. `watch URL --once` laver præcis én pass, gemmer state og afslutter med dokumenteret exit code.
2. `watch --status` laver nul netværkskald og ændrer ikke state ved blot at læse.
3. Første pass med DOWN siger enten DOWN-begivenhed eller “baseline recorded: DOWN”; “all monitored sites OK” er aldrig falsk.
4. Tre ens SSL-under-tærskel-pass giver én SSL-begivenhed; recovery og senere ny krydsning resetter korrekt.
5. Content- og status-transitionsekvenser er dækket af isolerede temp-HOME-tests.
6. `HOME`/`USERPROFILE` håndteres på Windows, og `--help` matcher README.

**Status 2026-09-25:** Færdig i `364ae0d` + `4e685df` på `ceo/watch-truth`. `watch URL --once` laver én pass, persisterer atomisk state og bruger exit 0/2/1; samtidige one-shot-processer afvises med exit 1 uden state-skrivning. `watch --status` laver nul requests og ændrer ikke state. Temp-HOME-tests dækker baseline DOWN, UP/DOWN-sekvenser, gemt content-hash, SSL 14 → unavailable → 14 → 15 → 14, fri URL-kapacitet, tomme flagværdier og intervalgrænse. Node 24.21.0: `npm ci --ignore-scripts`, 45/45 tests, audit 0/0, JavaScript-syntax og diff-check er grønne. Fresh review fandt to P1, tre P2 og ét P3; P1 race/flagfund samt free-limit/intervalfund blev rettet. Korrupt state håndteres fortsat som tom state og følger P0-7's valideringskrav; kanalclaim-pariteten følger P0-5.

### P0-5 — FÆRDIG — Skriv Pro-spec og gør produktobne ærlige

**Begrundelse:** Betalte brugere betaler i dag for en delvist manglende værdi; email/Slack/desktop-webhook er lovet, men kun generisk CLI-webhook findes.

**Før implementering:** `docs/pro-alerts.md` er oprettet med kanalmatrix, payloadschema, timeout/retry, auth/signering, offline-adfærd, pris/entitlement og privacy.

**Acceptkriterier:**

1. Én matrix bestemmer gratis/Pro for CLI one-off, CLI watch, desktop, tray/local notifications, ubegrænsede URLs, email, webhook, Slack/Discord/Teams, rapporter og batch.
2. Hver lovet kanal har implementering eller fjernes fra alle kundeflader; ingen “coming soon”-claim i købsflowet.
3. Gratisbrugere får en tydelig, ikke-forstyrrende upgrade-vej hvor de mangler funktionen.
4. Ét køb-link pr. side, kun det aftalte DeskUptime Pro-link; donationen forbliver diskret og bruges kun ved naturligt tak.
5. Specen er godkendt før en større Pro-implementering; ingen nye Stripe-produkter/priser.

**Fund og rettelser:**

- README lovede “Email/Slack/webhook alerts”; kun generisk webhook fandtes. Fjernet, og matrixen siger udtrykkeligt at email og Slack/Discord/Teams **ikke** er implementeret.
- CLI-hjælpen lovede “Email/push alerts”. Fjernet; push er nu præcist “lokal desktop-notification (macOS)”, og CLI'en siger det til Pro-brugere på Windows/Linux.
- **Fejlkøb-fund:** `--webhook` på en gratis konta skrev “Webhook alerts on.”, men `sendWebhook` var Pro-gated og aldrig kaldte. En gratisbruger troede han fik alarmer. Nu advares med købslink, banneren er ærlig, og terminalalerts fortsætter.
- **Robusthedsfund:** `fetch` til webhook havde ingen timeout, så et hangende endpoint kunne låse hele overvågningsloopet. Nu `AbortSignal.timeout(10s)`, `sendWebhook` returnerer true/false, ingen retry (dokumenteret best-effort).
- README pegede på `deskuptime.com` som downloadkilde. Domænet **er** live (HTTP 200 verificeret), men har ingen download; det reelle download er `github.com/mahope/deskuptime/releases/tag/desktop-v0.2.7` (macOS-arm64/x64 + Windows exe/msi, reelle downloadtal). README peger nu på releasen og har produkt-siden som link.
- Gratis-grænsen (3 URL'er) sagde “Run deskuptime activate” uden købsvej; den peger nu på det aftalte Stripe-link gennem én `upgradeHint()`.
- `package.json` `files` manglede `docs/`, så README's link til `docs/pro-alerts.md` ville være dødt i npm-pakken. Tilføjet.

**Status 2026-09-25:** Færdig i `4024d08` på `ceo/pro-claims`. `test/claims.test.js` (6 tests) og `test/webhook.test.js` (4 tests) er nye og låser claims, links, payload og timeout. Node 26.7.0: `npm ci --ignore-scripts`, 55/55 tests, audit 0/0, `node --check` og `git diff --check` grønne. Fast-forward-merge til `main` skete 2026-09-25T15:42:30Z. Den eksterne live-side har **sin egen** email-claim og følges i P0-12.

### P0-12 — 🔒 BLOCKED: sitens kilder ligger uden for dette repo og uden for agentens adgang

**Begrundelse:** `https://deskuptime.com/` er verificeret live 2026-09-25 og viser i sammenligningstabellen “Email and webhook alerts — — yes” for Desktop Pro, og skriver “Removes the three-site limit and adds email and webhook alerts.” Ingen email-implementation findes i CLI'en eller i den private desktop-kilde. Det er et køb, der ikke leverer, på den mest synlige kundeflade.

**Omfang:** Sidens kilder ligger uden for dette repo, så rettelsen kan ikke ske her. Find repoet (Cloudflare Pages-kilde til `deskuptime.com`) og ret claimen til matrixen i `docs/pro-alerts.md` §1.

**Acceptkriterier:**

1. Siden kun hævder de kanaler, der findes: webhook fra CLI-watch og lokale notifications i desktopappen.
2. Siden og README viser den samme gratis/Pro-matrix; afvigelser er løst, ikke forklaret.
3. Købsknappen er uændret: kun `https://buy.stripe.com/7sY9AS9eX3Iu418fJ5bMQ01`.
4. `llms.txt`, `/da/`-siden og sitemap har samme ærlighed som forsiden.
5. Hvis email besluttes implementeret, flyttes claimen tilbage samtidig med koden — aldrig før.

**Undersøgelse 2026-09-25 (evidence, første og eneste forsøg):**

- `deskuptime.com` svarer HTTP 200 og serveres via Cloudflare (`server: cloudflare`, `cf-cache-status: DYNAMIC`). Kilden er **ikke** i dette repo: checkout indeholder kun `.github/`, `action.yml`, `BUILD.md`, `DECISION.md`, `STATUS.md`, `docs/`, `package.json`, `src/`, `test/`, `tools/` — ingen site-kilde, ingen `_headers`/Workers-fil.
- Den eneste sandsynlige kilde er et andet lokalt checkout (`~/Projects/hermes/hermes-passiv` har et `deskuptime/`-underbibliotek). Læsning af den sti er blokkeret af agentens `external_directory`-tilladelse, så **placeringen er et formod, ikke et verificeret fund**. Ingen skrivning til et fremmed repo er udført.
- **Konklusion:** opgaven er ikke eksekverbar i denne loop og en gentaget iteration ville give samme resultat. Markeret `BLOCKED` efter ét forsøg i stedet for to, fordi evidensen er endelig, ikke blot forsøgt igen. Efter Mads' beslutning eller en tilladelse til det andet repo kan den genåbnes.
- **Konkrete ændringer, der skal foretages i site-kilden:**
  1. Sammenligningstabellen: “Email and webhook alerts” → “Webhook alerts” (eller “Webhook alerts + local notifications” for desktoprækken), så den kun hævder det, `docs/pro-alerts.md` §1 tillader.
  2. Pro-afsnittet: “adds email and webhook alerts” → “adds webhook alerts”.
  3. `/da/`-siden har i denne måling **ingen** email-claim, så dansk/engelsk er allerede uens; rettelsen skal gøre dem ens, ikke kun tilpasse engelsk.
  4. `llms.txt` nævner hverken email eller kanaler og er dermed ikke i strid — hold den sådan.
  5. Købsknappen (`buy.stripe.com/7sY9AS9eX3Iu418fJ5bMQ01`) er korrekt og uændret på den live side (verificeret 2026-09-25); rør den ikke.
- **Bemærkning til ❓-spørgsmål 2:** dette repo har nu konsekvent fjernet email fra alle overflader. Den eneste afvigelse er den eksterne side, som intet i dette repo kan rette.

### P0-6 — FÆRDIG — Ensret Windows device_id i CLI

**Begrundelse:** Åbent produktpunkt fra 24/9: CLI og privat desktop-app kan tælle én maskine som to pladser. Denne iteration kan kun rette og conformance-teste Node-generatoren.

**Beslutning:** Start med minimal fiks: CLI bruger ikke-tom `COMPUTERNAME` på native Windows og ellers `os.hostname()`. Skriv ikke eksisterende state-id om uden dokumenteret server-migration.

**Acceptkriterier:**

1. Deterministiske JS-tests dækker Windows precedence, non-Windows fallback, trim/lowercase, tom værdi og 128-tegns grænse.
2. Native Windows CI kører licenstest med Node 24.
3. Et versioneret Node golden fixture giver den tilsigtede id-generator; Rust-golden og fælles maskintest følger i `mahope/deskuptime-desktop`.
4. En eksisterende installation med et gammelt gemt id kræver en dokumenteret migrerings-/alias-proces i det private repo, før cross-client-opløsning erklæres færdig.

**Status 2026-09-25:** Færdig i `e344531` på `ceo/device-id-parity`. `getDeviceId({platform, env, host})` foretrækker nu en ikke-tom `COMPUTERNAME` på native Windows (tom, blank eller manglende falder tilbage til `os.hostname()`) og trimmer/lowercaser som før. `test/fixtures/device-id.golden.json` er en versioneret fixture (`version: 1`) med 12 tilfælde — Windows-precedence mod 15-tegns NetBIOS, tom/blank/manglende `COMPUTERNAME`, trim/lowercase, darwin/linux-ignore-`COMPUTERNAME`, `unknown`-fallback for begge platforme, 128-tegns afkortning og 128-tegns grænse — som `test/license.test.js` afprøver; Rust-siden skal køre mod samme fil. Ny CI-job `license-windows` kører licenstestene på `windows-latest` med Node 24. **Bevis:** mutationstest — reverteret til den gamle `os.hostname()`-adfærd giver 2 fejl i 16, genindsættet kode giver 16/16. Node 26.7.0: `npm ci --ignore-scripts`, 59/59 tests, audit 0/0, `node --check`, gyldig YAML/JSON og `git diff --check` grønne. Merge til `main` og push af begge grene 2026-09-25.

**Bevidst ikke gjort (til privat repo):** Ingen eksisterende `license.instance` omskrives — `refreshLicense` bruger stadig det gemte id, så ingen installation mister Pro. Acceptkriterium 4 (serverens migrering/alias for gamle id'er) og Rust-golden-pariteten er derfor **åbne** og skal afsluttes i `mahope/deskuptime-desktop`, hvor Rust-kilden ligger.

### P0-7 — FÆRDIG — Hårdgør licenslifecycle

**Begrundelse:** Betalende brugere må ikke låses ude ved timeout/5xx, men revoked/expired må heller ikke fortsætte at få Pro. Node-delen er offentlig; desktopdeactivation og Rust-timeouts følger i det private repo.

**Acceptkriterier:**

1. Node har hård total timeout, 429/408/5xx og malformed 200 håndteres som transient med syv-dages cached grace; Rust-kravet følger privat.
2. 403/404/409 og definitive invalideringer slår Pro fra med det samme; nøglen bevares til senere diagnose.
3. `status` viser `active`, `cached/offline`, `invalid` eller `free`, ikke bare "nøgle findes".
4. Desktop deactivation venter på serverens `deactivated: true` før lokal state slettes; denne accept testes i `mahope/deskuptime-desktop`.
5. Node state-/licensfiler er `0600` på POSIX, atomisk skrevet og valideres ved indlæsning; Rust gør det samme privat.
6. Rå nøgler, følsomme URL-query-strings og device-identiteter logges ikke.

**Fund og rettelser:**

- **Lockout-bug:** ethvert HTTP 200 blev behandlet som *permanent* afslag. En Cloudflare/captive-portal-HTML-side, en trunkeret proxy-svar eller `{ok:true}` uden `valid`-felt kunne derfor slå Pro fra for en betalende kunde. Nu er `malformed` et eget udfald: transient, aldrig permanent. Kun `200 {ok:true, valid:true|false}` er et verdikt.
- **Manglende timeout:** licenskald havde intet `signal`. Et hængende svar kunne hænge CLI'en og en cron-kørende watch-loop. Nu `AbortSignal.timeout(10s)` — verificeret med en rigtig lokal server, der aldrig svarer.
- **Fejlklassificering:** kun `>=500` var transient. `408`, `425` og `429` (throttling) gav permanent afslag. Nu transient.
- **Pro-låsning ved revocation:** `isPro()` så kun på `key` + `instance`, så en tilbagekaldt nøgle beholdt ubegrænsede URL'er og 30 s interval ind til næste reinstall. Nu giver `status: 'invalid'` ikke længere Pro.
- **Skriverejttigheder:** state-filen skrev `0600`, men mappen blev skabt med umaskens standardrettigheder, og en eksisterende `0644`-fil blev ikke strammet. Nu `0700`-mappe + eksplicit `chmod 0600` ved skrivning.
- **Uvalideret licensrecord:** `loadState` kopierede `license` ukritisk, så en håndredigeret state-fil med `{key:'x'}` gav Pro. Nu valideres recordet ved indlæsning (32 hex, device-id 1–128 tegn, kendt status); alt andet læses som "ingen licens".
- **Lækagevej:** en server, der ekkoer nøglen i `error`, skrev den ufiltreret til terminalen. Alle fejlstrenge passerer nu `redactSecrets()` (32-hex → `«key»`, `deskuptime-*` → `deskuptime-«device»`).
- **Ærlighed i `status`:** kommandoen sagde "Pro license: active" uanset hvad. Nu fire tilstande med forklaring, inkl. skelnen mellem "afslået af serveren" og "aldrig verificeret — serveren svarede ikke i 9 dage", så support ikke jager en ugyldig nøgle.
- **Deactivation:** CLI'en slettede intet ved fejl, men sagde intet om pladsen. Nu siges det eksplicit, at pladsen *ikke* er frigjort, og `deactivate` kræver `deactivated: true` (Rust gør det samme privat).

**Status 2026-09-25:** Færdig i `e13456b` på `ceo/license-lifecycle`, fast-forward-merget til `main` og pushet 2026-09-25. `docs/license-lifecycle.md` er source of truth med HTTP-klassificering, tilstandsmaskineri, lagring, redaction og en kravliste til Rust-siden. 23 nye tests (16 i `test/license.test.js`, 7 i `test/status.test.js`) dækker timeout mod en rigtig hængende server, 408/425/429/5xx vs. 400/403/404/409, tre former for malformed 200, de fire tilstande, legacy-state alder, filrettigheder, atomisk skrivning, record-validering og redaction. Node 26.7.0: `npm ci --ignore-scripts`, 82/82 tests, `npm run audit` 0/0, `node --check` alle filer og `git diff --check` grønne. Egen gennemgang før merge fandt to reelle fejl, som blev rettet og dækket af test: `200 {ok:true}` uden `valid`-felt faldt igennem som permanent afslag, og en gemt `cached`-status holdt Pro-løftet efter grace-periodens udløb. CLI'en er desuden kørt manuelt i alle fire tilstande. **Live-evidence:** et `validate`-kald mod den rigtige licensserver med en ukendt nøgle svarer `404 "License key not found…"` og klassificeres korrekt som permanent, ikke transient.

**Krav stillet til privat repo (ikke gjort her):** Acceptkriterium 4 (desktop-deactivation) og Rust-siden af 1, 5 og 6 afspejles i `docs/license-lifecycle.md` §5. Rust skal køre mod `test/fixtures/device-id.golden.json` og mod de samme HTTP-klassificeringer.

### P0-8 — PRIVAT REPO — Gør desktop-overvågning feature-paritet

**Begrundelse:** Desktop er betalt produkt; Rust beregner i dag content-hash uden at sammenligne den, og SSL/content-events mangler. Denne opgave ejes af `mahope/deskuptime-desktop`.

**Acceptkriterier:**

1. For hver URL gemmes forrige content fingerprint.
2. Baseline A, uændret B, ændret C og recovery A-A giver præcis reelle overgangsevents.
3. UI og native notification viser content/SSL-overgang; baggrundsmonitoret bruger samme entitlements som CLI.
4. Node/Rust conformance fixtures giver identisk hash- og ændringsbeslutning.
5. URL-fejl/timeouts kan ikke låse monitorloopen.

### P0-9 — I GANG (del A færdig) — Ret release- og distributionsvejen

**Begrundelse:** Nuværende curl-tarball mangler `headers`, installer peger på 0.1.4, og versionerne `0.2.8`/`0.2.7`/`0.1.4`/`v0.1` er modstridende.

**Målt fund 2026-09-25 (del A):** `bash tools/make_tarball.sh` **fejlede i sin egen self-check** — `SELF-CHECK FAILED: --version output wrong`, fordi den håndlavne filliste manglede `src/status.js` (statisk importeret af `engine.js`, `watch.js` og `cli.js`) og `src/checkers/headers.js` (dynamisk importeret af `headers`-kommandoen). Konsekvenser: (1) `release-cli.yml`'s build-step ville være rødt, så der **kan ikke skæres en ny `v*-cli`-release**; (2) en allerede installeret kopi døde med `ERR_MODULE_NOT_FOUND` på *første* kommando; (3) curl- og brew-stien var dermed døde. Versionsdrift målt: `package.json` 0.2.8, nyeste publicerede `v*-cli` er **v0.2.5-cli** (udgivet 2026-08-26), `tools/install.sh` peger på **0.1.4**, seneste npm-release er v0.2.8 (2026-09-07). `v0.1.4-cli` findes, så installeren 404'er ikke — den installerer bare en version, der ligger tre minorer under npm-versionen.

**Acceptkriterier:**

1. Én autoritativ version driver package, public CLI-metadata og installer/release-artefakter; Tauri/Cargo-versionen følger i det private desktoprepo.
2. Tarball indeholder alle dynamisk importerede runtime-filer, især `src/checkers/headers.js`.
3. Ekstraheret tarball består `--version`, `check`, `headers --json`, `watch --once`, `watch --status` og license-help.
4. Checksum publiceres og verificeres før install; Node-versionstjek matcher `engines`.
5. CI/release-triggerne har én owner pr. tagtype; ingen release/publish udføres af agenten.
6. npm-pakken, curl-stien og Homebrew-formlen dokumenteres med samme version og Stripe-link.

**Del A — FÆRDIG 2026-09-25 (`4defd8d`, `ceo/tarball-completeness`):**

- `tools/make_tarball.sh` kopierer nu hele `src/`-træet i stedet for en håndlavet filliste, så dynamiske og statiske imports ikke kan komme uden for pakken. De tre defensive `mv`-linjer, der var no-ops, er væk.
- Self-checken kører nu også `headers --json` og `watch --once` (de importerer checkere dovent) og skriver `deskuptime-<ver>.tar.gz.sha256` ved siden af tarballen.
- `test/tarball.test.js` (9 tests) kører det rigtige script mod en **lokal HTTP-server** — ingen `example.com`-afhængighed — og kører derefter den udpakkede kopi: `--version`, `check --json`, `headers --json`, `watch --once` + read-only `watch --status`, `--help` med Pro-vejledning, src-træ-paritet og checksum-sidecar. Springes på Windows (kræver sh/tar/gzip); `license-windows`-jobbet kører kun licenstestene.
- Scriptet kan skrive til en temp-mappe (`DESKUPTIME_TARBALL_DIR`) og self-checke mod en given URL (`DESKUPTIME_SELFCHECK_URL`), så tests ikke smider artefakter i repoet.
- `.gitignore` ignorerer nu `deskuptime-*.tar.gz` og `.sha256`, så byggeartefakter ikke kan committes ved et uheld.
- **Bevis:** før rettelsen fejlede scriptets egen self-check med `ERR_MODULE_NOT_FOUND … /src/status.js`; efter rettelsen er `npm test` grøn med **96/96** (87 + 9 nye), `npm run audit` 0/0, `node --check` og `git diff --check` grønne på Node 26.7.0.

**Del B — FÆRDIG 2026-09-25 (se P0-9b nedenfor).**

### P0-10 — FÆRDIG — Opgrader actions/checkout 4 → 7 i en commit

**Begrundelse:** CI-run `36105085970` markerer `actions/checkout@v4`s Node 20-runtime som deprecated. Dependabot PR #3 er ren og foreslår major 7; brugerkontrakten kræver én major-opgradering pr. commit.

**Acceptkriterier:**

1. PR #3 eller en tilsvarende minimal branch opgraderer kun `actions/checkout` 4 → 7.
2. Hele Node 24-gaten er grøn efter merge.
3. Ingen anden action-opgradering, release eller npm-publish følger med.

**Status 2026-09-25:** Færdig i `b27ba35` på `ceo/actions-checkout-v7`, fast-forward-merget til `main` og pushet. Alle seks `actions/checkout@v4` (ci.yml ×2, publish.yml, release-cli.yml, self-monitor.yml) → `@v7`; diffet er identisk med Dependabot PR #3. Ingen checkout-inputs bruges nogen steder, så opgraderingen er en ren pin-bump. **Brydende ændring siden v4:** v7.0.0 blockerer checkout af fork-PRs for `pull_request_target` og `workflow_run` — ingen af repoets workflows bruger de triggere. v6 flyttede desuden persistents credentials til en separat fil, hvilket er internt i actionen. `actions/setup-node` er bevidst urørt (P0-11). **Bevis:** Node 26.7.0 — `npm ci --ignore-scripts`, 82/82 tests, `npm run audit` 0/0, YAML-parse af alle fem workflows og `git diff --check` grønne; CI-run `36169872603` på `b27ba35` grøn i begge jobs med `actions/checkout@v7`-steps.

### P0-13 — FÆRDIG — Ret falsk DOWN når serveren ikke svarer på HEAD

**Begrundelse:** Selvmonitoreringen har været rød hver 3. time siden mindst 2026-09-25 kl. 17:14 UTC. Run `36165886470` rapporterede `https://eucomply-scan.mahope-eeb.workers.dev/stats` som `HTTP 404 / DOWN`, mens både `curl` og `node -e fetch()` svarede **200** på samme URL. Reachability-checket sendte udelukkende `HEAD`; Cloudflare Workers matcher kun GET-routes og svarer derfor 404 på HEAD. Et sunde site blev meldt nede, hvilket er missionens prioritet 1 og samtidig ødelægger repoets egen alarm.

**Acceptkriterier:**

1. Et HEAD-svar med 404, 405 eller 501 genforsøges én gang med GET, og GET-svaret er det dominerende.
2. En route, der er 404 på både HEAD og GET, er stadig DOWN med `errorType: 'http_error'`; 400/410/500 og redirect-til-fejl er uændrede.
3. Et sundt HEAD-svar sender stadig præcis ét request — fallbacken må ikke gøre almindelige sites dyrere.
4. `--timeout` er et budget for hele checket, ikke pr. request, så worst case ikke fordobles; GET-bodyen annulleres straks, da kun statuslinjen bruges.
5. Deterministiske lokale fixtures dækker 404/405/501-fallback, dobbelt-404, intet retry ved sundt HEAD og det delte timeout-budget; ingen test mod `example.com` for denne adfærd.
6. Bevis mod den rigtige worker: 404 før rettelsen, 200 efter.

**Status 2026-09-25:** Færdig i `1d19697` på `ceo/head-get-fallback`, fast-forward-merget til `main` og pushet 2026-09-25. `src/checkers/ping.js` har nu `request(url, method, signal)` og `HEAD_UNSUPPORTED = {404, 405, 501}`; `remainingMs()` giver retryen kun resten af budgettet. Fem nye tests i `test/status.test.js`. Node 26.7.0: `npm ci --ignore-scripts`, **87/87** tests, `npm run audit` 0/0, `node --check` og `git diff --check` grønne. Den eksisterende statusmatrix-test (200/204/400/404/410/500/redirect/timeout/refused) er uændret grøn, så ægte fejl er ikke maskeret. Manuel verifikation: `node src/cli.js check https://eucomply-scan.mahope-eeb.workers.dev/stats` gav 404 DOWN før og **200 UP, exit 0** efter. Selvmonitoreringen bruger `uses: ./` og henter den mergede kode, så næste cron-kørsel (`17 */3 * * *`) bærer rettelsen automatisk — ingen deploy-note nødvendig.

### P0-11 — FÆRDIG — Opgrader actions/setup-node 4 → 7 i en commit

**Begrundelse:** CI-run `36105085970` markerer `actions/setup-node@v4`s Node 20-runtime som deprecated. Dependabot PR #2 er ren og foreslår major 7; den skulle merge separat efter P0-10.

**Acceptkriterier:**

1. PR #2 eller en tilsvarende minimal branch opgraderer kun `actions/setup-node` 4 → 7.
2. Hele Node 24-gaten er grøn efter merge.
3. Ingen anden action-opgradering, release eller npm-publish følger med.

**Status 2026-09-25:** Færdig i `6761f26` på `ceo/actions-setup-node-v7`, fast-forward-merget til `main` og pushet. Fem pin-bumps (`ci.yml` ×2, `publish.yml`, `release-cli.yml`, `self-monitor.yml`) — identiske med Dependabot PR #2's filer — plus README's forbruger-snippet, som PR #2 ikke rører, så kopieringsstien ikke længere peger på den deprecated runtime. **Brydende ændringer siden v4, gennemgået:** v5 slår automatisk cache til, når `package.json` har et gyldigt `packageManager`-felt — dette repo **har intet sådant felt** (verificeret), så ingen caching-adfærd ændres; v6 begrænser automatisk caching til npm — irrelevant uden `packageManager`; v7 fjerner den dummy-`NODE_AUTH_TOKEN`-eksport. `publish.yml` sætter selv `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` i sit publish-step (publish.yml:52-55), så fjernelsen er tryg og kun fjerner en tom streng, der ellers kun kan forvirke `npm publish`. Der bruges ingen `cache:`-input nogen steder, og ingen `uses:` i `action.yml` rammes. Node 26.7.0: `npm ci --ignore-scripts`, **87/87** tests, `npm run audit` 0/0, YAML-parse af alle fire workflows, ingen tabs, `git diff --check` grønne. CI-run `36174538867` på `6761f26` grøn i begge jobs (`test` på ubuntu, `license-windows` på windows-latest) med `setup-node@v7`. Dependabot PR #2 er nu overflødig; agenten foretager ingen writes mod PR'er.

### P0-9b — FÆRDIG — Én version i installér og verificeret checksum

**Begrundelse:** Del A gjorde tarballen komplet, men to huller lukkes ikke af sig selv, og begge rammer den kurve, der installerer med `curl | bash`. Målt 2026-09-25: `tools/install.sh:6` har `VERSION="0.1.4"`, mens `package.json` er 0.2.8 og den nyeste publicerede `v*-cli` er v0.2.5-cli. Installéreren kan altså ikke få den version, README's curl-sti ligner på, og ingen published checksum verificeres før udpakning (AC4 i P0-9).

**Beslutning truffen:** selvopdaterende opløsning af den nyeste publicerede `v*-cli`-release via det offentlige, read-only GitHub-releases-API (ingen token) **med** indbygget fallback-version. En hard-pinned version ville drifte igen ved næste release, hvilket var årsagen til fundet. `DESKUPTIME_VERSION` kan låse en version, og `DESKUPTIME_NO_RESOLVE=1` tvinger fallback'en.

**Fund under implementeringen:**

- **Manglende checksum overalt:** ingen publiceret release har et `.sha256`-asset (verificeret mod alle 12 releases). Derfor kan "verificér eller dø" ikke være standard endnu — en hard fejl ville have slået *hver* curl-install ihjel, længe før en ny release skæres. Løsningen er gradueret: **afvigende sum = deterministisk fejl og intet installeres** (AC2), **manglende sidecar = tydelig advarsel** som standard og hård fejl med `DESKUPTIME_REQUIRE_CHECKSUM=1`. Så snart Mads skærer næste `v*-cli`-release med den nye workflow, er verificeringen altid på.
- **Release uden tarball:** `v0.2.8`, `v1`, `v0.2.6-desktop` m.fl. har hverken `-cli`-suffix eller CLI-asset. Opløseren accepterer derfor kun `^v\d+\.\d+\.\d+-cli$` **og** kræver et `deskuptime-<ver>.tar.gz`-asset, og vælger højeste semver, så GitHubs rækkefølge ikke afgør resultatet. Drafts og prereleases springes over.
- **Gammel fil overlevede opgradering:** installeren gjorde `cp -R "$TMP/src" "$LIB_DIR/"`, altså *merge*, så en fil fra en tidligere version blev liggende i den nye installation. Nu `rm -rf` af `lib/deskuptime` før kopiering.
- **Node-kravfejlen var dupliceret:** to hårdkodede "Node.js 24+ is required"-strenge. Nu én konstant `REQUIRED_NODE_MAJOR` og én `node_too_old()`, som en test håndhæver.
- **Flyt:** `node -e` kræves for API-parsingen, så Node-kravet er flyttet **før** versionsopløsningen (ellers ville et gammelt Node falde tilbage på versionen og så dø med en uforklarlig 404).

**Acceptkriterier:**

1. `install.sh` installerer en version, der faktisk findes som `v*-cli`-release, og siger tydeligt hvilken version den fik.
2. Checksum verificeres mod den publicerede `.sha256` **før** udpakning; en afvigende sum giver en deterministisk fejl og intet installeres.
3. Node-versionstjekket i installéreren matcher `engines` (`>=24`) — i dag to hårdkodede beskeder, der skal stamme fra én kilde.
4. `release-cli.yml` uploader `deskuptime-<ver>.tar.gz` **og** `.sha256` i samme step, så AC2 er opfyldt uden manuel handling.
5. En deterministisk test dækker installationsstien (versionsopløsning og checksum-verifikation) uden netværksafhængighed; den må fejle mod en manipulér sum.
6. `brew`-formlen, npm-pakken og README's curl-sti peger på samme version, og ingen release/publish udføres af agenten.
7. Bemærk til P2: det committede `deskuptime-0.1.3.tar.gz` i repo-roden er et gammelt byggeartefakt (10 KB gammel kildekode i det offentlige repo). Bør fjernes — ikke gjort her, da det er et unlink uden for denne opgaves omfang.

**Status 2026-09-25:** Færdig i `711d3b8` på `ceo/install-version-checksum`. `tools/install.sh` er skrevet om til POSIX `sh` med `die`/`note`, opløser nyeste `v*-cli`-release med tarball-asset, verificerer sha256 før `tar -xzf`, erstatter i stedet for fletter den forrige installation, og nægter en tarball uden `src/cli.js`. `release-cli.yml` uploader nu begge assets i samme step, fejler hvis sidecaren mangler, og `diff`-er sidecaren mod `sha256sum` før upload. Det gamle, forkerte `deskuptime-0.1.3.tar.gz` er fjernet fra repo-roden (`.gitignore` dækkede det allerede). `test/install.test.js` (9 tests) kører det rigtige script mod en lokal HTTP-server: opløsning med 6 forskellige releasetyper i vilkårlig rækkefølge, manipulations-afvisning, manglende sidecar i begge modi, pin, fallback ved ulæseligt feed, erstatning af gammel installation, tarball uden cli.js, gammel-Node-fejl og versions-driftstest mod `package.json`/`engines`. **Bevis:** Node 26.7.0 — `npm ci --ignore-scripts`, **105/105** tests, `npm run audit` 0/0, `node --check` alle JS-filer, `sh -n`/`bash -n`, YAML-parse af alle workflows, ingen tabs og `git diff --check` grønne. **Live-evidence:** `sh tools/install.sh` mod den rigtige GitHub-feed installerede **0.2.5** (den faktisk nyeste `v*-cli`-release) i stedet for den hårdkodede 0.1.4, og advarede korrekt, at 0.2.5 endnu ikke har en publiceret sidecar.

### P1-1 — FÆRDIG (del A + del B) — Hæd dokumentation, konvertering og åben kerne

**Begrundelse:** Kunder skal kunne forstå gratis/Pro, købe med ét link og bruge den samme truthful beskrivelse på README, CLI-help, npm, desktop og site.

**Acceptkriterier:**

1. Én versionsstyret featurematrix bruges på alle overflader. — **Del A færdig**
2. README/help retter `watch` og kanalclaims, og beskriver præcist hvilken data der sendes til licenserveren. — **Del A færdig**
3. Produkt-sidekilder eller en dokumenteret source-of-truth findes; EN/DA/llms/npm/UI bliver konsistente. — **BLOCKED på ❓ 8** (sitens kilder ligger uden for repoet)
4. Det eksisterende Stripe-link (`https://buy.stripe.com/7sY9AS9eX3Iu418fJ5bMQ01`) og donation-linket bruges konsistent, uden nye produkter. — **Del A + B færdig**
5. `❓`-beslutninger om email, gratis desktoptray, rapport/status-side og prioriteret support er besvaret før konkrete claims låses. — **afventer ❓ 1–3** (del B besvarer alene ❓ 9 i kode)

**Del A — FÆRDIG 2026-09-25 (`ceo/feature-matrix-source`):**

- **`src/features.js` er ny source of truth:** produktnøgle, pris, maskiner, købs-/donations-/API-links, de håndhævede gratis- og Pro-grænser, 14 matrixrækker på EN + DA med `implemented`-flag, samt de præcis tre felter der sendes til licenserveren.
- **Overfladerne renderer fra den:** `deskuptime --help` (`renderHelpPro()`), README-matrixen og `docs/pro-alerts.md` §1 + §5 (`tools/matrix.mjs` skriver blokke mellem `<!-- BEGIN/END GENERATED: … -->`; `npm run matrix` opdaterer, `--check` fejler ved drift).
- **Koden håndhæver det samme:** `src/watch.js` bruger `FREE.urlLimit`/`FREE.minIntervalSeconds`/`PRO.minIntervalSeconds` i stedet for egne tal, og `src/license.js` henter `PRODUCT.key`/`buyUrl`/`licenseApiBase`.
- **Konverteringshul lukket:** `watch --once` nåede gratisgrænsen med `Free tier monitors 3 URLs. … not added.` og **uden købslink**, mens watch-loopen havde `upgradeHint`. Begge bruger nu `freeLimitMessage()`.
- **Hjælpebanneret er rettet** til en bredde, der følger versionen (var 6 tegn for smalt).
- **README:** ny sektion "What leaves your machine" med genereret felt-tabel + "Aldrig: overvågede URL'er, sideindhold, …", og en note om hvorfor ikke-byggede kanaler står i spec'en frem for i README.
- **Test:** ny `test/matrix.test.js` (8 tests) — `matrix.mjs --check`, alle rækker i begge sprog, ikke-byggede kanaler uden for README/`--help`, hjælpegenberegning, licensfelter, gratisgrænse mod en færdig `state.json` (ingen netværk), intervalhævning mod lokal HTTP-server, kontraktlinks + `FUNDING.yml`. `test/claims.test.js` låser nu mod `MATRIX` i stedet for håndskrevne strenge.
- **Mutationstest:** ændrede `FREE` i `src/features.js` → 3 fejl; håndredigeret README-tabel → 2 fejl. En håndskrevet tabel kan altså ikke overleve.
- **Bevis:** Node 26.7.0 — `npm ci --ignore-scripts`, **113/113** tests, `npm run audit` 0/0, `node --check` alle JS-filer, `sh -n`/`bash -n`, YAML tab-fri, `git diff --check` grønne. `node tools/matrix.mjs --check` grøn. Ingen afhængighed ændret.

**Del B — FÆRDIG 2026-09-25 (`eb2b134`, `ceo/status-unverified`):**

- **❓ 9 besvaret i kode, ikke i ord:** `unverified` er det femte ord i `deskuptime status`. Det er tilstanden "licensserveren har ikke svaret i over 7 dage" — altså en nøgle, der **aldrig** er afslået. Før hed den `invalid`, hvilket læses som "din nøgle er død", og det er præcis den besked, der får en kunde til at købe en licens to gange. Derfor: egen statusværdi, egen tekst ("the key was never rejected"), og **intet købslink i den tilstand** — kunden har allerede betalt, så vejvisningen er `deskuptime activate <key>`. `invalid` betyder nu alene "serveren afslog nøglen", og det er den eneste tilstand, der viser kassen.
- **Pro-gating hærdet samtidig:** `isPro()` brugte en deny-liste (`status !== 'invalid'`), så den nye `unverified`-tilstand ville automatisk have givet Pro. Den er nu en allow-liste (`active`, `cached`) plus legacy-caset uden status-felt, så en fremtidig status aldrig kan give rettigheder ved et uheld, og installationer fra før status-feltet stadig virker indtil næste check.
- **npm-listen er den tredje genererede overflade:** `renderNpmDescription()` bygger beskrivelsen af `PRODUCT` + de implementerede Pro-rækker, og `tools/matrix.mjs` skriver den ind i `package.json` (JSON-target uden BEGIN/END-markører). En kanal, der ikke er bygget, kan derfor ikke længere loves på npm-siden, og `npm run matrix --check` fanger drift.
- **Ét købsflow pr. side er nu en test:** alle `buy.stripe.com`-links i README, `docs/pro-alerts.md`, `src/features.js`, `src/watch.js` og `package.json` skal være kontraktens link, og de overflader, der skal kunne købe (README, spec, `--help`), skal have mindst ét. Målt før: 12 forekomster af kontraktens link, 0 af andre — intet at rette, kun nu låst.
- **Test:** +5 (`test/license.test.js` 4 nye, `test/matrix.test.js` 2 nye, `test/status.test.js` 1 udvidet) → **118/118**. Mutationstest: at skrive `UNVERIFIED` tilbage som `INVALID` i `refreshLicense` giver 1 fejl i licenstesten (og CLI-testen). `docs/license-lifecycle.md` §2 er skrevet om til fem tilstande med begrundelsen og Rust-kravet.

### P1-2 — I GANG (del A + del B + del C færdig) — Byg dokumenteret Pro-værdi for bureauer

**Begrundelse:** Efter korrekt grundfunktionalitet er batch/status-side, flere lokationer, kunderapport og prioriteret support de næste tydelige betalingsmotiver.

**Acceptkriterier:**

1. Spec i `docs/` beskriver målgruppe, datamodel, privacy, report-format, eksport og pris/entitlement. — **Del A færdig** (`docs/agency-report.md`)
2. En minimal rapport/status-side kan genereres fra eksisterende checks og deles uden konto. — **Del B færdig** (`deskuptime report`)
3. Batch/automatisering har idempotente jobs, tydelig kørselstatus og testbare grænser. — **del C færdig for historikken** (30-dages vindue, `--days`, idempotent pr. døgn: skrive igen i samme bucket kan ikke double-tælle); **planlagte rapporter/flere lokationer kræver stadig ❓ 2 + ❓ 3**
4. Rapporter, webhook-events og kundelinks har dokumenterede retention-/redaction-regler. — **Del A færdig for rapporten** (spec §3: ingen licensnøgle, intet indhold, ingen upload); webhook-reglerne lå allerede i `docs/pro-alerts.md` §4
5. Ingen betalt fil eller privat kundedata committes til dette offentlige repo. — **Del A + B færdig** (kun kode + spec; rapporten genereres lokalt og committes aldrig)

**Del A + del B — FÆRDIG 2026-09-26 (`ceo/agency-report`):**

- **Hvorfor denne opgave først:** den gratis CLI kunne ikke levere noget, et bureau kan sende til en kunde. Uptime-tal lå i `state.json` uden nogen måde at vise dem, og matrixen lovede "delelig status-side / kunderapport" som *Planlagt* — altså et betalingsmotiv der ikke fandtes. Konverteringsprioriteten (ét købsflow pr. side) og Pro-værdien pegede i samme retning.
- **`src/report.js` (ny):** `buildReport(state)` læser **kun** `state.urls` — `state.license` er ikke læst, så licensnøglen kan ikke nå en fil, der forlader maskinen. `renderReportMarkdown()` giver en kundetabel (Site/Status/Uptime/Response/SSL/Last check) med **DOWN-sites først**, `renderReportJson()` ren JSON til CI. `recordPass()` er skriveren, `uptimePercent()` er læseren, og de to kan ikke blive uvede om definitionen.
- **Uptime er ærlig:** `checksUp / checks`, defineret ét sted. **Ingen gennemførte passes giver `null` → `—`, aldrig 100 %.** En håndskrevet eller halvskrevet state (`checks: "many"`, `checks: -3`) giver `null`/0, ikke `NaN`.
- **To heltal pr. URL** (`checks`, `checksUp`) + `lastResponseMs`, skrevet i den rigtige `runPass` — state-filen kan altså ikke vokse med overvågningshistorikken. Før dette viste ingen overflade disse tal.
- **Reel fejl fundet af min egen test:** `cell()` escaped pipes og `<>`, men ikke **newlines** — en URL med et newline i sig (f.eks. fra en skrapet konfiguration) sprængte Markdown-tabellen i to rækker og kunne indsætte en falsk tabelrække i en kunderapport. Nu flades alle linjeskift, og testen fanger det.
- **Pro-gate med ét købsflow:** `report` kræver `isPro(state)` (samme allow-liste som resten, så `unverified`/`invalid` aldrig får rapport — testet for begge). Uden licens skriver kommandoen **intet** på stdout og peger på kontraktens købslink. Gratisbrugere beholder `watch --once` og `status` som tekst.
- **Matrixen låst:** rækken `status-page` er `implemented: true` / Pro-only, så `npm run matrix` skrev den ind i README, `docs/pro-alerts.md`, `--help` **og** npm-beskrivelsen (nu 196 tegn, under de 200 kravet). En kanal der ikke er bygget kan dermed ikke længere være "Planlagt" i README, og en bygget kan ikke forblive det.
- **Test (12 nye, `test/report.test.js`):** uptime-matematik inkl. nul/ugyldige tællere, `recordPass` på legacy-state, den **rigtige** `runPass` med fire stubbede passes (75 %), problem-first-sortering, at `|`/`<script>`/newline i en URL ikke kan ødelægge tabellen, at licensnøglen hverken kan nå Markdown eller JSON (inkl. at ingen rapportfelt ligner licensdata), fri bruger → exit 1 + købslink + tom stdout, `unverified`/`invalid` → ingen rapport, `--json`/`--title`/tom state/ugyldige flag, og titelflatning.
- **Mutationstest:** at slette `recordPass(entry, result)` fra `runPass` giver 1 fejl i 12 (tællertesten); at gøre Pro-gaten væk giver fejl i gaten.
- **Bevis:** Node 26.7.0 — `npm ci --ignore-scripts`, **`npm test` grøn med 136/136** (124 + 12), `npm run audit` 0/0, `node --check` alle JS-filer, `node tools/matrix.mjs --check`, `git diff --check` grønne. Ingen afhængighed ændret.
- **Del C — FÆRDIG 2026-09-26 (`ceo/report-history`):**

  - **Hvorfor:** `Uptime (all)` er et svagt bevis i en kunderapport. Et site overvåget siden marts har "100 % siden start", som siger intet om den seneste måned — og det er præcis den periode bureauet skal kunne dokumentere. Matrixen lovede *delelig status-side / kunderapport* som implementeret, så rapporten skulle kunne svare på det spørgsmål.
  - **Ny `src/history.js`:** dags-buckets pr. URL i `~/.deskuptime/history.json`, hver bucket **to heltal** (`checks`, `failures`). En fejlet pass tæller i nævneren (passet kørte); døgn er UTC, så 23:30 og 00:30 ikke lander i samme bucket. Filen er en **anden fil** end `state.json`, fordi state skrives hvert pass og rummer licensnøglen, mens historikken vokser med tiden — blandede man dem, blev state uafgrænset og lagde tællere ved siden af nøglen.
  - **Begrænset ved konstruktion:** `HISTORY_DAYS = 35` (30-dages vindue + 5 dages slæk), `MAX_HISTORY_URLS = 500`, og `pruneHistory()` kører ved hver skrivning, så et år i en loop giver en fast, lille fil. URL'er uden et døgn i vinduet glemmes; de nyeste bliver ved URL-loftet.
  - **Ærlig visning:** `window` er `null` for et site uden ét registreret døgn i vinduet → `— (no pass in the last 30 d)`, **aldrig 100 %** (mutationstest M3). Uptime-definitionen er `report.js`'s `uptimePercent()` — samme funktion som livstidstallet, så de to kan ikke komme i uoverensstemmelse. Et døgn i *fremtiden* tæller ikke med.
  - **`--days N` (1–35):** afløser det faste 30. Uden for intervallet fejler kommandoen med en besked, der siger hvorfor, i stedet for at ignorere tallet; `-1` afvises som et ukendt flag. Større tal kan aldrig se ud som mere historik, end der findes.
  - **Optages for alle tiers:** historikken er to heltal pr. site pr. døgn, og en gratisbruger der opgraderer skal ikke starte en 30-dages rapport med en tom måned. Det er *rapporten* der er Pro, ikke optagelsen.
  - **Fejl må ikke dræbe overvågningen:** skrivningen er pakket i try/catch med én advarsel på stderr. Bevis: en mappe hvor `history.json` skal ligge får `runPass` til at fejle i stedet for at færdiggøre passet — testen fejler på den muterede kode (M4) og er grøn på den rigtige.
  - **Test (17 nye, `test/history.test.js`, ingen netværk):** historikken ligger ved siden af state på linux/darwin/win32 og **følger en omdirigeret state-fil** (så ingen test kan skrive i den rigtige home), UTC-bucketting, bucket-indhold (ingen hash/status/fejltekst), 35-dages pruning + 500-loft, håndskrevet/halvskrevet historik hvor `failures > checks` ikke kan give **negativ** uptime, filrettigheder `0600`/`0700` + atomisk skrivning + korrupt fil læses som tom, at en dag med ufuldstændig historik tæller kun de registrerede døgn, at `--days` afvises for 6 værdier, og at en nøgle ikke kan lække til CLI-rapporten.
  - **Mutationstest (4):** `runPass` uden `recordHistoryPass` → 1 fejl; `pruneHistory` gjort til no-op → 2 fejl; manglende vindue vist som `100%` → 2 fejl; historifejl kastet videre → filen fejler.
  - **Bevis:** Node 26.7.0 — `npm ci --ignore-scripts`, **`npm test` grøn med 167/167** (150 + 17), `npm run audit` 0/0, `node --check` alle JS-filer, `node tools/matrix.mjs --check`, `sh -n`/`bash -n` og `git diff --check` grønne. Ingen afhængighed ændret. Matrixens `status-page`-række er uændret, så ingen ny kanal og ingen ny claim; `--help` nævner `--days`, og detaljerne står i `docs/agency-report.md` §2b/§4/§7.

- **Ikke bygget (bevidst, i spec §7):** hostet status-side med offentligt URL (kræver server + domæne + ❓ 3), dags-tidsserie/graf pr. site, kalenderperioder ("august 2026"), fakturalayout/logo, dansk rapporttekst, planlagte rapporter.

### P2-1 — I GANG (del A + del B + del C færdig) — Hæd deterministiske tests og drift

**Begrundelse:** Nuværende Node-tests er delvist live-netværksafhængige, og Action-smoke-assertionen kan ikke fejle på `false`.

**Målt fund 2026-09-25 (del A):** (1) `test/test.js` har fire live-afhængige tests mod `https://example.com` — UP+SSL, `--json`, `headers`-redirect og `watch`-start; de fejler på en dårlig internetforbindelse, på en proxy der svarer 403, eller når `example.com` er langsom, og de beviser intet om vores egen kode. (2) `watch`-testens `assert.equal(exitCode, null)` **kan ikke fejle**: promise'en resolver `null` både når børnen dræbes efter "Monitoring" og når 8 s-timeren løber ud, så assertionen er vakuum. (3) Action'en **tæller uden at verificere**: `DOWN_COUNT` er bare `r.filter(x => !x.healthy).length`, så et tomt array (`[]`), en manglende `healthy`-nøgle eller færre resultater end bestilte URL'er giver `down=0` og **grøn kørsel** — præcis den fejl, der ville få en bruger til at tro et overvåget site er sundt.

**Acceptkriterier:**

1. Lokale HTTP/TLS-fixtures erstatter afhængighed af `example.com` i unit/integrationstests. — **Del A**
2. Node- og Action-resultater dækkes af den samme statusmatrix. — **Del A**
3. Der tilføjes timeout-, body-size-, webhook- og license-retrytests. — **Del B** (timeout og webhook dækkedes allerede af del A)
4. Action bruger `jq -e` eller en assertion, der faktisk fejler ved forkert resultat. — **Del A**
5. Den offentlige Node-gate udvides kun hvis nye værktøjer eller konkrete fejl gør det nødvendigt. — **Del B: ingen nye værktøjer, kun `node --check` på de rørte filer; del C tilføjer ét testfile og ingen afhængighed**

**Del A — FÆRDIG 2026-09-25 (`ceo/deterministic-tests`):**

- **Reel P0-fejl fundet og rettet undervejs:** `src/checkers/ssl.js` sendte altid `servername: hostname` til `tls.connect`. Node 22 advarede kun (DEP0123), men **Node 24+ kaster** — og Node 24 er `engines`-kravet. Hvert HTTPS-monitorering **på en IP-adresse** (VPS, interne servere, `https://127.0.0.1/`) fik derfor `SSL: ERR: The property 'options.servername' Setting the TLS ServerName to an IP address is not permitted` i stedet for udløbsdagene. Følger i Action'en: `sslError` er sat og `healthy` er sand, så et **sundt** site blev rapporteret som SSL-fejl. Nu sendes SNI kun for værtsnavne (`net.isIP(hostname)`), hvilket er RFC 6066-korrekt. Certificeringen af fejlen: den nye TLS-fixture fejlede først med præcis denne besked.
- **Ingen live-netværksafhængigheder mere i `test/test.js`:** de fire tests mod `https://example.com` (UP+SSL, `--json`, `headers`-redirect, `watch`-start) kører nu mod en lokal `node:http`-fixture, der serverer `/redirect` → `/final` med HSTS. Tilføjet er en rigtig **TLS-fixture**: et selvsigneret cert genereres pr. kørsel med `openssl` i en temp-mappe, og `NODE_EXTRA_CA_CERTS` gør `fetch` betro netop det cert (ingen global `NODE_TLS_REJECT_UNAUTHORIZED`). Testen springes pænt over, hvis `openssl` mangler. Før: UP-claimet kom fra et site vi ikke ejer; nu kommer SSL-dagene fra et cert vi netop har lavet.
- **Vakuum-assertion rettet:** watch-testens `assert.equal(exitCode, null)` kunne ikke fejle, fordi promise'en resolver `null` både når børnen dræbes efter "Monitoring" **og** når 8 s-timeren løber ud. Nu skelnes `started` (vi dræbte den) fra `exited by itself` (den døde alene) — hvilket er den fejl, regressionen egentlig ville fange.
- **Action'en tæller ikke længere uden at verificere (AC4):** før var `DOWN_COUNT` bare `r.filter(x => !x.healthy).length`, så et tomt resultatarray, en manglende `healthy`-nøgle eller færre resultater end bestilte URL'er gav `down=0` og **grøn kørsel** — det vil sige et bruger-troende "sunt" site. Nu valideres payloaden før tællingen: gyldig JSON, array, mindst ét resultat, **resultatantal = bestilt URL-antal** (fra `DU_EXPECTED_URLS=${#URL_LIST[@]}`), hvert resultat med ikke-tom `url`-streng og boolsk `healthy`. Alt andet fejler med `::error::` og exit 1.
- **Nye tests (6):** `test/status.test.js` får (a) fem payload-cases gennem en stub-CLI i et midlertidigt `GITHUB_ACTION_PATH` — tomt array, manglende/streng-`healthy`, manglende `url`, ikke-array, ikke-JSON — alle skal fejle med exit 1; (b) færre resultater end URL'er skal fejle; (c) `fail-on-down: 'true'` skal give **exit 2** med `down=2`; (d) alle sunde URL'er skal give exit 0 med `down=0`. `test/test.js` får TLS-CLI-testen og en `checkSSL`-unittest på IP-literal. Dermed dækkes Node **og** Action af den samme statusmatrix på den sunde og den usunde side.
- **Mutationstest:** at genindsætte `servername: hostname` giver 2 fejl i 16 i `test/test.js`; at slette valideringsblokken i `action.yml` giver 2 fejl i 32 i `test/status.test.js`.
- **Bevis:** Node 26.7.0 — `npm ci --ignore-scripts`, `npm test` grøn med **124/124** (118 + 6), `npm run audit` 0/0, `node --check` alle JS-filer, `sh -n`/`bash -n` (også det udpakkede action-script), YAML tab-fri og `git diff --check` grønne. `test/test.js` kører nu på ~1,2 s uden netværk.
- **Sidste live-afhængighed i gaten væk:** CI-smoken kørte `check https://example.com --json | jq -e`, så et site Mads ikke ejer kunne gøre repoets egen gate rød — og den testede kun den sunde side. Den kører nu mod en lokal fixture med både en 200- og en 500-route og fire `jq -e`-assertions (antal, UP, DOWN, statuskode), så jq både *kan* fejle og fejler på en fejl. Bevis: step'en er kørt lokalt grøn, og med `.[1].healthy == true` i stedet for `false` fejler den (jq exit 1 → `set -e`).
- **Bemærk til AC1/AC3:** HTTP- og TLS-fixtures er på plads (AC1). Timeout-dækning findes allerede (`--timeout` i statusmatricen, `/hang`-ruten, licens-timeout mod en rigtig hængende server, webhook-timeout). **Body-size- og licens-retrytests mangler stadig** og udgør del B; Action'en har ingen body-size-grænse at teste endnu, så en sådan test kræver først en beslutning om grænsen.

**Del B — FÆRDIG 2026-09-26 (`ceo/body-cap-license-retry`):**

- **Målt fund, før der blev skrevet en linje test:** (1) `src/checkers/content.js` kaldte `clearTimeout(timeout)` *umiddelbart efter* `fetch` havde svaret og **før** `await response.text()`. En server, der sender headere og derefter går i stå, havde dermed **ingen deadline** — kaldet returnerede aldrig, og `watch` (hvor kørslen sker i en løkke) hangde på ét URL for evigt. Bevis: med den gamle kode fejler den nye test ved at **time out efter 30 s**. (2) `await response.text()` var ubegrænset. Watch-loopen læser alle URL'er hver pass, så én side der serverer en flere gigabyte stor fil (eller en uafsluttet strøm) ville trække hele CLI'en ned med sig. (3) Licenskaldet havde **intet genprøvningsforsøg**: en enkelt `429` sendte en betalende kunde ned i `cached`, og et enkelt tabt netværkssvar kunne starte uret på de 7 dages `unverified`. Det er præcis "en licens, der ikke aktiverer" — missionens prioritet 1.
- **Body-størrelse:** `MAX_CONTENT_BYTES = 2 MiB`. Overskrides den under streaming, annullerer vi læsningen og returnerer `{ fetched: false, tooLarge: true, contentLength }` — **aldrig** et hash af en halv side. En server der *erklærer* en stor `content-length` springes uden at læse. `contentLength` er nu **rigtige bytes på ledningen** (`Buffer.byteLength`) frem for UTF-16-tegn, som den gamle kode rapporterede som "bytes" i CLI-output og i `content_changed`-events; charset følger `Content-Type`, så hash'en for ikke-UTF-8-sider er uændret.
- **Vigtigt for missionen:** en for stor side giver *intet indholdssignal*, aldrig DOWN. `engine.js` kalder kun indholdstjekket når sitet er sundt, og `watch.js` skriver hverken `lastHash` eller `lastContentLength` for et `fetched: false`-resultat — så en stor side kan hverken slå et sundt site ned eller sende en falsk `content_changed`-alarm.
- **Timeout:** abort-timeren ryddes nu i `finally`, så den er aktiv gennem hele body-readet. Afbryder den sig, er fejlen `Page did not send its body within <n>ms`.
- **Licensgenprøvning:** `post()` er delt i `post()` (loop) og `postOnce()` (ét forsøg). `LICENSE_ATTEMPTS = 2`, `LICENSE_RETRY_DELAY_MS = 400`. Der genprøves **kun** på `transient` eller `malformed` — et verdikt (`valid:false`, 400/403/404/409) spørges aldrig om igen, og et sundt svar koster stadig præcis ét request. Et `Retry-After` på over 2 s gør, at vi **ikke** genprøver: ratelimiteren beder om at komme tilbage senere, og det er cached-grace-vinduet, der dækker det. Worst case for ét CLI-kald er nu 2 × timeout + 400 ms i stedet for 1 × timeout. `docs/license-lifecycle.md` §1 og §5 (Rust-kravet) er skrevet om; `refreshLicense` rører ikke ved det, så en kunde med en 6 dage gammel bekræftelse beholder Pro `active` gennem ét 503.
- **Test (14 nye, alle deterministiske mod en lokal `node:http`-server):** 6 i `test/test.js` (normal side hash'er/titel/byte-tal, **iso-8859-1-side beholder sin titel og sit rigtige byte-tal** så opgraderingen ikke giver falske content-events, streaming over cap'en giver intet hash og stopper læsningen under 4 MiB, erklæret stor `content-length` springes over med < 1 MiB læst, en krop der aldrig slutter aborteres på 250 ms med hele kaldet under 5 s, og `checkUrl` på en stor side er stadig `healthy: true`) og 8 i `test/license.test.js` (transient 503 → genprøvet og verdikt bruges; **aktivering** der blipper én gang lykkes; verdikt for 200-`valid:false`/403/404/409 giver præcis ét request; sundt svar ét request; 503/429/malformed 200/netværksfejl stopper på præcis `LICENSE_ATTEMPTS`; langt `Retry-After` giver ét request; kort `Retry-After` overrides standardpausen; `refreshLicense` ender på `active` gennem ét 503). De otte eksisterende transient-tests får `NO_WAIT`, så gaten ikke vokser medsekunder.
- **Mutationstest (6):** gendannet `clearTimeout` før body-readet → stalling-testen **cancelleres efter 30 s**; fjernet streaming-cap'en → 1 fejl; fjernet `content-length`-springet → 1 fejl; fjernet genprøvningsloopet → 5 fejl; `retryable = true` (verdikt genprøves) → 3 fejl; ignoreret `Retry-After` → 1 fejl.
- **Bevis:** Node 26.7.0 — `npm ci --ignore-scripts`, **`npm test` grøn med 149/149** (136 + 13), `npm run audit` 0/0, `node --check` alle JS-filer, `node tools/matrix.mjs --check`, `sh -n`/`bash -n` og `git diff --check` grønne. Ingen afhængighed ændret. **Bemærk:** AC3's body-size-del lå og lavede *produktkode*, ikke kun tests — en test alene ville have dokumenteret bugen uden at lukke den.

**Del C — FÆRDIG 2026-09-26 (`ceo/terminal-safety`):**

- **Hvad opgaven egentlig var:** `deskuptime headers` skriver headerværdier fra det site, den undersøger, direkte til terminalen — `X-Powered-By` og CSP/HSTS-værdierne råt. Et overvåget site kan altså vælge en del af den rapport, der handler om sig selv.
- **Først målt, så skrevet — og min første hypotese var forkert.** Jeg antog, at en ESC i en headerværdi kunne skrive over vores egen output. En probe mod en rå `net`-socket viser, at **undici afviser** ESC, BEL, VT, FF, SO og DEL i en headerværdi med `Invalid header value char`, før de når nogen kode. Den klassiske vektor er altså lukket i parseren, ikke i vores output. Det er skrevet ned, så næste iteration ikke "fikser" det igen.
- **Hvad der faktisk kommer igennem:** alt fra `0x80` og opefter, fordi undici dekoder headerbytes som **latin1**. Særligt **U+0085 (NEL)** og **U+009B (8-bit CSI)**. Det er reelle fejl: NEL er et linjeskift for nogle terminaler, så et site kan bryde den aftale om én linje pr. record i både `headers` og `watch --once`; U+009B er en CSI i en terminal i 8-bit-tilstand. Bevis: rå-socket-serveren i testen, og `assertInert()` fejler på den muterede kode.
- **Bidi/zero-width er defense in depth, ikke en live bug.** Via latin1-dekoding ankommer UTF-8-sekvenser som `U+00E2 U+0080 U+00AE` — altså ikke som RLO. `INVISIBLE`-klassen er derfor værd at have for en håndskrevet state-fil, en fremtidig klient og `watch`-state, men den må ikke sælges som en fundet sårbarhed.
- **Én funktion, alle steder:** ny `src/display.js` med `safeText(value, { max, fallback })`. Den fjerner hele escape-sekvenser (CSI, OSC med BEL *og* ST, to-byte-escapes), C0/C1/DEL, bidi og zero-width, klemmer til én linje og bevarer det historiske 60-tegns cap på sikkerhedsheadere. Anvendt på `headers` (URL, fejl, redirect-trin, `X-Powered-By`, sikkerhedsheadere), `check` (URL, SSL-fejl, fejltekst) og `watch`/`status` (`printPass`, `printStatus`).
- **`--json` er bevidst urørt.** En maskinformat må hellere miste præcision end lyve om data: den, der renderer JSON'en, skal escape. Der er en test, der låser raw-værdien i `headers --json`.
- **To fejl fundet af mine egne tests undervejs (ikke produktrelaterede):** (1) `assertInert()` matchede et linjeskift (LF), altså vores *egne* linjeskifter; (2) `net.Server` har ikke `closeAllConnections()` (det har `http.Server`), så `after`-hooken kastede og testrunneren aldrig lukkede. Begge rettet — og det er grunden til, at testen bruger en rå socket med håndtrackede sockets.
- **Test (12 nye, `test/display.test.js`, ingen netværk):** 6 unit (benign tekst uændret inkl. CSP/HSTS/DENY, hele escape-sekvenser væk, OSC-BEL og OSC-ST, de faktisk-reachable bytes, bidi/zero-width, cap + fallback) og 6 end-to-end mod en rå-socket-server: en forfalsket ren sikkerhedsrapport (de 4 ærlige `⬜ missing:`-linjer skal alle være der), redirect-målet neutraliseret af `new URL()` (percentkodet — låst med en test, så en fremtidig ændring ikke kan åbne det), `--json` tabsfrit, den målte parsergrænse for ESC/BEL/DEL (fejlen skal surfaces, `OWNED` må aldrig printes, exit 2), en DOWN-linje der overlever et site, der prøver at reflowe loggen, og en håndskrevet state-fil, der prøver at male URL-listen.
- **Mutationstest (3):** `safeText` gjort til pass-through → 15 fejl; 8-bit-CSI-stripping fjernet → 7 fejl; kun `headers`-stedet gjort usikkert → 3 fejl.
- **Bevis:** Node 26.7.0 — `npm ci --ignore-scripts`, **`npm test` grøn med 179/179** (167 + 12), `npm run audit` 0/0, `node --check` alle JS-filer, `node tools/matrix.mjs --check`, `git diff --check` grønne. Ingen afhængighed ændret, ingen ny claim, matrixen urørt.

### P1-2b — FÆRDIG 2026-09-26 — Rapporten skal kunne se et certifikat, der skal fornyes (`ceo/report-ssl-warning`)

**Begrundelse (missionens fokus: "SSL- og domæne-udløbsvarsler" til små bureauer):** Missionen lister SSL-udløbsvarsler som konkret Pro-værdi, men målingen fandt **tre overflader, der viser samme certifikat, med to forskellige adfærd og én uden tærskel**. `src/watch.js:178,181` hårdkodede `validDays <= 14` to steder, `src/engine.js:122` hårdkodede `validDays <= 14`, og `src/report.js` skrev bare `${sslDaysRemaining} d` — altså skrev den flade, et bureau videresender til sin kunde, `9 d` uden at nogen kunne se, at det var i den adversensl zone. Et certifikat kunne advare i terminalen og se fredeligt ud i den samme klients kunderapport.

**Acceptkriterier:**

1. Advarselsvinduet er defineret ét sted og bruges af alle tre overflader. — **Færdig** (`SSL_WARN_DAYS` + `isSslExpiringSoon()` i `src/status.js`; brugt af `summarize()`, `runPass()` og rapporten)
2. Rapporten markerer et certifikat i vinduet i stedet for at skrive et råt tal. — **Færdig** (`⚠️ 9 d — renew soon`)
3. Modtageren kan se *hvilke* sites der skal fornyes uden at lede i tabellen. — **Færdig** (resumelinje får "N SSL expiring soon", og de konkrete URL'er med dage navnes på en egen linje)
4. `--json` er maskinelæsbar på samme sandhed som teksten. — **Færdig** (`sslExpiringSoon` pr. site + `summary.sslExpiringSoon`; testen låser at de to er enige)
5. Ukendt udløbsdag er `—` og advarser aldrig; et ugyldigt tal kan ikke finde på en advarsel. — **Færdig** (se fundet nedenfor)
6. `docs/agency-report.md` §4 beskriver SSL-kolonnens betydning. — **Færdig**

**Resultat:** `isSslExpiringSoon()` kræver et **finite og ikke-negativt** antal dage. Det er ikke kosmetik: `Number.isFinite(-3)` er sand, så min egen test fangede at en håndskrevet `sslValidDays: -3` ville have renderet "⚠️ -3 d — renew soon" i en kunderapport — et certifikat, der "forfalder nu" fordi en fil blev redigeret. Negativt, `NaN`, `Infinity` og strenge er nu *ukendt* (`—`) i rapporten, aldrig en advarsel. Brudte tal kan altså kun fjerne en kolonne, aldrig opfinde en.

**Test (3 nye i `test/report.test.js`):** 14 dage markerer og 15 gør ikke, i både Markdown og JSON, og linjen med "renewal needed" med navne på præcis de to af fire sites der er i vinduet; det samme gælder `summarize()` (`⚠️`/`✅`) og den latched `ssl_warning`-event i et rigtigt `runPass` med en stub-check, så de tre overflader låses til *samme* vindue adfærdigt; de seks ugyldige tal giver `sslExpiringSoon: false` og `—`. **Mutationstest (målt, ikke antaget):** at fjerne `>= 0`-gaten i `report.js` giver 1 fejl i 16. Derimod giver det at fjerne `>= 0` *alene* i `isSslExpiringSoon()` 0 fejl, fordi rapporten gater `sslDaysRemaining` til `null` først — de to guards er redundans i dybet (den ene beskytter `summarize()` og `watch`, den anden rapporten), og kun rapportens er dækket af en test. Skrevet ned, så næste iteration ikke "forstærker" en guard to gange eller tror den er testet.

**Bevis:** Node 26.7.0 — `npm test` grøn med **191/191** (188 + 3), `npm run audit` 0/0, `node --check` alle JS-filer, `node tools/matrix.mjs --check`, `sh -n`/`bash -n` og `git diff --check` grønne. **Bemærk til miljøet:** standard-`node` på denne maskine er v22, og de 7 installtests + 5 action-tests fejler korrekt under Node 22 (install.sh og action.yml kræver 24+); med `/opt/homebrew/opt/node@26/bin` i PATH (26.7.0) er alle 191 grønne. Det er samme forbehold planen har noteret siden P0-2.

### P1-3 — FÆRDIG 2026-09-26 — Pro-grænse må ikke sende betalende kunder i kassen (`ceo/pro-gate-truth`)

**Begrundelse (missionens prioritet 1):** Den betalte kunderapport var den nye Pro-værdi, men dens port svarede **altid** med købslinket — også når licensserveren aldrig havde dømt nøglen. `deskuptime status` blev i iteration 13 netop om til at *ikke* vise kassen i `unverified`, fordi det er den besked, der får en kunde til at købe licens nummer to. To flader sagde altså modsatte ting om den samme nøgle, og den nye Pro-feature var den stærkeste købs-motivation vi har.

**Acceptkriterier:**

1. Ét sted fortæller hvorfor en Pro-funktion er lukket, bygget på `describeLicense()`. — **Færdig** (`proGateMessage()` i `src/license.js`)
2. `report` med `unverified`/`invalid` giver exit 1, tom stdout, "genverificér nøglen" og **intet** købslink for `unverified`. — **Færdig**
3. `report` med `invalid` må nævne købslinket kun som "hvis du ikke har købt endnu", ligesom `status`. — **Færdig**
4. `report` med `free` peger på kontraktens købslink (konverteringen må ikke gå tabt). — **Færdig**
5. `--webhook`-grænsen i `startWatch` bruger samme funktion, så den ikke kan modsige `status`. — **Færdig**
6. `docs/license-lifecycle.md` §2 og `docs/agency-report.md` §4 beskriver reglen. — **Færdig**

**Resultat:** `proGateMessage(license, feature)` returnerer `null` for `active`/`cached`, købslink for `free`, genverificér-vejledning uden købslink for `unverified`, og afslag + betinget købslink for `invalid`. `report` og `startWatch` kalder den; ingen af dem har længere en egen købslinje. `test/claims.test.js` låser, at `freeLimitMessage` **og** `proGateMessage` peger på kontraktens link, så konverteringen ikke kan forsvinde ved en senere refaktorering.

**Test (3 nye + 2 mutationstester → 182/182):** to unit-tests i `test/license.test.js` (fri → kun kassen; `unverified` → intet købslink; `invalid` → kun betinget kasse; `active`/`cached` → `null`; en `cached`-record hvis grace er udløbt må heller ikke få købslink; og at gaten genbruger præcis `describeLicense()`'s `detail`), to end-to-end i `test/report.test.js` (CLI'en med en `unverified`-nøgle: exit 1, tom stdout, ingen `buy.stripe.com`; og at `status` og `report` siger det samme om den samme nøgle). **Mutation:** at gendan den gamle altid-købslink-adfærd i `report` giver **2 fejl** i 13 i `test/report.test.js`; reindsat kode giver 13/13.

**Bevis:** Node 26.7.0 — `npm ci --ignore-scripts`, **`npm test` grøn med 182/182** (179 + 3), `npm run audit` 0/0, `node --check` alle JS-filer, `node tools/matrix.mjs --check` grøn, `git diff --check` grøn. Ingen afhængighed ændret, ingen ny claim, matrixen urørt.

### P1-4 — FÆRDIG 2026-09-26 — `--timeout` skal gælde hele tjekket (`ceo/timeout-budget`)

**Begrundelse (missionens prioritet 1):** `--timeout` er det flag, en CI-bruger bruger til at holde sit job kort, og det er det flag, `action.yml:67` sender med hvert kald. Før denne iteration læste kun det første af tre ben det, så flaget var en løfte, brugeren ikke kunne holde.

**Målt fund 2026-09-26 (inden der blev skrevet en linje test):** et check er tre ben — reachability-requestet, TLS-handshaken og læsningen af siden. `engine.js` sendte `opts.timeoutMs` til `checkReachability()`, men kaldte `checkSSL(url)` og `checkContentChange(url, opts.contentHash)` uden det, og begge havde deres eget deadline hardkodet (10 s / 20 s). En probe mod en `node:net`-server der svarer `200` med headere og aldrig kroppen: **`checkUrl(url, { timeoutMs: 500 })` tog 20 094 ms** — 40× flagets værdi, og præcis den kode der gør et Action-job langsom. Efter rettelsen: **506 ms**. README's "Override the 15-second network timeout" gjorde kun det ufuldstændige forhold eksplicit.

**Acceptkriterier:**

1. `--timeout` er ét budget for alle tre ben, så flaget aldrig kan overskrides. — **Færdig** (`legTimeoutMs()` i `src/engine.js`)
2. Et ben får aldrig mere end sit eget deadline, så et større budget aldrig gør et check langsommere end i dag. — **Færdig** (`Math.min(fallbackMs, remaining)`)
3. Uden `--timeout` er stien uændret, så watch-loopen (der kalder `checkUrl` uden timeout) beholder hvert bens default. — **Færdig** (deadline sættes kun ved et positivt heltal)
4. Et opbrugt budget giver en ærlig timeout frem for at køre uden ramme. — **Færdig** (gulv på 1 ms)
5. `checkSSL` tager sit eget deadline i stedet for to hardkodede 10 s. — **Færdig** (`checkSSL(url, { timeoutMs })`)
6. README, statuspolicy og `--help` siger at `--timeout` gælder hele tjekket. — **Færdig**

**Resultat:** `legTimeoutMs(deadline, fallbackMs)` er den eneste sted, der fordeler budgeten, og den er ren — `null`/`0` betyder "ingen budget" (watch-loopens sti), et fremtidigt deadline giver `min(default, rest)`, et opbrugt giver 1 ms. `checkSSL` bruger sit `timeoutMs` både i `tls.connect({ timeout })` og i den manuelle timer, som begge stod hardkodet til 10 000.

**Test (6 nye, `test/budget.test.js`, ingen netværk — en `net`-server der svarer på HTTP og en der tier på TLS):** `--timeout 500` på en krop der aldrig slutter er færdig under 5 s **og** giver `healthy: true` med `fetched: false` (et stort eller hængende svar må aldrig slå et sundt site ned); samme server uden budget læser et 700 ms svar færdigt, mens `--timeout 150` afbryder det — altså er det budgeten, der afkorter, ikke en ændret default; `checkSSL` med 300 ms mod en tierende server svarer under 2 s med en fejl; `checkSSL` uden deadline er **stadig i gang efter 1,5 s** mod en 10 s default, så standarden kan ikke stille blive ændret; og `legTimeoutMs`'s fem tilfælde låst. Sockets trackes og ødelægges ved teardown, fordi en rå `net`-server ellers kaster `ECONNRESET` efter at testen er slut (samme fælde som P2-1 del C).

**Mutationstest:** at gendan benenes egne deadlines i `engine.js` giver **2 fejl** i 6 — den første efter **20 055 ms**, altså ikke en tilfældig timing-fejl men den målte fejl. Reindsat kode giver 6/6.

**Bevis:** Node 26.7.0 — `npm ci --ignore-scripts`, **`npm test` grøn med 188/188** (182 + 6), `npm run audit` 0/0, `node --check` alle JS-filer, `node tools/matrix.mjs --check`, `sh -n`/`bash -n` og `git diff --check` grønne. Fast-forward-merge til `main` og push af begge grene 2026-09-26. Ingen afhængighed ændret, ingen ny claim, matrixen urørt.

**Målt, ikke antaget:** før rettelsen skrev `report` bogstaveligt `the client report needs an active Pro license. Pro unlocks … <buyUrl>` uanset tilstand, og `--webhook` skrev `--webhook needs an active Pro license … <buyUrl>`. Det var ikke en hypotese om tekst — det var den eneste kodevej til kassen.

## Dependency- og opgraderingslog

### Aktuel offentlig CLI


- `2026-09-26`: P1-3 gjorde Pro-grænsene sande. `report` svarede altid med købslinket, også for en nøgle licensserveren aldrig havde afslået (`unverified`) — modsat `status`, der siden iteration 13 bevidst holder kassen væk i den tilstand. Ny `proGateMessage(license, feature)` i `src/license.js` er nu det eneste sted, der forklarer en lukket Pro-funktion, bygget på `describeLicense()`: `free` → kasse, `unverified` → genverificér nøglen uden købslink, `invalid` → købslink kun som "hvis du ikke har købt endnu". Bruges af `report` og `--webhook`-grænsen. 3 nye tests + 2 mutationstester → **182/182**; `npm run audit` 0/0; `node --check`, `matrix --check` og `git diff --check` grønne på Node 26.7.0. Ingen afhængighed ændret.

- `2026-09-26`: P2-1 del C gjorde terminaloutput tro værdig. `headers` skrev `X-Powered-By` og sikkerhedsheadere fra det undersøgte site råt til terminalen. Målt først: **undici afviser** ESC/BEL/VT/FF/SO og DEL i en headerværdi, så escape-sekvens-vektoren var lukket i parseren — men **C1-tegn (U+0085 NEL, U+009B CSI) kommer igennem**, fordi headerbytes dekodes som latin1, så et site kan bryde aftalen om én linje pr. record. Ny `src/display.js` med én `safeText()`, brugt i `headers`, `check`, `watch` og `status`; `--json` er bevidst urørt, fordi en maskinformat hellere må miste præcision end lyve. 12 nye tests + 3 mutationstests → **179/179**; `npm run audit` 0/0; `node --check`, `matrix --check` og `git diff --check` grønne på Node 26.7.0. Ingen afhængighed ændret.
- `2026-09-26`: P1-2 del C gav kunderapporten et 30-dages vindue. Ny `src/history.js` skriver dags-buckets (to heltal pr. site pr. døgn) til `~/.deskuptime/history.json` — en **anden fil** end `state.json`, fordi state skrives hvert pass og rummer nøglen. Retention er strukturel: 35 døgn pr. URL, 500 URL'er, pruning ved skrivning, så filen ikke kan vokse med tiden. `deskuptime report` viser `Uptime (all)` og `Uptime (window)`; `--days N` (1–35) afløser det faste 30 og **fejler** i stedet for at blive ignoreret. Et site uden registrerede døgn i vinduet viser `—`, aldrig 100 %, og definitionen er den samme `uptimePercent()` som livstidstallet. Historien skrives for alle tiers, så en opgraderet gratisbruger ikke starter med en tom måned; kun rapporten er Pro. 17 nye tests + 4 mutationstests → **167/167**; `npm run audit` 0/0; `node --check`, `matrix --check`, shell- og diff-check grønne på Node 26.7.0. Ingen afhængighed ændret.

- `2026-09-26`: P2-1 del B lukkede to huller, målt før de blev skrevet. `checkContentChange` ryddede sin abort-timer *før* body-readet, så en side der sender headere og går i stå hangde `watch` for evigt (bevis: testen time'out efter 30 s med den gamle kode), og `response.text()` var ubegrænset, så én meget stor side kunne trække CLI'en ned. Nu: `MAX_CONTENT_BYTES = 2 MiB` med streaming-annullering (et for stort svar giver *intet* indholdssignal, aldrig falsk DOWN), abort-timeren aktiv gennem hele readet, og `contentLength` i **rigtige bytes** frem for UTF-16-tegn. Licenskald har desuden én afgrænset genprøvning (`LICENSE_ATTEMPTS = 2`, 400 ms), som aldrig spørger om et verdigt svar igen og ikke genprøver ved et langt `Retry-After` — så ét 503 ikke længere sender en betalende kunde ned i `cached`/`unverified`. 14 nye tests + 6 mutationstests → **150/150**; `npm run audit` 0/0; `node --check`, `matrix --check`, shell- og diff-check grønne på Node 26.7.0. Ingen afhængighed ændret.

- `2026-09-26`: P1-2 del A + del B byggede bureau-rapporten `deskuptime report` (Markdown + JSON, Pro, read-only, uden konto) med spec i `docs/agency-report.md`. Uptime-tællere (`checks`/`checksUp`) skrives nu i den rigtige `runPass` via `recordPass()`, så de er bundet til de passes der faktisk kørte. Matrix-rækken `status-page` flippet til implementeret, hvilket regenererede README, `docs/pro-alerts.md`, `--help` og npm-beskrivelsen (196 tegn). **Reel fejl fundet undervejs:** rapportens Markdown-cell escaped pipes og `<>` men ikke newlines, så en URL med linjeskift sprængte kundetabellen i to rækker. +12 tests → **136/136**; `npm run audit` 0/0; `node --check`, `matrix --check` og `git diff --check` grønne på Node 26.7.0. Mutationstest bekræfter tæller- og gatedækningen. Ingen afhængighed ændret.

- `2026-09-25`: CI-smoke-steppet i `ci.yml` kørte mod `https://example.com`, altså kunne et tredjeparts-site gøre repoets egen gate rød, og det assertede kun den sunde side. Det kører nu mod en lokal HTTP-fixture med en 200- og en 500-route og fire `jq -e`-assertions, så tællingen kan fejle på begge sider. Ingen afhængighed ændret.

- `2026-09-25`: P2-1 del A gjorde testene deterministiske og **fandt en reel fejl i produktkoden**: `src/checkers/ssl.js` sendte `servername: hostname` også for IP-adresser. Node 22 kun advarede, Node 24+ (repoets `engines`-krav) kaster — så ethvert HTTPS-site overvåget på IP-adresse fik `SSL: ERR` i stedet for udløbsdagene, og Action'en ville melde det sunde site som SSL-fejl. SNI sendes nu kun for værtsnavne. Derudover er de fire live-`example.com`-tests erstattet af lokale HTTP- og TLS-fixtures (selvsigneret cert pr. kørsel via `openssl`, `NODE_EXTRA_CA_CERTS`), watch-testens vakuum-assertion kan nu fejle, og Action'en **verificerer sit JSON-payload** (array, antal = bestilte URL'er, boolsk `healthy`) før den tæller — et tomt resultatarray gav før `down=0` og en grøn kørsel. +6 tests → **124/124**; `npm run audit` 0/0; `node --check`, `sh -n`/`bash -n`, YAML tab-fri og `git diff --check` grønne på Node 26.7.0. Mutationstest bekræfter dækningen af begge fejl. Ingen afhængighed ændret.

- `2026-09-25`: P1-1 del B indførte **`unverified` som det femte licensord** og rettede dermed en reel dobbeltkøbsrisiko: en nøgle, licensserveren aldrig nåede at dømme, blev vist som `invalid` ("afslået"), så kunden kunne tro den var død og købe igen. `unverified` siger "aldrig afslået" og viser aldrig et købslink. `isPro()` i `src/watch.js` skiftede samtidig fra deny- til allow-liste, så en ny status ikke kan give Pro ved et uheld. npm-beskrivelsen er nu den tredje genererede overflade fra `src/features.js` (`tools/matrix.mjs` skriver den til `package.json`), og to nye tests låser ét købsflow pr. side. `npm test` er grøn med **118/118**; `npm run audit` 0/0; `node --check`, `matrix --check` og `git diff --check` grønne på Node 26.7.0. Ingen afhængighed ændret.

- `2026-09-25`: P1-1 del A gjorde **én versionsstyret matrix** til source of truth for gratis/Pro-claims: ny `src/features.js` (produkt, pris, links, håndhævede grænser, 14 rækker EN+DA, licensens tre felter). `src/watch.js` og `src/license.js` læser derfra i stedet for egne konstanter, `--help` gengiver matrixen, og README + `docs/pro-alerts.md` §1/§5 er genererede blokke (`npm run matrix`, `--check` i testen). Derved er tre claims fundet og rettet: `watch --once` nåede gratisgrænsen uden købslink, hjælpebanneret var 6 tegn for smalt, og claims-testen låste på håndskrevne strenge. Ny `test/matrix.test.js` (8 tests); `npm test` er grøn med **113/113**; `npm run audit` 0/0; `node --check`, `sh -n`/`bash -n`, YAML og `git diff --check` grønne på Node 26.7.0. Mutationstest bekræfter, at en håndredigeret tabel eller en ændret grænse bryder testen. Ingen afhængighed ændret.

- `2026-09-25`: P0-9b (del B af P0-9) rettede **curl-installationsstien**: `install.sh` havde `VERSION="0.1.4"` fastlåst, tre minorer under npm-versionen, og udpakkede uden nogen checksum-verifikation. Den løser nu den nyeste publicerede `v*-cli`-release (kun releases med `deskuptime-<ver>.tar.gz`-asset, højeste semver, drafts/prereleases sprunget over) via det offentlige read-only releases-API, verificerer den publicerede `.sha256` **før** udpakning og erstatter i stedet for fletter en tidligere installation. `release-cli.yml` uploader nu tarball **og** sidecar i samme step. 9 nye tests kører det rigtige script mod en lokal server, inkl. manipulations-afvisning. Det gamle `deskuptime-0.1.3.tar.gz` er fjernet fra repo-roden. `npm test` er grøn med **105/105**; `npm run audit` 0/0; shell-, YAML-, syntax- og diff-check grønne på Node 26.7.0. Live-`curl`-ruten installerer nu 0.2.5 i stedet for 0.1.4. Ingen afhængighed ændret.

- `2026-09-25`: P0-9a (del A af P0-9) repaired the **brudde release-build**: `make_tarball.sh` fejlede sin egen self-check, fordi den håndlavne filliste manglede `src/status.js` and `src/checkers/headers.js`, så ingen ny `v*-cli`-tag kunne skæres, og curl-/brew-install var døde på første kommando. Hele `src/`-træet pakkes nu, self-checken kører også `headers --json` og `watch --once`, og der skrives en `.sha256`-sidecar. Ny `test/tarball.test.js` (9 tests) bygger tarballen mod en lokal HTTP-server og kører den udpakkede CLI. `npm test` er grøn med **96/96**; `npm run audit` 0/0; `node --check` og `git diff --check` grønne på Node 26.7.0. Ingen afhængighed ændret; `.gitignore` udelukker nu tarball-artefakter.

- `2026-09-25`: P0-11 opgraderede `actions/setup-node` v4 → v7 i alle fire workflows (fem pin-bumps, identiske med Dependabot PR #2) og i README's forbruger-snippet. Ren pin-bump, ingen kodeændring. `npm test` 87/87, audit 0/0, YAML grøn; CI-run `36174538867` grøn i begge jobs. Dependabot PR #2 er nu overflødig og kan lukkes af Mads — agenten foretager ingen writes mod GitHub-PR'er. Sammen med P0-10 ligger alle `actions/*`-pins nu på v7.
- `2026-09-25`: P0-13 rettede **falsk DOWN** på routes, der ikke svarer på `HEAD` (Cloudflare Workers m.fl.). 5 nye tests; `npm test` er grøn med 87/87; `npm run audit` 0 sårbarheder. Node 26.7.0, `npm ci --ignore-scripts`, `node --check` og `git diff --check` grønne. Verificeret mod den rigtige worker: 404 → 200.
- `2026-09-25`: P0-10 opgraderede `actions/checkout` v4 → v7 i alle fire workflows (seks pin-bumps, identisk med Dependabot PR #3). `npm test` 82/82, audit 0/0, YAML-parse grøn; CI grøn på `b27ba35`. Kræver ingen kodeændring. Dependabot PR #3 er nu overflødig og kan lukkes af Mads — agenten foretager ingen writes mod GitHub-PR'er.

- `2026-09-25`: P0-7 tilføjede 23 tests til licenslifecycle: timeout mod en rigtig hængende server, transient vs. permanent HTTP-klassificering, fire synlige tilstande, legacy-state alder, `0600`/`0700`-rettigheder, atomisk skrivning, licensrecord-validering og redaction. `npm test` er grøn med 82/82; `npm run audit` 0 sårbarheder. Node 26.7.0, `npm ci --ignore-scripts`, `node --check` og `git diff --check` grønne. `docs/license-lifecycle.md` er ny source of truth.
- `2026-09-25`: P0-6 tilføjede 4 device_id-tests og en 12-sagers golden-fixture; nye CI-job `license-windows` kører licenstestene på native Windows med Node 24. `npm test` er grøn med 59/59; `npm run audit` 0 sårbarheder. Mutationstest bekræfter, at testene fanger den gamle `os.hostname()`-adfærd. Node 26.7.0, `npm ci --ignore-scripts`, `node --check`, YAML/JSON og `git diff --check` grønne.
- `2026-09-25`: Node-runtime `>=18` → `>=24`, den aktive LTS. Verificeret med Node 24.21.0; ingen application-kodeændring udover help-tekst var nødvendig.
- `2026-09-25`: Nul runtime-/dev-dependencies bevaret; `package-lock.json` v3 tilføjet. `npm ci --ignore-scripts` og `npm run audit` er grønne med 0 sårbarheder.
- `2026-09-25`: `npm test` er grøn med 55/55 efter P0-5; `npm run lint` og `npm run build` findes ikke.
- `2026-09-25`: P0-5 tilføjede 10 tests (6 claims-konformance + 4 webhook). Webhook har nu 10 s timeout; claims låst mod `docs/pro-alerts.md`. Node 26.7.0, `npm ci --ignore-scripts`, audit 0/0, `node --check` og `git diff --check` grønne.
- `2026-09-25`: P0-4 tilføjede 13 isolerede watch/state-tests. Node 24.21.0, `npm ci --ignore-scripts`, audit 0/0, JavaScript-syntax og diff-check er grønne; fresh review-fund blev triageret og rettet eller eksplicit flyttet til P0-5/P0-7.
- `2026-09-25`: P0-3 tilføjede seks lokale status-/Action-/headers-/preflight-tests. Node 24.21.0, `npm ci --ignore-scripts`, audit 0/0, JavaScript-syntax og diff-check er grønne; fresh review fandt ingen P0/P1.
- `2026-09-25`: Actions-størrelserne 4 → 7 lå i rene Dependabot PR #2 og #3; begge er nu reimplementeret og mergeret i dette repo (P0-10 checkout, P0-11 setup-node). Ingen `actions/*`-pin er under v7.
- `2026-09-25`: Fjern-CI `36105085970` på `ee8e8ab` passerede alle steps. Annotations advarer om eksisterende Actions v4 Node 20-runtime og fremtidig `ubuntu-latest`-migration; ingen ny blocker.

### Historisk desktop-iteration før repoopdelingen

- `2026-09-25`: Desktopens daværende gate var `npm test` 32/32, `cargo check --locked`, `cargo test --locked` 10/10 og `cargo tauri build --debug` på macOS.
- `2026-09-25`: Fresh review fandt ingen P1; tre P2 blev rettet. Licensrefresh-race, atomisk `0600`-lagring og deactivation-bekræftelse blev bekræftet som private follow-ups.
- `2026-09-25`: `cargo fmt -- --check` rapporterede formateringsafvigelser i den daværende Rust-kode.
- `2026-09-25`: Før denne iteration kunne `npm audit` ikke køre uden lockfile. Trivy/OSV fandt `glib 0.18.5`; advisoryen følger nu det private desktoprepo.

## ❓ Til Mads

0. **Skal `src/features.js` også være source of truth for siten og det private desktoprepo?** Matrixen er nu én fil i dette repo, og den private desktop-app plus `deskuptime.com` har hver deres egen matrix. Hvis de skal følge med automatisk, er vejen et lille public npm-pakke (`@mahope/product-matrix`) som alle tre repoer importerer. Uden beslutning fortsætter de to andre overflader med at være håndskrevne — og det er præcis den drift, del A lukker her.

1. Hvad er den endelige gratis/Pro-matrix? Skal desktoptray og lokale notifications være gratis, eller kun Pro? README, kode og mission peger i dag i forskellige retninger.
2. Skal Pro email og Slack/Discord/Teams implementeres nu, eller skal de forblive uden for matrixen, indtil de er bygget? P0-5 har fjernet dem fra alle overflader i dette repo og noteret dem som ikke-implementeret; **live-siten `deskuptime.com` hævder stadig email for Desktop Pro**, og rettelsen ligger uden for dette repo (P0-12 er `BLOCKED`). Svar på spørgsmålet afgør både næste CLI-opgave og sitens claim.
3. Hvilken rapport/status-side skal være første bureau-feature, og hvilke data må en kunde-rapport indeholde?
4. Skal det eksisterende Stripe Payment Link verificeres manuelt for pris, valuta, fulfillment og license-key før næste release? Ingen betaling eller Stripe-write udføres af agenten.
5. Er der allerede Mahope/Stripe-aktiveringer fra pre-release Windows-builds, der kræver device_id-migration? Det afgør, om minimal generator-fix er nok.
9. ~~Skal `deskuptime status` få et femte ordensord, fx `unverified`?~~ **Besvaret i kode 2026-09-25 (`eb2b134`):** `unverified` er indført som det femte ord for "licensen kunne ikke verificeres, serveren svarer ikke" — aldrig afslået, aldrig købslink, `invalid` betyder nu alene et afslag. Fælden med et femte ord viste sig mindre end frygtet, fordi Pro-gatingen lå i en deny-liste og altså skulle hærdes samtidig; det er gjort og testet.
6. Pro-navne, hvis et nyt brand senere ønskes: **DeskUptime Pro** (trygt og tydeligt), **Uptime Desk** (kortere), **Watchtower** (produktnavn, men bruges ofte) eller **Signal Monitor**. Ingen produkter, der allerede er i Stripe, omdøbes uden Mads' beslutning.
7. Skal den betalte desktopkilde, som stadig findes i offentlig Git-history før `39c434f`, fjernes via en separat historikskrivning af Mads? Agenten gennemfører aldrig force-push eller historik-rewrite.
8. **Hvilket repo indeholder kilden til `deskuptime.com`?** P0-12 er `BLOCKED`, fordi sitens HTML ikke ligger i dette repo, og agenten ikke må læse det formodentlige `~/Projects/hermes/hermes-passiv`. Giv enten adgang til det repo, eller lav de fem konkrete rettelser i P0-12 selv. Dette er det mest synlige købs-flow, der i dag lover noget, der ikke findes.
10. **Skal der skæres en ny `v0.2.9-cli`-release?** P0-9b gør curl-stien væsentligt bedre, men *kun* en release med et publiceret `.sha256` gør checksum-verificeringen obligatorisk; lige nu advarer installeren om 0.2.5, fordi ingen af de 12 releases har en sidecar. Release-workflowen uploader automatisk sidecaren, så det eneste arbejde er `git tag v0.2.9-cli && git push --tags` (det gør Mads — agenten laver aldrig tags) og `npm publish` af 0.2.9. Samme release synkroniserer Homebrew-formlen, som stadig peger på en ældre version i det eksterne tap-repo.
11. Er `v1`-tagget (2026-08-26) med gamle 0.1.3-tarballs og 0.1.4/0.2.6-desktopsassets stadig nødvendigt, eller er det et rodet relikvieskilt, der bør slettes eller omdøbes? Det er det eneste release uden versionssuffix, og det ligger lige i installérens kandidatliste (den springes over i dag, fordi der intet `deskuptime-<ver>.tar.gz`-asset passer til `v1`).

- **Release-note P1-2 del C:** `--days` er et nyt flag på `report`, og `Uptime (window)` er en ny kolonne. En ældre installeret CLI kender hverken det og skriver blot `Unknown option: --days` — ingen eksisterende kundeafhældenhed brydes ved merge. Historien begynder at blive skrevet med det samme merge, så en kunde der opgraderer til en build *uden* `--days` stadig har en voksende historiefil; kun den nye build læser den. ❓ 10 (ny `v0.2.9-cli`-tag) er stadig det, der gør curl-stien komplet.
- **Release-note P1-2:** matrixen, README, `--help` og npm-beskrivelsen lover nu `deskuptime report`, men kun en build med kode. Gamle installerede CLI'er kender ikke kommandoen og skriver blot `Unknown command` — ingen eksisterende kundeafhængighed brydes ved merge. ❓ 10 (nyt `v0.2.9-cli`-tag) er stadig det, der gør curl-stien komplet.

## Deploy-/release-noter

- Dette offentlige repo er en npm-/GitHub-CLI og har ingen live-deploytarget. `STATUS.md` noterer 24/9, at `deskuptime.com` ikke er købt; derfor oprettes ingen `VERIFICÉR DEPLOY`-note for CLI-merges.
- **Release-note P0-9b:** curl-stien er rettet, men den nye verifikationsadfærd kræver en release med sidecar for at være fuldt på. Næste `v*-cli`-tag gør det automatisk (❓ 10). Ingen fungerende curl-installation går i stykker ved merge af dette commit: den gamle kode installerede 0.1.4, den nye installerer 0.2.5 og advarer om den manglende sidecar i stedet for at fejle.
- De tidligere noter for researchplan `812f469` og desktop `f0d4fa7` var fejlagtige og er fjernet med denne planrevision.
- Merge til `main` deployer ikke; npm, GitHub Releases og Homebrew må kun publiceres af Mads via de eksisterende tag-workflows.

## Iterationslog

- **Iteration 20 (P1-4):** `--timeout` var en løfte, brugeren ikke kunne holde. Et check er tre ben, men kun det første læste flaget: målt med en probe mod en server der sender headere og aldrig kroppen, tog `check --timeout 500` **20 094 ms** — 40× værdien. Det er samme kode, der gør et Action-job langsom, fordi `action.yml:67` sender `--timeout` med hvert kald. Ny `legTimeoutMs()` i `src/engine.js` fordeler ét deadline, når brugeren har givet et budget; hvert ben arver resten, men aldrig mere end sin egen default, så et stort budget aldrig kan gøre et check langsommere end i dag, og uden `--timeout` er stien uændret, så watch-loopen beholder hvert bens default. Et opbrugt budget giver 1 ms og en ærlig timeout frem for at køre uden ramme. `checkSSL` havde sit deadline hardkodet til 10 s i to steder og tager nu `timeoutMs`. Efter rettelsen: 506 ms. README's "15-second network timeout" gjorde kun det ufuldstændige forhold eksplicit; statuspolicy, README og `--help` siger nu at flaget gælder hele tjekket. 6 nye tests i `test/budget.test.js` mod to lokale `net`-servere, bl.a. at `checkSSL` uden deadline stadig er i gang efter 1,5 s, så 10 s-standarden ikke kan stille blive ændret. Mutationstest: at gendan benenes egne deadlines giver 2 fejl, den første efter 20 055 ms. Node 26.7.0: `npm ci --ignore-scripts`, **188/188** tests, `npm run audit` 0/0, `node --check`, `matrix --check`, `sh -n`/`bash -n` og `git diff --check` grønne. Commit `d678cdb` på `ceo/timeout-budget`, fast-forward-merget til `main` og pushet 2026-09-26. Næste iteration: ❓ 2/❓ 3 hvis besvaret, ellers ny research-iteration.

- **Iteration 19 (P1-3):** Den betalte kunderapport havde en port, der svarede **altid** med købslinket — også når licensserveren aldrig havde dømt nøglen. Det er præcis den fejl, iteration 13 havde fjernet fra `deskuptime status` med det nye ord `unverified`, fordi en kunde der tror sin nøgle er død, køber en licens til. To flader sagde altså modsatte ting om den samme nøgle, og det var den nye Pro-feature, der var dårligst på det punkt. Ny `proGateMessage(license, feature)` i `src/license.js` er nu det eneste sted, der fortæller en kunde hvorfor en Pro-funktion er lukket; den genbruger `describeLicense()`'s egen tilstand og `detail`, så den *kan* ikke komme i strid med `status`. `report` og `--webhook`-grænsen i `startWatch` kalder den, og ingen af dem har længere en egen købslinje. `free` → kassen, `unverified` → "genverificér nøglen" (aldrig købslink), `invalid` → afslag + købslink kun som "hvis du ikke har købt endnu", `active`/`cached` → ingen tekst. Konverteringen er ikke gået tabt: `test/claims.test.js` låser nu, at både `freeLimitMessage` og `proGateMessage` peger på kontraktens link. `docs/license-lifecycle.md` §2 og `docs/agency-report.md` §4 beskriver reglen. 3 nye tests (2 unit i `test/license.test.js`, 2 end-to-end i `test/report.test.js`) plus mutationstest: at gendan den gamle altid-købslink-kode i `report` giver 2 fejl i 13, reindsat kode giver 13/13. Node 26.7.0: `npm ci --ignore-scripts`, **182/182** tests, `npm run audit` 0/0, `node --check`, `matrix --check` og `git diff --check` grønne. Ingen afhængighed ændret, ingen ny claim. Næste iteration: ❓ 2/❓ 3 hvis besvaret, ellers ny research-iteration.

- **Iteration 17 (P1-2 del C):** Kunderapporten kan nu svare på det spørgsmål, en bureau-monitorering bliver bedt om: "hvad har uptime været de sidste 30 dage?". Indtil nu var der kun `Uptime (all)` — livstid, altså "100 % siden marts", som ikke siger noget om den seneste måned. Ny `src/history.js` skriver dags-buckets (to heltal pr. site pr. døgn) til `~/.deskuptime/history.json` i stedet for til `state.json`, fordi state skrives hvert pass og rummer licensnøglen, mens historikken vokser med tiden. Retention er strukturel, ikke aftalebaseret: 35 døgn pr. URL, 500 URL'er og pruning ved hver skrivning, så et år i en loop efterlader en fast, lille fil. Rapporten fik kolonnen `Uptime (window)` ved siden af `Uptime (all)`, og `--days N` (1–35) afløser det faste 30 — med en deterministisk fejl i stedet for at ignorere tallet, så en rapport aldrig påstår at dække en periode der ikke er gemt. Tre ærlighedsregler låst med test: et site uden registrerede døgn i vinduet viser `— (no pass in the last 30 d)` og **aldrig** 100 %; et døgn i fremtiden tæller ikke; `failures > checks` i en håndskrevet fil kan ikke give negativ uptime. Definitionen er `report.js`'s egen `uptimePercent()`, så livstid og vindue ikke kan komme i uoverensstemmelse. Historien skrives for alle tiers — to heltal pr. site pr. døgn, og en opgraderet gratisbruger skal ikke starte med en tom måned; det er rapporten, ikke optagelsen, der er Pro. Undervejs fundet og rettet en reel fejl ved designet: `historyFileFrom()` ignorerede i første version et omdirigeret `stateFile`, så `runPass` med en midlertidig state-fil ville have skrevet historien til den rigtige home-mappe; historien følger nu state-filen, og en test låser det på alle tre platforme. En skrivefejl i historien er desuden pakket i try/catch, fordi state-filen er source of truth og en tabt dag kun koster rapporten én kolonne, mens et kast ville stoppe al overvågning (bevis: mutation M4). 17 nye tests i `test/history.test.js`, ingen netværk, plus 4 mutationstests der alle fejler på den muterede kode. Node 26.7.0: `npm ci --ignore-scripts`, **167/167** tests, `npm run audit` 0/0, `node --check`, `matrix --check`, `sh -n`/`bash -n` og `git diff --check` grønne. Næste iteration: planlagte rapporter eller flere lokationer (kræver ❓ 2 + ❓ 3), ellers en ny research-iteration.

- **Iteration 16 (P2-1 del B):** To huller i den gratis CLI blev målt og lukket, og begge var reelle. `src/checkers/content.js` ryddede abort-timeren lige så snart `fetch` svarede og **før** den læste kroppen, så en server der sender headere og derefter går i stå gav et kald uden deadline — `watch` kunne hænge på ét URL for evigt. Beviset er mutationstesten: med den gamle kode udløber den nye test ved 30 s. Samtidig var `response.text()` ubegrænset, og watch-loopen læser alle URL'er hver pass. Nu er indholdstjekket begrænset til 2 MiB med streaming-annullering; en for stor side giver intet indholdssignal og **aldrig** en falsk DOWN, og `contentLength` er reelle bytes frem for UTF-16-tegn (den gamle værdi blev vist som "bytes" i CLI-output og i content-events). Licenskaldet fik én afgrænset genprøvning: et transient eller malformed svar prøves igen én gang efter 400 ms, mens et **verdikt** aldrig spørges om igen, et sundt svar stadig koster ét request, og et `Retry-After` over to sekunder gør, at vi slet ikke genprøver. Det er missionens prioritet 1 i praksis — før dette kunne ét 503 sende en betalende kunde ned i `cached`, og ét tabt netværkssvar starte uret på de 7 dages `unverified`. 14 nye tests, alle mod en lokal `node:http`-server, plus 6 mutationstests der alle fejler på den rækkede kode. Node 26.7.0: `npm ci --ignore-scripts`, **150/150** tests, `npm run audit` 0/0, `node --check`, `matrix --check`, `sh -n`/`bash -n` og `git diff --check` grønne. Næste iteration: P1-2 del C kræver ❓ 3, så ellers en ny research-iteration.

- **Iteration 15 (P1-2 del A + del B):** Den første rigtige bureau-rapport kom denne iteration. `docs/agency-report.md` er spec (målgruppe, datamodel, privacy, format, entitlement, og hvad der bevidst ikke er bygget), og `deskuptime report` er implementeret: Markdown med DOWN-sites først til en kunde, ren JSON til CI, `--title` til branding, read-only og uden konto. Uptime (`checksUp / checks`) defineres ét sted og viser `—`, ikke 100 %, når ingen pass er kørt. Matrix-rækken `status-page` gik fra *Planlagt* til implementeret, så README, `--help`, spec og npm-listen nu alle sælger den samme ting. Min egen test fandt en reel fejl undervejs: en URL med newline sprængte Markdown-tabellen, fordi `cell()` ikke fladede linjeskift. Pro-gaten bruger `isPro()`, så `unverified`/`invalid` aldrig får en rapport. Node 26.7.0: `npm ci --ignore-scripts`, **136/136** tests, `npm run audit` 0/0, `node --check`, `matrix --check`, `git diff --check` grønne. Næste iteration: P1-2 del C (30-dages historik, planlagt rapport — kræver ❓ 3) eller P2-1 del B (body-size-/licens-retrytests).

- **Iteration 1 (research):** Planen manglede ved start. Repoet, missionen, Stripe-/licenskontrakten, CLI/desktoparkitekturen, tests, releasefiler og dependency-status blev undersøgt. Ingen kode blev ændret ud over denne plan. Gate-baseline og prioriteret kø er registreret ovenfor.
- **Iteration 2 (P0-1, historisk):** Desktopbridge, lokal CSS/CSP, IPC-DTO, URL-validering, sikker DOM-rendering og redigeret licens-state blev implementeret og reviewet i commits `c63a52e` og `f0d4fa7`. Dengang var `npm test` 32/32, `cargo check --locked`, `cargo test --locked` 10/10 og `cargo tauri build --debug` på macOS grønne. Desktopkilden blev siden flyttet til det private repo; ubekræftet Windows-/interaktiv smoke overføres dertil.
- **Iteration 3 (P0-2):** Commit `6b81803` kræver Node 24 på tværs af CLI, workflows, Action og dokumentation, tilføjer lockfil/audit og afslutter den offentlige desktop-rekonciliering. Merge til `main` og push af begge grene skete 2026-09-25T06:54:55Z. Node 24.21.0, 26/26 tests, audit 0/0, YAML/shell/syntax/diff og to reviewpass er grønne; næste opgave er P0-3.
- **Iteration 4 (P0-3):** Commit `5f8ff4c` gør 4xx/5xx, redirects til fejl, timeout og connection refusal konsekvent DOWN i CLI, JSON, watch-status og GitHub Action, mens `reachable` fortsat betyder modtaget HTTP-svar. Batch-validering, strukturerede headers-fejl og seks lokale tests er tilføjet. Node 24.21.0, 32/32 tests, audit 0/0, syntax/diff og fresh review uden P0/P1 er grønne. Fast-forward-merge til `main` skete 2026-09-25T09:24:49Z; næste opgave er P0-4.
- **Iteration 5 (P0-4):** Commits `364ae0d` og `4e685df` gør `watch --once` single-pass, persisterende og exit-korrekt, gør `watch --status` read-only, latcher DOWN/SSL/content-begivenheder korrekt og forhindrer samtidige state-tab med et kortlevende process-lock. Temp-HOME- og CLI-tests dækker de seks acceptkriterier samt reviewfund. Node 24.21.0, 45/45 tests, audit 0/0, syntax/diff er grønne. Fast-forward-merge til `main` skete 2026-09-25T14:26:12Z; næste opgave er P0-5.
- **Iteration 6 (P0-5):** Commit `4024d08` gør produktobne ærlige. `docs/pro-alerts.md` er source of truth med kanalmatrix, webhook-payload, timeout/retry, offline-adfærd og privacy. README's email/Slack-claim og hjælpens email/push-claim er væk; `--webhook` uden Pro-licens lyder nu med købslink i stedet for at tie; webhook har 10 s timeout og returnerer status; gratis-grænsen peger på købslinket. Desktop-download peger på den verificerede release `desktop-v0.2.7`, ikke på et domæne uden download. 10 nye tests. Node 26.7.0, 55/55 tests, audit 0/0, syntax/diff grønne. Fast-forward-merge til `main` skete 2026-09-25T15:42:30Z. **Nyt fund:** live-siten `deskuptime.com` (verificeret HTTP 200) hævder stadig email-alerts for Desktop Pro → P0-12; næste iteration starter P0-12 og derefter P0-6.
- **Iteration 7 (P0-12 forsøgt + P0-6):** P0-12 blev undersøgt og fundet uudførlig her — sitens kilder er uden for repoet og uden for agentens `external_directory`-adgang, så opgaven er markeret `BLOCKED` med evidens, de fem konkrete site-ændringer og en verificeret måling af, at `/da/`-siden ingen email-claim har. Herefter blev P0-6 færdig i `e344531`: `getDeviceId` bruger ikke-tom `COMPUTERNAME` på native Windows, så én maskine ikke længre bruger to af tre Pro-pladser. Scheme'et låses i `test/fixtures/device-id.golden.json` (12 tilfælde, version 1) til deling med Rust-siden, og et nyt CI-job kører licenstestene på `windows-latest` med Node 24. Mutationstest bekræfter testenes dækning. Node 26.7.0, `npm ci --ignore-scripts`, 59/59 tests, audit 0/0, `node --check`, YAML/JSON og diff-check grønne. Fast-forward-merge til `main` og push af begge grene 2026-09-25. Næste iteration starter P0-7.
- **Iteration 8 (P0-7):** Licenslifecycle hærdet på `ceo/license-lifecycle`. Ethvert HTTP 200 uden gyldigt verdikt (`malformed`) er nu transient i stedet for permanent, så en Cloudflare-side ikke længere kan låse en betalende kunde ude; `408/425/429` er transient; hvert kald har 10 s hard timeout. `isPro()` respekterer nu `status: 'invalid'`, så en tilbagekaldt nøgle mister ubegrænsede URL'er og 30 s interval med det samme. State skrives `0600` i `0700`-mappe, licensrecordet valideres ved indlæsning, og `redactSecrets()` filtrerer nøgler og device-id'er ud af alle fejlstrenge. `deskuptime status` viser `active`/`cached/offline`/`invalid`/`free` med forklaring i stedet for "nøgle fundet". `docs/license-lifecycle.md` dokumenterer reglerne og stiller de Rust-krav, der ikke kan løses her. 23 nye tests; Node 26.7.0, `npm ci --ignore-scripts`, 82/82 tests, audit 0/0, `node --check` og `git diff --check` grønne; CLI'en kørt manuelt i alle fire tilstande; live-`validate` mod licensserveren bekræfter 404-klassificeringen. Merge til `main` og push af begge grene 2026-09-25. Næste iteration: P0-10, derefter P0-11.
- **Iteration 9 (P0-10 + P0-13):** To opgaver i samme iteration, begge små og begge committet. P0-10: `actions/checkout` 4 → 7 i alle fire workflows i `b27ba35` (ren pin-bump, ingen inputs bruges, eneste brydende v7-adfærd er relateret til triggere repoet ikke bruger); CI grøn. Derefter fandt en læsning af den røde selvmonitorering, at `eucomply-scan/stats` meldte DOWN med HTTP 404, mens curl og node-fetch svarede 200 — årsagen var, at reachability-checket kun sendte HEAD, og Workers matcher ikke HEAD-routes. P0-13 (`1d19697`) tilføjer én GET-retry ved 404/405/501 med GET som dominerende svar, delt `--timeout`-budget, annulleret GET-body og fem deterministiske tests; 87/87 tests, audit 0/0, Node 26.7.0, `node --check` og `git diff --check` grønne; den rigtige worker giver nu 200 UP med exit 0. Næste iteration: P0-11 (`actions/setup-node` 4 → 7), derefter P0-9.
- **Iteration 10 (P0-11 + P0-9a):** To opgaver, begge committet og mergeret. P0-11 (`6761f26`): `actions/setup-node` 4 → 7 i fire workflows plus README-snippet, ren pin-bump, CI-run `36174538867` grøn. Derefter faldt målingen af P0-9's releasevej, og den var værre end forventet: **bygget af tarballen var brudt** — `make_tarball.sh` fejlede sin egen self-check, fordi fillisten manglede `src/status.js` og `src/checkers/headers.js`, så ingen ny `v*-cli`-release kunne skæres, og installerede kopier døde med `ERR_MODULE_NOT_FOUND` på første kommando. P0-9a (`4defd8d`) pakker hele `src/`-træet, udvider self-checken til de dovent importerende kommandoer, skriver en `.sha256`-sidecar og tilføjer 9 tests, der bygger tarballen mod en lokal server og kører den udpakkede CLI. Versionsdrift målt samtidig: package 0.2.8 / nyeste `v*-cli` v0.2.5 / install.sh 0.1.4 — udskudt til P0-9b med en dokumenteret beslutningsmulighed. `npm ci --ignore-scripts`, 96/96 tests, audit 0/0, `node --check` og `git diff --check` grønne. Begge grene fast-forward-merget til `main` og pushet 2026-09-25. Næste iteration: P0-9b.
- **Iteration 11 (P0-9b):** P0-9b lukkede de to sidste huller i curl-stien. `install.sh` havde `VERSION="0.1.4"` fastlåst tre minorer under npm-versionen og udpakkede uden checksum; den løser nu den nyeste publicerede `v*-cli`-release via det read-only releases-API (kun releases med CLI-tarball-asset, højeste semver, drafts/prereleases sprunget over), verificerer den publicerede `.sha256` før `tar -xzf`, erstatter i stedet for fletter en tidligere installation, nægter en tarball uden `src/cli.js` og har ét Node-krav (`REQUIRED_NODE_MAJOR` + én `node_too_old()`). Undervejs blev det målt, at **ingen** af de 12 publicerede releases har et `.sha256`-asset, så afvigende sum er en hård fejl, mens manglende sidecar er en tydelig advarsel (hård fejl med `DESKUPTIME_REQUIRE_CHECKSUM=1`) — ellers ville merge have slået hver curl-install ihjel. `release-cli.yml` uploader nu tarball og sidecar i samme step og `diff`-er sidecaren mod `sha256sum` før upload. Det forkerte `deskuptime-0.1.3.tar.gz` er fjernet fra repo-roden. 9 nye tests i `test/install.test.js` kører det rigtige script mod en lokal HTTP-server (opløsning, manipulations-afvisning, manglende sidecar i begge modi, pin, fallback, erstatning, tarball uden cli.js, gammel Node, versions-drift). Node 26.7.0: `npm ci --ignore-scripts`, **105/105** tests, audit 0/0, `node --check`, `sh -n`/`bash -n`, YAML-parse, ingen tabs, `git diff --check` grønne. Live-evidence: den rigtige GitHub-feed installerer nu 0.2.5 i stedet for 0.1.4. Næste iteration: P1-1, med ❓ 10 (ny `v*-cli`-release) som Mads-afhængighed.
- **Iteration 12 (P1-1 del A):** Den versionsstyrede matrix blev source of truth for alle claims: ny `src/features.js` med produkt, pris, købs-/donations-/API-links, de håndhævede gratis-/Pro-grænser, 14 matrixrækker på både EN og DA med `implemented`-flag, og de præcis tre felter der sendes til licenserveren. `src/watch.js` og `src/license.js` læser konstanterne derfra, `--help` gengiver matrixen, og README + `docs/pro-alerts.md` §1/§5 er genererede blokke (`npm run matrix`; `--check` fejler på drift). Tre reelle fund blev lukket undervejs: `watch --once` afviste den fjerde URL med `Free tier monitors 3 URLs` **uden købslink** (watch-loopen havde den), hjælpebanneret var 6 tegn for smalt, og claims-testen låste på håndskrevne strenge. Ny `test/matrix.test.js` (8 tests) dækker generator-drift, alle rækker i begge sprog, at ikke-byggede kanaler (email/Slack/Discord/Teams/status-side/batch) ikke står i README eller `--help`, licensfelterne, gratisgrænsen mod en færdig `state.json` uden netværk, intervalhævningen mod en lokal HTTP-server og kontraktlinks + `FUNDING.yml`. Mutationstest: ændret `FREE` → 3 fejl, håndredigeret README-tabel → 2 fejl. Node 26.7.0: `npm ci --ignore-scripts`, **113/113** tests, `npm run audit` 0/0, `node --check`, `sh -n`/`bash -n`, YAML tab-fri og `git diff --check` grønne. P1-1 AC3 er `BLOCKED` på ❓ 8, AC5 afventer ❓ 1–3; nyt ❓ 0 spørger, om matrixen også skal eje siten og det private desktoprepo. Næste iteration: P1-1 del B eller P2-1.
- **Iteration 13 (P1-1 del B):** ❓ 9 blev besvaret i kode frem for i et spørgsmål. `deskuptime status` har nu fem tilstande, hvor `unverified` betyder "licensserveren svarer ikke, nøglen er aldrig afslået" — før hed den `invalid`, hvilket læses som en død nøgle og er den direkte vej til et dobbeltkøb. Tilstanden viser aldrig købslinket (kunden har betalt), mens `invalid` nu alene betyder "serveren afslog nøglen" og fortsat er den eneste tilstand med kasse. Undervejs fundet en fælde i min egen ændring: `isPro()` brugte `status !== 'invalid'`, så den nye tilstand ville automatisk have givet Pro; den er nu en allow-liste over `active`/`cached` plus legacy-state uden status-felt, dækket af en test. Samtidig blev npm-beskrivlingen gjort til den tredje genererede overflade fra `src/features.js` — den nævner Pro, prisen og de byggede kanaler, og kan ikke love en kanal, der ikke findes — og to nye tests i `test/matrix.test.js` låser ét købsflow pr. side (alle Stripe-links er kontraktens; kun de flader, der skal kunne købe, har et). Målingen før rettelsen viste 12 forekomster af kontraktens link og 0 af andre, så intet købsflow var brudt — kun usikkert. +5 tests → **118/118**; mutationstest (skriv `UNVERIFIED` tilbage som `INVALID`) giver 1 fejl i licenstesten. `docs/license-lifecycle.md` §2 er skrevet om til de fem tilstande. Node 26.7.0: `npm ci --ignore-scripts`, `npm test` 118/118, `npm run audit` 0/0, `node --check` alle JS-filer, `sh -n`/`bash -n`, `matrix --check`, ingen tabs og `git diff --check` grønne. Commit `eb2b134` på `ceo/status-unverified`, fast-forward-merget til `main` og pushet 2026-09-25. Næste iteration: P2-1 (deterministiske tests) eller P1-2 del A (spec for bureau-rapport/status-side).
- **Iteration 14 (P2-1 del A):** Målingen først fandt fire live-`example.com`-tests i `test/test.js`, en vakuum-assertion i watch-testen (promise'en resolver `null` både ved "vi dræbte den" og "den døde alene") og en Action, der **tæller uden at verificere** — `[]`, manglende `healthy` eller færre resultater end URL'er gav `down=0` og grøn kørsel. Da TLS-fixturen kom på plads, faldt en reel P0-fejl ud: `ssl.js` sendte SNI som IP-literal, hvilket Node 24+ afviser med en exception, så intet HTTPS-site overvåget på IP-adresse fik SSL-dage (og Action'en ville have meldt det sunde site som SSL-fejl). Rettet med `net.isIP`-gate. `test/test.js` er nu helt uden live-netværk (lokal HTTP-fixture + selvsigneret cert pr. kørsel via `openssl`, springer over uden openssl), watch-testen kan fejle, og Action'en validerer array, resultatantal og boolsk `healthy` før tællingen, med exit 1 og `::error::` ellers. +6 tests, heraf 5 gennem en stub-CLI der sender payloads den rigtige CLI ikke producerer, plus exit-2/exit-0-verifikation af fejlvejen. Node 26.7.0: `npm ci --ignore-scripts`, `npm test` **124/124**, `npm run audit` 0/0, `node --check`, `sh -n`/`bash -n` (også det udpakkede action-script), YAML tab-fri og `git diff --check` grønne. Mutationstest: genindsat `servername` → 2 fejl i 16; slettet valideringsblok → 2 fejl i 32. Næste iteration: P1-2 del A eller P2-1 del B.
- **Iteration 14, del 2 (CI-smoke):** Efter merge af del A blev den sidste live-afhængighed i gaten lukket: `ci.yml`'s smoke-step tjekkede `https://example.com`, så et site Mads ikke ejer kunne gøre hele repoets gate rød. Step'en kører nu en lokal fixture med både en UP- og en DOWN-route og fire `jq -e`-assertions, så jq både kan fejle og faktisk fejler på en DOWN. Negativ test lokalt: med `.[1].healthy == true` i stedet for `false` fejler step'en med jq exit 1 under `set -e`. `npm test` 124/124, `npm run audit` 0/0, `node --check`, YAML-parse af alle fem workflows (PyYAML) og `git diff --check` grønne på Node 26.7.0.
