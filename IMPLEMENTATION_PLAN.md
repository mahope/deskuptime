# IMPLEMENTATION_PLAN.md

STATUS: I GANG
Iteration: 10 — 2026-09-25
Arbejdsgrene: `ceo/actions-setup-node-v7` (P0-11) og `ceo/tarball-completeness` (P0-9a)
Næste handling: P0-11 (`6761f26`) og P0-9a (`4defd8d`) er mergeret 2026-09-25. Næste iteration tager **P0-9b**: installér skal finde den nyeste publicerede `v*-cli`-release og verificere checksum før udpakning. Versionsdriften er målt og dokumenteret nedenfor — læs P0-9b's fund, før du ændrer install.sh.

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
- Root: `npm test` (96 tests, 96 passed på Node 26 efter P0-9a: 87 + 9 tarballtests).
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

**Del B — TODO (næste iteration):** se P0-9b.

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

### P0-9b — TODO — Én version i installér og verificeret checksum

**Begrundelse:** Del A gjorde tarballen komplet, men to huller lukkes ikke af sig selv, og begge rammer den kurve, der installerer med `curl | bash`. Målt 2026-09-25: `tools/install.sh:6` har `VERSION="0.1.4"`, mens `package.json` er 0.2.8 og den nyeste publicerede `v*-cli` er v0.2.5-cli. Installéreren kan altså ikke få den version, README's curl-sti ligner på, og ingen published checksum verificeres før udpakning (AC4 i P0-9).

**Beslutning at træffe (eller kør den åbenlyst):** hard-pinned version med en driftstest mod `package.json` (simpelt, men drifter igen ved næste release) **eller** opløsning af den nyeste publicerede `v*-cli`-release via GitHub-releases-API med hardcoded fallback (selvopdaterende, men afhænger af et read-only API-kald; der må ikke bruges tokens). Uanset valg skal `release-cli.yml` uploade `.sha256` sammen med tarballen, ellers kan installéreren ikke verificere noget.

**Acceptkriterier:**

1. `install.sh` installerer en version, der faktisk findes som `v*-cli`-release, og siger tydeligt hvilken version den fik.
2. Checksum verificeres mod den publicerede `.sha256` **før** udpakning; en afvigende sum giver en deterministisk fejl og intet installeres.
3. Node-versionstjekket i installéreren matcher `engines` (`>=24`) — i dag to hårdkodede beskeder, der skal stamme fra én kilde.
4. `release-cli.yml` uploader `deskuptime-<ver>.tar.gz` **og** `.sha256` i samme step, så AC2 er opfyldt uden manuel handling.
5. En deterministisk test dækker installationsstien (versionsopløsning og checksum-verifikation) uden netværksafhængighed; den må fejle mod en manipulér sum.
6. `brew`-formlen, npm-pakken og README's curl-sti peger på samme version, og ingen release/publish udføres af agenten.
7. Bemærk til P2: det committede `deskuptime-0.1.3.tar.gz` i repo-roden er et gammelt byggeartefakt (10 KB gammel kildekode i det offentlige repo). Bør fjernes — ikke gjort her, da det er et unlink uden for denne opgaves omfang.

### P1-1 — TODO — Hæd dokumentation, konvertering og åben kerne

**Begrundelse:** Kunder skal kunne forstå gratis/Pro, købe med ét link og bruge den samme truthful beskrivelse på README, CLI-help, npm, desktop og site.

**Acceptkriterier:**

1. Én versionsstyret featurematrix bruges på alle overflader.
2. README/help retter `watch` og kanalclaims, og beskriver præcist hvilken data der sendes til licensserveren.
3. Produkt-sidekilder eller en dokumenteret source-of-truth findes; EN/DA/llms/npm/UI bliver konsistente.
4. Det eksisterende Stripe-link (`https://buy.stripe.com/7sY9AS9eX3Iu418fJ5bMQ01`) og donation-linket bruges konsistent, uden nye produkter.
5. `❓`-beslutninger om email, gratis desktoptray, rapport/status-side og prioriteret support er besvaret før konkrete claims låses.

### P1-2 — TODO — Byg dokumenteret Pro-værdi for bureauer

**Begrundelse:** Efter korrekt grundfunktionalitet er batch/status-side, flere lokationer, kunderapport og prioriteret support de næste tydelige betalingsmotiver.

**Acceptkriterier:**

1. Spec i `docs/` beskriver målgruppe, datamodel, privacy, report-format, eksport og pris/entitlement.
2. En minimal rapport/status-side kan genereres fra eksisterende checks og deles uden konto.
3. Batch/automatisering har idempotente jobs, tydelig kørselstatus og testbare grænser.
4. Rapporter, webhook-events og kundelinks har dokumenterede retention-/redaction-regler.
5. Ingen betalt fil eller privat kundedata committes til dette offentlige repo.

