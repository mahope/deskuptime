# Certifikatrotation — spec

Skrevet 2026-09-27, **før** den første linje kode, fordi planen gjorde
certifikatrotation til det eneste fund den ikke ville bygge uden en spec
(P1-52, P1-53, P1-54, P1-55: *"kræver spec først"*).

## Spørgsmålet

Et bureau overvåger kunders sites. Når et kunde-domæne skifter hænde — det
udløber og bliver købt, det hijackes, en registrar sælger det videre — sker
det ofte **uden at sitet går ned**. Det nye svar `200` med et gyldigt
certifikat fra en anden autoritet. Bureauet ser et sundt site.

De tre spørgsmål, værktøjet først kunne svare på ét af, lå alle i målingen:

| Spørgsmål | Ejer | Svar |
|---|---|---|
|Hvem udstedte det? | `readSslIssuer` | P1-53 ✅ |
| Dækker det den vært, vi tjekker? | `readCertCoverage` | P1-54 ✅ |
| **Er det det samme certifikat som sidst?** | `readCertRotation` | denne spec |

Ingen af de to første kan se det tredje. En udsteder kan være den samme
(`Let's Encrypt`) på tværs af to helt forskellige domæner, og dækning matcher
per definition, fordi det nye certifikat dækker sitets eget navn.

## Hvad der måles

`checkSSL` har læst `serialNumber` siden P0-3. `fingerprint` er SHA-1 og
kollisionsbrudt, så det bruges **ikke**: der læses `fingerprint256`, og begge
normaliseres til små hex-tegn uden kolonner, fordi en gemt værdi kan være skrevet
af en person eller en ældre build. `89:9C:…` og `899c…` er samme certifikat, og
en sammenligning der fejlede på tegnsætning ville melde en rotation der aldrig
skete.

## Hvad der sendes

Én hændelsestype, `cert_rotated`, i den betalte webhook-kanal — den kanal der
sælges. Første læsning er en baseline og ikke en hændelse, præcis som en
første læsning af siden er det. Ingen tæthed behøves: en rotation er sjælden,
og et certifikat der flapper mellem to servere er en fejlkonfiguration der
skal ses.

## Alder

`readCertRotation` bærer alderen på den gemte læsning, spurgt af `passAge` — samme
regel som P1-36 (certifikat-nedtællingen), P1-57 (sidestørrelsen på listerne) og
P1-59 (indholds-sammenligningen). *"Samme certifikat"* er sandt om to læsninger
og siger intet om strækningen imellem dem: et domæne der blev hijacket og
afleveret tilbage mellem to pass har samme certifikat i begge ender.

## Udenfor scope

- **Domæne-udløb** (missionens fokus) er ikke dette. Det er et andet sæt data.
- **Fingerprints i rapporten** — et 64-tegns hash i et kundedokument er støj.
  Rapporten skal sige *at* det roterede, ikke hvad det hashed til.

## Kundenrapporten (P1-61, 2026-09-27)

Målt først, nul kode ændret: rigtig CLI, to state-filer skrevet af rigtige
passer over et site der svarer 200 i begge, den eneste forskel det certifikat
der svarede den anden dag.

```
uændret certifikat         ->  | kunde.dk | UP (200) | 100% | … | 88 d | …
certifikatet byttet i dag  ->  | kunde.dk | UP (200) | 100% | … | 89 d | …
```

Ingen linje, ingen tælling, intet JSON-felt. Og nedtællingen er ikke engang et
signal: et nyudstedt certifikat har typisk *flere* dage tilbage end det det
erstattede, så et hijack læses som det sundeste af de to.

Årsagen lå i skrivevejen, ikke læsevejen. `runPass` overskriver
`lastCertFingerprint` med den nye identitet i det pass der så rotationen, så
state-filen dagen efter kunne ikke kende de to tilfælde fra hinanden. Præcis
som siden: `lastContentChangedAt` (P1-56) og nu `lastCertRotatedAt`, med
`readCertRotationState` som den ene ejer.

Rettelsen er additiv på alle flader: `summary.certRotated`, fire additive
felter pr. site (`certRotated`, `certRotatedAt`, `certRotatedAgeDays`,
`certRotatedNote`), tællingen i resumelinjen og én navngiven linje under
tabellen med alderen. **Ingen status, exit-kode, uptime-tal eller SSL-celle
ændrer sig** — et udstedt certifikat er en kendsgerning, ikke en dom, og de
fleste værter udsteder nyt hver 90. dag. Ordet er derfor *replaced* og ikke
*nyt*, *mistet* eller *mistænkeligt*; læseren ved, om sitets certifikat burde
være skiftet.

Uden for denne iteration: et certifikat der flapper mellem to servere skriver
`lastCertRotatedAt` på hvert pass — samme tæthed som `content_changed` fik
(P1-47), umålt endnu.

## De to terminal-lister (P1-62, 2026-09-27)

Samme måling, de sidste to flader der var tilbage. Rigtig CLI, rigtige passer, to
state-filer der adskiller sig kun i hvilket certifikat der svarede den anden
dag:

