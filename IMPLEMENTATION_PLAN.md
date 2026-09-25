# IMPLEMENTATION_PLAN.md

STATUS: I GANG
Iteration: 2 — 2026-09-25
Arbejdsgren: `ceo/desktop-security`
Næste handling: committér review-rettelserne, merge til `main`, og fortsæt med Windows-/interaktiv smoke før P0-1 afsluttes.

## Mission

DeskUptime er et open-source CLI og en Tauri desktop-tray-app til uptime-, SSL- og content-overvågning. Den gratis udgave skal være brugbar uden demo-agtige begrænsninger. Pro er den markant bedre løsning for små bureauer og IT-teams: ubegrænsede URLs, rapporter/status-side, flere lokationer, kanaler som mail og Slack/Discord/Teams-webhooks, automatisering og prioriteret support/compliance-dokumentation. Stripe Payment Link og licens-API må kun bruges i den aftalte form; der oprettes ikke nye produkter eller priser.

## Faste regler

- Default-branch er `main`; implementering på `ceo/<kort-slug>` og merge først efter grøn gate.
- Må ikke lave git-tags, releases, npm-publicering, deploys, produktionsmigreringer eller nye services.
- `.env*`, credentials og rå licensnøgler læses, skrives, logges eller committes aldrig.
- Produktion og ekstern checkout må ikke røres. Stripe-linket og den eksterne batch-deployer verificeres kun ved læsning.
- Én større funktion ad gangen; skriv en spec i `docs/` før større Pro-funktioner.
- Hver opgave skal have begrundelse, konkrete filer og verificerbare acceptkriterier.

## Baseline fra research

### Kvalitetsgate

Den første gate-definition er registreret her:

- Root: `npm test` (26 tests, 26 passed ved baseline).
- Root: `npm run lint` findes ikke i `package.json`; rapporteres som manglende gate, ikke som grønt.
- Root: `npm run build` findes ikke i `package.json`; der er ingen JS-build/typecheck-script.
- Desktop: `cargo check --manifest-path desktop/src-tauri/Cargo.toml --locked` passerede.
- Desktop: `cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked` passerede, men 0 tests blev fundet.
- Desktop: `cargo check/test` rapporterer to eksisterende `dead_code`-warnings i `desktop/src-tauri/src/engine/mod.rs`.
- `npm audit --omit=dev` kan ikke køre: der findes ingen npm-lockfile (`ENOLOCK`); det må ikke rapporteres som “0 sårbarheder”.

### Sikkerhed og afhængigheder

- Cargo-lockfilen indeholder `glib 0.18.5`, som Trivy/OSV markerer med `GHSA-wrw7-89jp-8q8g` / `RUSTSEC-2024-0429`; rettelse er `glib >= 0.20.0`. Den transitive GTK/Tauri-kæde skal opdateres kompatibelt, ikke ved en vilkårlig lockfile-editing.
- Den nuværende Tauri-frontend indlæser ubundet JavaScript fra `https://cdn.tailwindcss.com`, mens CSP'en tillader remote scripts og brede HTTPS-kilder. Frontendens `get_license_state` deserialiserer også den rå licensnøgle. Det er en bekræftet trust-boundary/svaghed, før den næste desktopudgivelse.
- Der er ingen npm-dependencies, men der mangler en låst npm-pakke-/auditstrategi. Dependabot dækker npm og GitHub Actions, ikke Cargo.
- Runtime: `package.json` kræver Node `>=18`; CI kører Node 20 og 22; installeren siger fejlagtigt “Node.js 16+”. Den understøttede runtime skal afklares og ensrettes før release.

### Korrekthed og brugerrejse

