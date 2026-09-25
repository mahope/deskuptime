# IMPLEMENTATION_PLAN.md

STATUS: I GANG
Iteration: 3 — 2026-09-25
Arbejdsgren: `ceo/runtime-audit`
Næste handling: start P0-3 og gør 4xx/5xx, timeouts og connection refusal ensartede i CLI, GitHub Action og JSON.

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
- Root: `npm test` (26 tests, 26 passed ved aktuel baseline).
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

- `src/checkers/ping.js:25-31,55-62` markerer ethvert HTTP-svar som reachable; 404/500 kan derfor blive UP og grønne i CLI/GitHub Action.
- `src/cli.js:227-250` parser ikke `watch --once` eller `watch --status`, selv om README dokumenterer dem; begge kan hænge i den uendelige loop.
- `src/watch.js:67-93,172-220` undertrykker første DOWN som “baseline”, gentager SSL-advarsler, og beregner Pro-begrænsninger kun ved start.
- `src/watch.js:119-135` har webhook uden timeout/retry/outbox, og README/help lover email/Slack/push, som ikke findes i koden.
- Desktopparitet, IPC- og UI-fund er overført til `mahope/deskuptime-desktop`; de skal ikke genåbnes i dette offentlige CLI-repo.
- `src/license.js:14,40-42` bruger `os.hostname()`, mens Rust bruger `COMPUTERNAME` på Windows. På berørte maskiner kan CLI og desktop derfor bruge to licenspladser. Gemte `license.instance`/`instance_id` migrerer ikke automatisk ved en generatorændring.
- `tools/make_tarball.sh:14` udelader `src/checkers/headers.js`; `tools/install.sh:6` er fastsat til 0.1.4; npm/tarball/desktop-versioner er ikke synkroniserede.
- Den eksterne produktside og Stripe-fulfillment ligger uden for repoet og kan ikke verificeres endeligt her.

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

### P0-6 — TODO — Ensret Windows device_id i CLI

**Begrundelse:** Åbent produktpunkt fra 24/9: CLI og privat desktop-app kan tælle én maskine som to pladser. Denne iteration kan kun rette og conformance-teste Node-generatoren.

**Beslutning:** Start med minimal fiks: CLI bruger ikke-tom `COMPUTERNAME` på native Windows og ellers `os.hostname()`. Skriv ikke eksisterende state-id om uden dokumenteret server-migration.

**Acceptkriterier:**

1. Deterministiske JS-tests dækker Windows precedence, non-Windows fallback, trim/lowercase, tom værdi og 128-tegns grænse.
2. Native Windows CI kører licenstest med Node 24.
3. Et versioneret Node golden fixture giver den tilsigtede id-generator; Rust-golden og fælles maskintest følger i `mahope/deskuptime-desktop`.
4. En eksisterende installation med et gammelt gemt id kræver en dokumenteret migrerings-/alias-proces i det private repo, før cross-client-opløsning erklæres færdig.

### P0-7 — I DELT — Hårdgør licenslifecycle

**Begrundelse:** Betalende brugere må ikke låses ude ved timeout/5xx, men revoked/expired må heller ikke fortsætte at få Pro. Node-delen er offentlig; desktopdeactivation og Rust-timeouts følger i det private repo.

**Acceptkriterier:**

1. Node har hård total timeout, 429/408/5xx og malformed 200 håndteres som transient med syv-dages cached grace; Rust-kravet følger privat.
2. 403/404/409 og definitive invalideringer slår Pro fra med det samme; nøglen bevares til senere diagnose.
3. `status` viser `active`, `cached/offline`, `invalid` eller `free`, ikke bare “nøgle findes”.
4. Desktop deactivation venter på serverens `deactivated: true` før lokal state slettes; denne accept testes i `mahope/deskuptime-desktop`.
5. Node state-/licensfiler er `0600` på POSIX, atomisk skrevet og valideres ved indlæsning; Rust gør det samme privat.
6. Rå nøgler, følsomme URL-query-strings og device-identiteter logges ikke.

### P0-8 — PRIVAT REPO — Gør desktop-overvågning feature-paritet

**Begrundelse:** Desktop er betalt produkt; Rust beregner i dag content-hash uden at sammenligne den, og SSL/content-events mangler. Denne opgave ejes af `mahope/deskuptime-desktop`.

**Acceptkriterier:**

1. For hver URL gemmes forrige content fingerprint.
2. Baseline A, uændret B, ændret C og recovery A-A giver præcis reelle overgangsevents.
3. UI og native notification viser content/SSL-overgang; baggrundsmonitoret bruger samme entitlements som CLI.
4. Node/Rust conformance fixtures giver identisk hash- og ændringsbeslutning.
5. URL-fejl/timeouts kan ikke låse monitorloopen.

### P0-9 — TODO — Ret release- og distributionsvejen

**Begrundelse:** Nuværende curl-tarball mangler `headers`, installer peger på 0.1.4, og versionerne `0.2.8`/`0.2.7`/`0.1.4`/`v0.1` er modstridende.

**Acceptkriterier:**

1. Én autoritativ version driver package, public CLI-metadata og installer/release-artefakter; Tauri/Cargo-versionen følger i det private desktoprepo.
2. Tarball indeholder alle dynamisk importerede runtime-filer, især `src/checkers/headers.js`.
3. Ekstraheret tarball består `--version`, `check`, `headers --json`, `watch --once`, `watch --status` og license-help.
4. Checksum publiceres og verificeres før install; Node-versionstjek matcher `engines`.
5. CI/release-triggerne har én owner pr. tagtype; ingen release/publish udføres af agenten.
6. npm-pakken, curl-stien og Homebrew-formlen dokumenteres med samme version og Stripe-link.