```
uændret certifikat         ->  ✅ https://kunde.dk/ (200) — SSL 89d
certifikatet byttet i dag  ->  ✅ https://kunde.dk/ (200) — SSL 89d
```

To rækker, tegn for tegn ens — og en rapport over den *samme* fil, der sagde
`**1 site has its certificate replaced since monitoring …**`. Kendsgerningen
fandt altså kun dér, hvor den sælges. Og nedtællingen kan ikke stå i for: et
nyudstedt certifikat har typisk *flere* dage tilbage end det det erstattede, så
et hijack læses som det sundeste af de to.

Ejeren var allerede skrevet (P1-61): `readCertRotationState`. `readEntry` spørger
den nu, lige ved siden af sidelæsningen (P1-57), og hver liste placerer sætningen.
Efter:

```
  ✅ https://kunde.dk/ (200) — SSL 89d 🔑 certificate replaced 2 d ago
```

Alderen rejser med kendsgerningen, fordi en liste tit læses dage efter passet, så
"byttet" ikke må læses som "i morges". Et ulæseligt stempel siger det og opfinder
ingen alder, og et stempel foran dette ur kaldes et ur, ikke en kendsgerning om
certifikatet — samme tre tilstande som overalt ellers.

**Ingen status, exit-kode, uptime-tal eller SSL-celle flytter sig.** Et udstedt
certifikat er stadig gyldigt for det rette navn, og de fleste værter udsteder nyt
hver 90. dag, så ordet er *replaced* og ikke *nyt*, *mistet* eller
*mistænkeligt*. Rækker uden stempel tier stadig: stemplet skrives kun når et pass
så et andet certifikat, så dets fravær er det normale tilfælde, og en note der
stod på hver række ville træne læseren i at rulle forbi den der betyder noget.

**Listen er ikke en skriver.** `status` og `watch --status` læser filen og gør
ikke andet: ingen hændelse, ingen ny tælling, ingen gemt stempel. Hændelsen
`cert_rotated` tilhører passet (P1-60), fordi den er en betingelse om *at noget
skete*, ikke en læsning af en gemt fil.

## Tætheden: et certifikat der flapper mellem to servere (P1-63)

Et navn der svarer med ét certifikat på den ene server og et andet på den næste —
to regioner bag én load balancer, et CDN midt i en udrulning, en canary-deploy — er
en rotation på **hvert** pass, fordi rotationen sammenlignes med *forrige* pass.
Målt 2026-09-27 med den rigtige loop, seks pass 30 s fra hinanden:

```
pass 1  • baseline recorded: UP (200)
pass 2  🔑 SSL certificate replaced — certificate rotated since …
pass 3  🔑 SSL certificate replaced — certificate rotated since …
pass 4  🔑 SSL certificate replaced — certificate rotated since …
pass 5  🔑 SSL certificate replaced — certificate rotated since …
pass 6  🔑 SSL certificate replaced — certificate rotated since …
```

Fem af seks pass, og hver eneste er en POST til den betalte kanal og en
desktop-notification: 2 880 pr. døgn pr. site. Skaden er ikke larmet i sig selv,
men det kanalen og notifikationscentret bliver **dæmpet** af — og dæmpningen er
netop det der skjuler den rigtige `is DOWN`.

Efter: **én** alarm i samme seks pass, og de to state-filer er stadig
byte for byte forskellige på den måde der betyder noget. Samme regel som
content-ændringer (P1-47) og samme time, `CERT_ALERT_MIN_GAP_MS`; ejeren er
`readCertRotationAlert()` i `src/status.js`, og den bygger sin sætning af
rotationens *egen* sætning, så den ikke kan melde én rotation med en andens ord.

**Kendsgerningen skrives stadig på hvert pass**, også på de pass hvor alarmen
holdes tilbage — `lastCertRotatedAt` er det eneste spor der overlever passet, fordi
passet overskriver `lastCertFingerprint` med den nye identitet (P1-61). Det er
**forskellen** på en tynget `down` (P1-49): der kan en kunde have købt sig det øjeblik
et site går ned, så dækningen må ikke bruges på et rigtigt nedbrud. Et certifikat
er en *kendsgerning om fortiden* — det ændrer sig ikke mens man venter på at få at
vide det — så prisen ved at holde *beskeden* tilbage er nul, og kundenapporten og de
to lister siger stadig `🔑 certificate replaced i dag`. Det der blev holdt tilbage
**tælles, ikke kasseres**: den næste sendte alarm siger hvor mange rotationer den
står for (`3 earlier rotations since the last alert, not sent`).

Den første rotation efter en stille time sendes som før, så et domæne der er kommet
i nye hænder meldes, og en vært der udsteder nyt certifikat hver 90. dag får sin
alarm som før. Et nedbrud er aldrig tynget: `cert_rotated` og `down` er to hændelser
i to kodelinjer, og kun den første har en dækning.

## En anden udsteder (P1-64, 2026-09-27)

Det tredje spørgsmål i tabellen ovenfor — *hvem udstedte det?* — var kun besvaret for
`check`. `readSslIssuer` måler udstederen siden P1-53, men ingen skrev den ned, så
kundenapporten kunne hverken svare på spørgsmålet eller se det ene signal, der
skelner en fornyelse fra et navn, der er kommet i nye hænder.