- `src/checkers/ping.js:25-31,55-62` markerer ethvert HTTP-svar som reachable; 404/500 kan derfor blive UP og grønne i CLI/GitHub Action.
- `src/cli.js:227-250` parser ikke `watch --once` eller `watch --status`, selv om README dokumenterer dem; begge kan hænge i den uendelige loop.
- `src/watch.js:67-93,172-220` undertrykker første DOWN som “baseline”, gentager SSL-advarsler, og beregner Pro-begrænsninger kun ved start.
- `src/watch.js:119-135` har webhook uden timeout/retry/outbox, og README/help lover email/Slack/push, som ikke findes i koden.
- Desktop har manglende eller uverificeret Tauri-JS-bridge, camelCase/snake_case IPC-mismatch, URL-input i `innerHTML`, rå licensnøgle i frontend-state og manglende desktop-paritet for content/SSL-hændelser.
- `src/license.js:14,40-42` bruger `os.hostname()`, mens Rust bruger `COMPUTERNAME` på Windows. På berørte maskiner kan CLI og desktop derfor bruge to licenspladser. Gemte `license.instance`/`instance_id` migrerer ikke automatisk ved en generatorændring.
- `tools/make_tarball.sh:14` udelader `src/checkers/headers.js`; `tools/install.sh:6` er fastsat til 0.1.4; npm/tarball/desktop-versioner er ikke synkroniserede.
- Den eksterne produktside og Stripe-fulfillment ligger uden for repoet og kan ikke verificeres endeligt her.

## Prioriteret kø

### P0-1 — I GANG — Gør desktopappen brugbar og sikker

**Begrundelse:** Den betalte desktopapp er kernedifferentieringen, men den nuværende frontend kan være uden Tauri-bridge, og remote script + rå nøgle gør webview'en tillidskritisk. Det er en reel købs- og brugerfejl.

**Omfang:**

- Giv Tauri-v2 en verificeret global/local bridge og test den i en rigtig desktop-build.
- Ret frontendens IPC-DTO, så `CheckResultSummary` og manuelle checks bruger samme snake_case-contract som Rust.
- Fjern remote executable Tailwind-runtime; bundl lokal CSS eller en anden verificeret lokal asset. Stram CSP'en.
- Returnér en redigeret licens-DTO til frontend; hold rå nøgle i backend-lagring og aldrig i UI-state, events eller logs.
- Valider og canonicalisér kun `http`/`https` i Rust-backend; frontend-input må ikke være eneste barriere.
- Erstat URL-/result-interpolation med sikker DOM-rendering.

**Acceptkriterier:**

1. En packet macOS- og Windows-smoke-test kan åbne appen, tilføje URL, køre manuel check og fortsætte med baggrundsmonitor.
2. URL og resultat overlever genstart.
3. Malicious URL-streng med quotes, `<`, `>` og event-handler-tekst renderes som tekst og skaber ingen ekstra DOM-node eller request.
4. `get_license_state` og alle frontend-events har ingen `license_key`/rå nøgle.
5. Der er ingen remote script-kilde eller bred `script-src` i produktions-CSP.
6. IPC-regressionstest dækker reachable, down, status, timing, SSL-null og fejl.

**Status 2026-09-25:** Implementeret på `ceo/desktop-security`: Tauri bridge og lokal CSS uden remote executable assets, stram CSP, minimal event capability, canonical URL-validering i Rust, snake_case IPC, sikker DOM-rendering og redigeret licens-DTO. `npm test` er grøn med 32/32; `cargo check --locked` og `cargo test --locked` er grønne med 10 tests. `cargo tauri build --debug` byggede macOS-appen og DMG'en. Fresh review fandt ingen P1; stale event-resultater, URL-state-race og query-streng i notifikationer blev rettet. Licensrefresh-race, atomisk `0600`-lagring og bekræftet deactivation udskydes til P0-7. Windows- og interaktiv smoke-test mangler stadig før P0-1 kan afsluttes.

**Mulige filer:** `desktop/frontend/index.html`, `desktop/frontend/app.js`, `desktop/frontend/styles.css`, `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/capabilities/default.json`, `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/src/monitor.rs`, `test/desktop.test.js`.

### P0-2 — TODO — Ret afhængighedssikkerhed og runtime

