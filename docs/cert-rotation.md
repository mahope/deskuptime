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

- **Kundenrapporten** (`report`) får ingen kolonne. Den følger i en senere
  iteration; køen har den som målt fund.
- **Domæne-udløb** (missionens fokus) er ikke dette. Det er et andet sæt data.
- **Fingerprints i rapporten** — et 64-tegns hash i et kundedokument er støj.
  Rapporten skal sige *at* det roterede, ikke hvad det hashed til.
