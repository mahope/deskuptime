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

## Den betalte kanal, anden gang (P1-66, 2026-09-27)

P1-65 efterlod den **sidste** flade åben, og den er den der sælges. Målt først, nul
kode ændret: rigtig `runPass`, rigtig state-fil, rigtig HTTP-modtager og det rigtige
`sendWebhook`. To pass over et site der svarer 200 i begge, den eneste forskel
hvilket certifikat — og hvilken udsteder — der svarede anden gang:

```
cert_rotated  SSL certificate replaced — certificate rotated since the certificate seen today
state.json    sslIssuer=Rogue Cert BV  certIssuerBefore=Ganske Cloud A/S
```

Kundenapporten navngav begge autoriteter (P1-64), de to terminal-lister gjorde det
samme (P1-65), og kanalen — den `POST` til kundens Slack, Discord eller Teams og
desktop-notificationen bag den — sagde «certifikatet blev udskiftet» og stoppede.
Nedtællingen taler imod opmærksomhed: et nyudstedt certifikat har typisk *flere*
dage tilbage end det det erstattede, så et domæne i nye hænder ankommer i kanalen
som det sundeste af de to.

Ejeren var allerede skrevet. `readCertRotationAlert()` får nu udstederens **egen**
sætning fra `readCertIssuerState()` — samme ejer kundenapporten og begge lister
spørger — og placerer den som sit eget led efter rotationens:

```
SSL certificate replaced — certificate rotated since the certificate seen today · 🏢 certificate answers from a different issuer today (Ganske Cloud A/S → Rogue Cert BV)
```

**Ingen ny hændelsestype, intet nyt payload-felt, ingen ny state.** Den mindste
rettelse der findes: en kanal der læser `message` ser det samme, en adapter der
læser `type` og felterne ser præcis som før, og outboxens 500-tegns grænse er
målt til ikke at bide (sætningen er ~170 tegn).

**To kendsgerninger, to sætninger, og derfor er de to led.** En fornyelse fra samme
udsteder roterer certifikatet og siger intet om udstederen; det er den normale gang og
den må stadig læse `SSL certificate replaced — …` **byte for byte uændret**, ellers
ville hver 90-dages fornyelse i enhver kanal blive en alarm om en udsteder der ikke
skiftede. Rækkefølgen i sætningen er kendsgerning før leveringsnote: det holdte
rotations-tal (P1-63) står altid sidst.

**Rækkefølgen i `runPass` er bærende, ikke pæn.** Sammenligningen af udsteder står
før rotationsgrinen og som dens søskende — ikke inde i den — fordi alarmen skal kunne
spørge ejeren om netop den ændring passet målte, og det kan den kun, hvis
`sslIssuer` er skrevet *før* spørgsmålet stilles. Målt på rettelsens første kørsel:
`(Ganske Cloud A/S → Ganske Cloud A/S)` — kanalen sagde til en kunde, at
udstederen havde skiftet til sig selv. Derfor står skrivningen af `sslIssuer` før
læsningen, og derfor er der en test på «den nye er den nuværende».

**Ejeren blev strammet undervejs, og det gælder alle fire flader.** `readCertIssuerState`
regnede et stempel som et skift, når bare `certIssuerBefore` og `certIssuerChangedAt`
var til stede — også når de to navne var *det samme*. Passet kan ikke skrive sådan en
fil, men en håndskrevet, flettet eller gendannet kan, og så sagde rapporten og begge
lister `answers from a different issuer 2 d ago (Ganske Cloud A/S → Ganske Cloud A/S)`.
En autoritet der skifter til sig selv har ikke skiftet, så `changed` kræver nu at de to
navne er forskellige.

**Dæmpningen rører den ikke, og det er en ærlig pris.** En rotation der holdes tilbage
holder kun *rotationen* tilbage; den næste sendte alarm bærer stadig begge navne, for
ellers ville et hijack der lander i den stille time blive meldt én rotation for sent
og uden autoriteten. Og en autoritet der skifter uden at certifikatet roterer sig
hijacker intet alene — et CDN midt i en udrulding kan gøre det uskyldigt — så den
gemmer kendsgerningen til rapporten og de to lister og rejser ingen hændelse. At opfinde
en hændelsestype for den ville double antallet af POSTs på præcis den slags site.

## Hvor mange gange (P1-68, 2026-09-27)

**Målingen.** 24 timers rigtige passer over to sites, begge `UP (200)` med et gyldigt
certifikat der dækker navnet. De adskiller sig kun i hvilket certifikat der svarer:
`quiet.dk` fornyer en gang — den normale 90-dages gang — mens `flap.dk` svarer med et
nyt certifikat på hvert pass, som et CDN midt i en udrulding, en canary-deploy eller et
domæne der roterer certifikater for at blive foran en bloklist. Kundenapporten skrevet
90 dage efter at overvågningen stoppede:

```
**2 sites have their certificate replaced since monitoring — …:**
https://quiet.dk/ (🔑 certificate replaced 90 d ago)
https://flap.dk/   (🔑 certificate replaced 90 d ago)
```

To linjer, tegn for tegn ens, om forskellen på en fornyelse fire gange om året og på
den facon et hijack har. Rapporten er præcis det dokument, hvor forskellen er værd
penge, og det var den eneste flade der ikke kunne se den.

**Hvorfor ingen af de to eksisterende tal kunne.** `lastCertRotatedAt` er et *tidspunkt*,
ikke et antal, og P1-63's `certRotationsHeld` bruges op i den næste alarm der sendes —
så ingen af dem kan sige hvor mange der har været. Tællingen skrives derfor på den
samme gren og i samme pass som stemplet der allerede står, så en rotation aldrig kan
tælles i det ene og ikke i det andet. `readCertRotationState` — ejeren P1-61 lavede, og
P1-62/64/65/66 har udvidet — bærer tallet videre, og de to gratis-lister spørger den
samme ejer, så de siger det uden en eneste linje af egen.

**Den normale forbliver uændret, tegn for tegn.** Én fornyelse siger
`🔑 certificate replaced 90 d ago`, præcis som den altid har sagt, fordi en kunde der
læser «1 fornyelse» ikke lærer noget de ikke havde, og et tal i et videresendt
dokument skal være værd at læse. Først den anden ændrer sætningen:

```
  ✅ https://flap.dk/ (200) — SSL 89d 🔑 certificate replaced 1 d ago · 47 replacements since the site was added
  ✅ https://quiet.dk/ (200) — SSL 89d 🔑 certificate replaced 1 d ago
```

Tallet løber med i alle fire former af sætningen — i dag, `N d ago`, ved et
ulæseligt stempel og ved et ur der går foran — ellers ville præcis de maskiner hvor
tallet betyder mest (et forkert ur, en kludret state-fil) være dem der ikke fik det.

**En håndskrevet tæller er ingen tæller.** `certRotationCount` i `status.js` er den ene
ejer af «er dette et antal», af samme grund som `readPassTime` findes: `"many"`, `-1`,
`1.5` og `1e21` er alle fravær af et antal, ikke et antal af noget. Nul er et rigtigt
svar — et site der er tilføjet og aldrig har roteret — og det er også svaret i hver
state-fil skrevet før tælleren fandtes, så ingen opgradering opfinder en rotation.
`report --json` får ét additivt felt, `certRotationCount`; ingen celle, ingen
exit-kode og intet tal i resumelinjen flytter sig.