**Begrundelse:** En bekræftet Cargo-transitiv sårbarhed skal før opgraderinger eller release; samtidig gør den manglende runtime-/auditstrategi builds uforudsigelige.

**Acceptkriterier:**

1. `glib`-grafen er opdateret til en version `>=0.20.0` gennem en kompatibel Tauri/GTK-opgradering, eller linux-understøttelsen er eksplicit lukket med dokumenteret begrundelse.
2. `cargo check --locked`, `cargo test --locked` og en aktuel Trivy/OSV-scan er grønne uden den konkrete advisory.
3. Der er én dokumenteret Node-runtime; `engines`, `.nvmrc` (hvis Node-flåden kræver det), CI-matrix og `tools/install.sh` siger det samme.
4. Der er en plan for npm-lockfile/audit og Cargo-audit/Dependabot, uden at swappe flere majors i én commit.
5. Hvert major-opgraderingscommit noterer fra/til-version og eventuelle kodeændringer i planen.

### P0-3 — TODO — Gør uptime-status og fejlhåndtering sand

**Begrundelse:** En 404/500 må ikke rapporteres som UP; det er den mest konkrete fejl i købs- og CI-flowet.

**Acceptkriterier:**

1. Der er en dokumenteret statuspolitik, fx `reachable` = svar modtaget og `healthy`/down = final status `>=400`; Node CLI, Action og Rust bruger samme beslutning.
2. Deterministic lokale fixtures dækker 200, 204, redirect-til-200, 400, 404, 410, 500, timeout og connection refusal.
3. CLI JSON, human output, exit codes, Action `down-count` og desktop UI/notification er enige for hver fixture.
4. Én ugyldig URL i en fler-URL-kørsel fejler konfigurationskørslen i stedet for at blive sprunget over.
5. `headers`-fejl returnerer et struktureret resultat og kan ikke crashinge output/loop.

### P0-4 — TODO — Gør watch-kommandoerne ægte

**Begrundelse:** README's cron-opskrift `watch --once` og statusvisning `watch --status` er aktive, men regressionen kan efterlade cron-processer kørende.

**Acceptkriterier:**

1. `watch URL --once` laver præcis én pass, gemmer state og afslutter med dokumenteret exit code.
2. `watch --status` laver nul netværkskald og ændrer ikke state ved blot at læse.
3. Første pass med DOWN siger enten DOWN-begivenhed eller “baseline recorded: DOWN”; “all monitored sites OK” er aldrig falsk.
4. Tre ens SSL-under-tærskel-pass giver én SSL-begivenhed; recovery og senere ny krydsning resetter korrekt.
5. Content- og status-transitionsekvenser er dækket af isolerede temp-HOME-tests.
6. `HOME`/`USERPROFILE` håndteres på Windows, og `--help` matcher README.

### P0-5 — TODO — Skriv Pro-spec og gør produktobne ærlige

**Begrundelse:** Betalte brugere betaler i dag for en delvist manglende værdi; email/Slack/desktop-webhook er lovet, men kun generisk CLI-webhook findes.

**Før implementering:** Opret `docs/pro-alerts.md` (eller tilsvarende) med kanalmatrix, payloadschema, timeout/retry, auth/signering, offline-adfærd, pris/entitlement og privacy.

**Acceptkriterier:**

1. Én matrix bestemmer gratis/Pro for CLI one-off, CLI watch, desktop, tray/local notifications, ubegrænsede URLs, email, webhook, Slack/Discord/Teams, rapporter og batch.
2. Hver lovet kanal har implementering eller fjernes fra alle kundeflader; ingen “coming soon”-claim i købsflowet.
3. Gratisbrugere får en tydelig, ikke-forstyrrende upgrade-vej hvor de mangler funktionen.
4. Ét køb-link pr. side, kun det aftalte DeskUptime Pro-link; donationen forblir diskret og bruges kun ved naturligt tak.
5. Specen er godkendt før en større Pro-implementering; ingen nye Stripe-produkter/priser.

### P0-6 — TODO — Ensret Windows device_id

