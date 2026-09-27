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

Uden for denne iteration: de to terminal-lister (`status`, `watch --status`)
tier stadig, og et certifikat der flapper mellem to servere skriver
`lastCertRotatedAt` på hvert pass — samme tæthed som `content_changed` fik
(P1-47), umålt endnu.