### P0-10 — TODO — Opgrader actions/checkout 4 → 7 i en commit

**Begrundelse:** Dependabot PR #3 er ren og foreslår den aktuelle major; brugerkontrakten kræver én major-opgradering pr. commit.

**Acceptkriterier:**

1. PR #3 eller en tilsvarende minimal branch opgraderer kun `actions/checkout` 4 → 7.
2. Hele Node 24-gaten er grøn efter merge.
3. Ingen anden action-opgradering, release eller npm-publish følger med.

### P0-11 — TODO — Opgrader actions/setup-node 4 → 7 i en commit

**Begrundelse:** Dependabot PR #2 er ren og foreslår den aktuelle major; den skal merge separat efter P0-10.

**Acceptkriterier:**

1. PR #2 eller en tilsvarende minimal branch opgraderer kun `actions/setup-node` 4 → 7.
2. Hele Node 24-gaten er grøn efter merge.
3. Ingen anden action-opgradering, release eller npm-publish følger med.

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

- `2026-09-25`: Node-runtime `>=18` → `>=24`, den aktive LTS. Verificeret med Node 24.21.0; ingen application-kodeændring udover help-tekst var nødvendig.
- `2026-09-25`: Nul runtime-/dev-dependencies bevaret; `package-lock.json` v3 tilføjet. `npm ci --ignore-scripts` og `npm run audit` er grønne med 0 sårbarheder.
- `2026-09-25`: `npm test` er grøn med 26/26; `npm run lint` og `npm run build` findes ikke.
- `2026-09-25`: Actions-størrelserne 4 → 7 ligger i rene Dependabot PR #2 og #3 og udskydes til separate P0-10/P0-11-commits.

### Historisk desktop-iteration før repoopdelingen

- `2026-09-25`: Desktopens daværende gate var `npm test` 32/32, `cargo check --locked`, `cargo test --locked` 10/10 og `cargo tauri build --debug` på macOS.
- `2026-09-25`: Fresh review fandt ingen P1; tre P2 blev rettet. Licensrefresh-race, atomisk `0600`-lagring og deactivation-bekræftelse blev bekræftet som private follow-ups.
- `2026-09-25`: `cargo fmt -- --check` rapporterede formateringsafvigelser i den daværende Rust-kode.
- `2026-09-25`: Før denne iteration kunne `npm audit` ikke køre uden lockfile. Trivy/OSV fandt `glib 0.18.5`; advisoryen følger nu det private desktoprepo.

## ❓ Til Mads

1. Hvad er den endelige gratis/Pro-matrix? Skal desktoptray og lokale notifications være gratis, eller kun Pro? README, kode og mission peger i dag i forskellige retninger.
2. Skal Pro email og Slack/Discord/Teams implementeres nu, eller skal de fjernes fra kundeclaims indtil de findes? Den nuværende kode understøtter kun CLI-generisk webhook.
3. Hvilken rapport/status-side skal være første bureau-feature, og hvilke data må en kunde-rapport indeholde?
4. Skal det eksisterende Stripe Payment Link verificeres manuelt for pris, valuta, fulfillment og license-key før næste release? Ingen betaling eller Stripe-write udføres af agenten.
5. Er der allerede Mahope/Stripe-aktiveringer fra pre-release Windows-builds, der kræver device_id-migration? Det afgør, om minimal generator-fix er nok.
6. Pro-navne, hvis et nyt brand senere ønskes: **DeskUptime Pro** (trygt og tydeligt), **Uptime Desk** (kortere), **Watchtower** (produktnavn, men bruges ofte) eller **Signal Monitor**. Ingen produkter, der allerede er i Stripe, omdøbes uden Mads' beslutning.
7. Skal den betalte desktopkilde, som stadig findes i offentlig Git-history før `39c434f`, fjernes via en separat historikskrivning af Mads? Agenten gennemfører aldrig force-push eller historik-rewrite.

## Deploy-/release-noter

- Dette offentlige repo er en npm-/GitHub-CLI og har ingen live-deploytarget. `STATUS.md` noterer 24/9, at `deskuptime.com` ikke er købt; derfor oprettes ingen `VERIFICÉR DEPLOY`-note for CLI-merges.
- De tidligere noter for researchplan `812f469` og desktop `f0d4fa7` var fejlagtige og er fjernet med denne planrevision.
- Merge til `main` deployer ikke; npm, GitHub Releases og Homebrew må kun publiceres af Mads via de eksisterende tag-workflows.

## Iterationslog

- **Iteration 1 (research):** Planen manglede ved start. Repoet, missionen, Stripe-/licenskontrakten, CLI/desktoparkitekturen, tests, releasefiler og dependency-status blev undersøgt. Ingen kode blev ændret ud over denne plan. Gate-baseline og prioriteret kø er registreret ovenfor.
- **Iteration 2 (P0-1, historisk):** Desktopbridge, lokal CSS/CSP, IPC-DTO, URL-validering, sikker DOM-rendering og redigeret licens-state blev implementeret og reviewet i commits `c63a52e` og `f0d4fa7`. Dengang var `npm test` 32/32, `cargo check --locked`, `cargo test --locked` 10/10 og `cargo tauri build --debug` på macOS grønne. Desktopkilden blev siden flyttet til det private repo; ubekræftet Windows-/interaktiv smoke overføres dertil.
- **Iteration 3 (P0-2):** Commit `6b81803` kræver Node 24 på tværs af CLI, workflows, Action og dokumentation, tilføjer lockfil/audit og afslutter den offentlige desktop-rekonciliering. Merge til `main` og push af begge grene skete 2026-09-25T06:54:55Z. Node 24.21.0, 26/26 tests, audit 0/0, YAML/shell/syntax/diff og to reviewpass er grønne; næste opgave er P0-3.