**Begrundelse:** Åbent produktpunkt fra 24/9: CLI og desktop kan tælle én maskine som to pladser.

**Beslutning:** Start med minimal fiks: CLI bruger ikke-tom `COMPUTERNAME` på native Windows og ellers `os.hostname()`. Skriv ikke eksisterende state-id om uden dokumenteret server-migration.

**Acceptkriterier:**

1. Deterministiske JS-tests dækker Windows precedence, non-Windows fallback, trim/lowercase, tom værdi og 128-tegns grænse.
2. CLI- og Rust-golden fixtures giver samme ID for samme input.
3. Native Windows CI kører licenstest.
4. En aktiverings-/deaktiveringstest på samme maskine bruger én enhed, også når den aktiveres fra begge klienter.
5. Hvis en eksisterende installation har et gammelt gemt id, findes en dokumenteret migrerings-/alias-proces før den erklæres løst.

### P0-7 — TODO — Hårdgør licenslifecycle

**Begrundelse:** Betalende brugere må ikke låses ude ved timeout/5xx, men revoked/expired må heller ikke fortsætte at få Pro.

**Acceptkriterier:**

1. Node og Rust har hård total timeout, 429/408/5xx og malformed 200 håndteres som transient med syv-dages cached grace.
2. 403/404/409 og definitive invalideringer slår Pro fra med det samme; nøglen bevares til senere diagnose.
3. `status` viser `active`, `cached/offline`, `invalid` eller `free`, ikke bare “nøgle findes”.
4. Desktop deactivation venter på serverens `deactivated: true` før lokal state slettes; timeout/fejl rapporteres som pending uden at lyve.
5. State-/licensfiler er `0600` på POSIX, atomisk skrevet og valideres ved indlæsning.
6. Rå nøgler, følsomme URL-query-strings og device-identiteter logges ikke.

### P0-8 — TODO — Gør desktop-overvågning feature-paritet

**Begrundelse:** Desktop er betalt produkt; Rust beregner i dag content-hash uden at sammenligne den, og SSL/content-events mangler.

**Acceptkriterier:**

1. For hver URL gemmes forrige content fingerprint.
2. Baseline A, uændret B, ændret C og recovery A-A giver præcis reelle overgangsevents.
3. UI og native notification viser content/SSL-overgang; baggrundsmonitoret bruger samme entitlements som CLI.
4. Node/Rust conformance fixtures giver identisk hash- og ændringsbeslutning.
5. URL-fejl/timeouts kan ikke låse monitorloopen.

### P0-9 — TODO — Ret release- og distributionsvejen

**Begrundelse:** Nuværende curl-tarball mangler `headers`, installer peger på 0.1.4, og versionerne `0.2.8`/`0.2.7`/`0.1.4`/`v0.1` er modstridende.

**Acceptkriterier:**

1. Én autoritativ version driver package, Tauri, Cargo, UI og installer/release-artefakter.
2. Tarball indeholder alle dynamisk importerede runtime-filer, især `src/checkers/headers.js`.
3. Ekstraheret tarball består `--version`, `check`, `headers --json`, `watch --once`, `watch --status` og license-help.
4. Checksum publiceres og verificeres før install; Node-versionstjek matcher `engines`.
5. CI/release-triggerne har én owner pr. tagtype; ingen release/publish udføres af agenten.
6. npm-pakken, curl-stien og Homebrew-formlen dokumenteres med samme version og Stripe-link.

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

**Begrundelse:** Nuværende Node-tests er delvist live-netværksafhængige, Rust har 0 tests, og Action-smoke-assertionen kan ikke fejle på `false`.

**Acceptkriterier:**

1. Lokale HTTP/TLS-fixtures erstatter afhængighed af `example.com` i unit/integrationstests.
2. Node-, Rust- og Action-resultater dækkes af den samme statusmatrix.
3. Der tilføjes timeout-, body-size-, webhook- og license-retrytests.
4. Action bruger `jq -e` eller en assertion, der faktisk fejler ved forkert resultat.
5. `cargo fmt --check` og passende clippy/test gates dokumenteres, hvis værktøjerne findes.