### P2-1 — TODO — Hæd deterministiske tests og drift

**Begrundelse:** Nuværende Node-tests er delvist live-netværksafhængige, og Action-smoke-assertionen kan ikke fejle på `false`.

**Acceptkriterier:**

1. Lokale HTTP/TLS-fixtures erstatter afhængighed af `example.com` i unit/integrationstests.
2. Node- og Action-resultater dækkes af den samme statusmatrix.
3. Der tilføjes timeout-, body-size-, webhook- og license-retrytests.
4. Action bruger `jq -e` eller en assertion, der faktisk fejler ved forkert resultat.
5. Den offentlige Node-gate udvides kun hvis nye værktøjer eller konkrete fejl gør det nødvendigt.

## Dependency- og opgraderingslog

### Aktuel offentlig CLI

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

1. Hvad er den endelige gratis/Pro-matrix? Skal desktoptray og lokale notifications være gratis, eller kun Pro? README, kode og mission peger i dag i forskellige retninger.
2. Skal Pro email og Slack/Discord/Teams implementeres nu, eller skal de forblive uden for matrixen, indtil de er bygget? P0-5 har fjernet dem fra alle overflader i dette repo og noteret dem som ikke-implementeret; **live-siten `deskuptime.com` hævder stadig email for Desktop Pro**, og rettelsen ligger uden for dette repo (P0-12 er `BLOCKED`). Svar på spørgsmålet afgør både næste CLI-opgave og sitens claim.
3. Hvilken rapport/status-side skal være første bureau-feature, og hvilke data må en kunde-rapport indeholde?
4. Skal det eksisterende Stripe Payment Link verificeres manuelt for pris, valuta, fulfillment og license-key før næste release? Ingen betaling eller Stripe-write udføres af agenten.
5. Er der allerede Mahope/Stripe-aktiveringer fra pre-release Windows-builds, der kræver device_id-migration? Det afgør, om minimal generator-fix er nok.
9. Skal `deskuptime status` få et femte ordensord, fx `unverified`, for "licensen kunne ikke verificeres i 7 dage, serveren svarer ikke"? Nu vises den som `invalid` med en forklaring, der *siger*, at nøglen aldrig blev afslået. Fælden er, at kunden kan tro nøglen er død og købe igen. Fire ord rækker til kontraktens krav, men et eget ord er ærligere.
6. Pro-navne, hvis et nyt brand senere ønskes: **DeskUptime Pro** (trygt og tydeligt), **Uptime Desk** (kortere), **Watchtower** (produktnavn, men bruges ofte) eller **Signal Monitor**. Ingen produkter, der allerede er i Stripe, omdøbes uden Mads' beslutning.
7. Skal den betalte desktopkilde, som stadig findes i offentlig Git-history før `39c434f`, fjernes via en separat historikskrivning af Mads? Agenten gennemfører aldrig force-push eller historik-rewrite.
8. **Hvilket repo indeholder kilden til `deskuptime.com`?** P0-12 er `BLOCKED`, fordi sitens HTML ikke ligger i dette repo, og agenten ikke må læse det formodentlige `~/Projects/hermes/hermes-passiv`. Giv enten adgang til det repo, eller lav de fem konkrete rettelser i P0-12 selv. Dette er det mest synlige købs-flow, der i dag lover noget, der ikke findes.

## Deploy-/release-noter

- Dette offentlige repo er en npm-/GitHub-CLI og har ingen live-deploytarget. `STATUS.md` noterer 24/9, at `deskuptime.com` ikke er købt; derfor oprettes ingen `VERIFICÉR DEPLOY`-note for CLI-merges.
- De tidligere noter for researchplan `812f469` og desktop `f0d4fa7` var fejlagtige og er fjernet med denne planrevision.
- Merge til `main` deployer ikke; npm, GitHub Releases og Homebrew må kun publiceres af Mads via de eksisterende tag-workflows.

## Iterationslog

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
- **Iteration 10 (P0-11):** `actions/setup-node` 4 → 7 i alle fire workflows i `6761f26` (fem pin-bumps) plus README's forbruger-snippet, som Dependabot PR #2 ikke rører. Gennemgået før merge: v5/v6's automatiske caching kræver et `packageManager`-felt, som repoet ikke har; v7 fjerner dummy-`NODE_AUTH_TOKEN`, og `publish.yml` sætter selv token fra secrets, så publish er upåvirket. `npm ci --ignore-scripts`, 87/87 tests, `npm run audit` 0/0, YAML-parse, ingen tabs og `git diff --check` grønne; CI-run `36174538867` grøn i begge jobs. Fast-forward-merge til `main` og push af begge grene 2026-09-25. Næste iteration: P0-9.