Målt først, nul kode ændret: rigtig `runPass`, rigtig state-fil, rigtig CLI. To pass
over et site der svarer 200 i begge, hvor den eneste forskel er hvilket certifikat
— og hvilken udsteder — der svarede anden gang:

```
| https://kunde.dk/ | UP (200) | 100% | … | 89 d | … |
**1 site has its certificate replaced …** (🔑 certificate replaced today)
```

Rotationen var der. Udstederen var ikke nogen steder — heller ikke i state-filen, så
et senere pass kunne ikke finde den. Og nedtællingen taler imod opmærksomhed: et
nyudstedt certifikat har typisk *flere* dage tilbage end det det erstattede.

Ejeren er `readCertIssuerState()` i `src/status.js`, samme form som
`readCertRotationState`: alderen gennem `passAge`, et ur-skævt stempel navner
skævningen, en halv påstand er ingen påstand, og et certifikat uden oplyst udsteder
sletter ikke den sidste kendte. `runPass` gemmer `sslIssuer` på hvert pass og
stempler `certIssuerBefore` + `certIssuerChangedAt`, når den nye udsteder afviger fra
den sidste kendte. Sammenligningen står **uden for** rotationsgrenen: en anden
udsteder giver næsten altid også et andet certifikat, men en kendsgerning der kun
skrives inde i en branche forsvinder stille, når en læsning tager den anden vej.

Rapporten får én navngiven linje under tabellen med **begge** navne, tællingen i
resumelinjen og otte additive felter pr. site. **Ingen status, exit-kode, uptime-tal
eller SSL-celle flytter sig** — udstederen kommer ikke i cellen, den er en linje
under tabellen, ligesom rotationen.

Ordet er *different issuer* og aldrig *rogue*: et site der flytter vært, eller en CA
der overtages, giver det samme billede helt uskyldigt. En fornyelse fra den **samme**
udsteder er stadig `🔑 certificate replaced` og ikke et skift — 90 dages fornyelser er
den normale gang og må ikke se ud som et overtag.

## De to terminal-lister, anden gang (P1-65, 2026-09-27)

P1-64 efterlod én flade åben og navngav den selv: de to **gratis** lister. Ikke fordi
målingen manglede — state-filen havde `sslIssuer`, `certIssuerBefore` og
`certIssuerChangedAt` siden den forrige iteration — men fordi ingen læste dem.

Målt først, nul kode ændret: rigtig `runPass`, rigtig state-fil, rigtig CLI, temp-HOME.
To pass over et site der svarer 200 i begge, den eneste forskel hvilken udsteder der
svarede anden gang:

```
status         ->  ✅ https://kunde.dk/ (200) — SSL 89d · 89 bytes 🔑 certificate replaced today
watch --status ->  ✅ up  https://kunde.dk/ (200, SSL 89d) @ … 🔑 certificate replaced today
```

Ingen af dem sagde `Ganske Cloud A/S`, `Rogue Cert BV` eller ordet *issuer*. Det gjorde
rapporten over den **samme** fil. Ejeren var allerede skrevet; `readEntry` spørger den
nu, lige ved siden af rotationen og sidelæsningen, og hver liste placerer sætningen.
Efter:

```
  ✅ https://kunde.dk/ (200) — SSL 89d · 89 bytes 🔑 certificate replaced today 🏢 certificate answers from a different issuer today (Ganske Cloud A/S → Rogue Cert BV)
```

**Begge sætninger står der, og ingen erstatter den anden.** De er to kendsgerninger, ikke
to formuleringer af én: en fornyelse fra samme udsteder roterer certifikatet og siger
intet om udstederen, og en udsteder der skifter hænde er netop det tilfælde hvor alle
tallene på rækken stadig ser sunde ud. Rapporten har to linjer under tabellen af samme
grund, og en liste der læsedes som rapporten skal ikke tie om den ene.

**Ingen status, exit-kode, uptime-tal eller SSL-celle flytter sig.** Låst i en test: rækken
beholder sit `✅` og sit `SSL 89d`, begge kommandoer exit 0, og `readEntry` er deep-equal
på alle øvrige felter. Rækker uden skift tier stadig, og en fornyelse fra samme udsteder
siger *kun* `🔑 certificate replaced` — det er den hyppigste normale gang, og en note der
stod på hver række ville træne læseren i at rulle forbi den der betyder noget.

De to navne i sætningen er **certifikatets egen tekst**: en hijack vælger dem, og en
fejlkonfigureret TLS-terminator gør det også. Derfor går sætningen gennem `safeText` som
URL'en og sidetitlen, målt i en test med et escape-sekvens-navn — fladen skal ikke kunne
lade et certifikat male over vores egen terminal.

**Listen er stadig ikke en skriver.** Ingen stempel, ingen hændelse, ingen gemt tælling:
filen er byte for byte den samme efter begge kommandoer. Og der kommer ingen ny
hændelsestype — den betalte kanal hører til passet, som før.