## Dependency- og opgraderingslog

- `2026-09-25`: `npm test`: grøn, 32/32.
- `2026-09-25`: `npm run lint`: mangler script.
- `2026-09-25`: `npm run build`: mangler script.
- `2026-09-25`: `cargo check --locked`: grøn; kun to eksisterende `dead_code`-warnings i `desktop/src-tauri/src/engine/mod.rs`.
- `2026-09-25`: `cargo test --locked`: grøn, 10 tests.
- `2026-09-25`: `cargo tauri build --debug`: grøn på macOS; producerede lokal app og DMG efter review-rettelser.
- `2026-09-25`: Fresh code review: ingen P1; tre P2 rettet (stale event-resultater, URL-state-race, forældet notifikations-URL).
- `2026-09-25`: Licensrefresh-race, atomisk `0600`-lagring og deactivation-bekræftelse er bekræftede P0-7-follow-ups, ikke P0-1.
- `2026-09-25`: `cargo fmt -- --check`: rapportérer eksisterende formateringsafvigelser på tværs af eksisterende Rust-filer; ikke ændret i denne iteration.
- `2026-09-25`: `npm audit --omit=dev`: ikke mulig uden lockfile; ikke klassificeret som grøn.
- `2026-09-25`: Trivy/OSV fandt `glib 0.18.5`, fixed i `0.20.0`; kræver kompatibel Tauri/GTK-opgradering.
- Ingen større dependency-opgradering er udført i denne iteration.

## ❓ Til Mads

1. Hvad er den endelige gratis/Pro-matrix? Skal desktoptray og lokale notifications være gratis, eller kun Pro? README, kode og mission peger i dag i forskellige retninger.
2. Skal Pro email og Slack/Discord/Teams implementeres nu, eller skal de fjernes fra kundeclaims indtil de findes? Den nuværende kode understøtter kun CLI-generisk webhook.
3. Hvilken rapport/status-side skal være første bureau-feature, og hvilke data må en kunde-rapport indeholde?
4. Skal det eksisterende Stripe Payment Link verificeres manuelt for pris, valuta, fulfillment og license-key før næste release? Ingen betaling eller Stripe-write udføres af agenten.
5. Er der allerede Mahope/Stripe-aktiveringer fra pre-release Windows-builds, der kræver device_id-migration? Det afgør, om minimal generator-fix er nok.
6. Pro-navne, hvis et nyt brand senere ønskes: **DeskUptime Pro** (trygt og tydeligt), **Uptime Desk** (kortere), **Watchtower** (produktnavn, men bruges ofte) eller **Signal Monitor**. Ingen produkter, der allerede er i Stripe, omdøbes uden Mads' beslutning.
7. Hvilken Node LTS skal den næste release erklære, når Node 18/20 er ude af understøttelse?

## Deploy-/release-noter

- Dette repo har ingen egen live-deploy. Den eksterne batch-deployer deployer ikke automatisk ved merge.
- Efter hver merge/push til `main` skal der tilføjes `VERIFICÉR DEPLOY: <ændring> <commit-sha> <tidspunkt>`.
- Livestatus skal verificeres ved læsning af faktisk indhold; HTTP 200 alene beviser ikke ny kode.
- VERIFICÉR DEPLOY: researchplan `812f469` 2026-09-24T23:44:36Z
- VERIFICÉR DEPLOY: desktop-sikkerhedsbridge, lokale frontend-assets og IPC-rettelser `f0d4fa7` 2026-09-25T05:12:31Z

## Iterationslog

- **Iteration 1 (research):** Planen manglede ved start. Repoet, missionen, Stripe-/licenskontrakten, CLI/desktoparkitekturen, tests, releasefiler og dependency-status blev undersøgt. Ingen kode blev ændret ud over denne plan. Gate-baseline og prioriteret kø er registreret ovenfor.
