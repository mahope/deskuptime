# Licenslifecycle — transient mod permanent

Status: **specificeret og implementeret 2026-09-25** i CLI'en (`src/license.js`,
`src/watch.js`, `src/cli.js`). Den private desktop-app (`mahope/deskuptime-desktop`)
skal spejle reglerne her; de afsnit, der kun gælder Rust, er markeret.

Formålet er én ting: en betalende kunde må **aldrig** låses ude af en fejl, og en
tilbagekaldt licens må **aldrig** fortsætte at give Pro. Derfor skelnes der mellem
*svar* (verdikt fra serveren) og *ingen svar* (ingen oplysning → intet ændret).

## 1. Hvilke HTTP-svar er et verdikt

| Svar | Betydning | Pro |
|---|---|---|
| `200 { ok: true, valid: true }` | Licensen gælder | Til |
| `200 { ok: true, valid: false, reason }` | Serveren har afsagt | **Fra med det samme** |
| `200` uden gyldig JSON, eller uden `ok: true` | Ingen oplysning (captive portal, proxy, Cloudflare-side) | Uændret |
| `400 / 403 / 404 / 409` | Afslag — permanent, så længe serveren svarer | **Fra med det samme** |
| `408 / 425 / 429 / 5xx` | Ingen oplysning (tjek, throttling, serverfejl) | Uændret |
| Netværksfejl eller timeout | Ingen oplysning | Uændret |

En tidligere fejlklassificering behandlede *alle* HTTP 200 som verdikt, så en
Cloudflare-HTML-side kunne låse en betalende kunde ude. Derfor er `malformed` et
eget udfald: det er transient, aldrig permanent.

**Hård timeout:** hvert forsøg har 10 s (`LICENSE_TIMEOUT_MS`). Et hængende
server-svar kan ikke hænge CLI'en eller overvågningsloopet.

**Én genprøvning, aldrig to.** Et `transient` eller `malformed` svar genprøves
én gang efter `LICENSE_RETRY_DELAY_MS` (400 ms), så en kort 429 eller et øjebliks
netværkshyl ikke sender en betalende kunde ned i `cached`/`unverified`.
Et **verdikt** — hvad det så er — spørges aldrig om igen. `LICENSE_ATTEMPTS` er
2, så der kan ikke opstå en retry-storm mod en ratelimiter; det er præcis det,
der gør en kort blivende fejl til en reel fejl. Et `Retry-After` på mere end 2 s
gør, at vi **ikke** genprøver: ratelimiteren beder os komme tilbage senere, og
det er cached-grace-vinduet, der dækker det.

## 2. De fem tilstande

`deskuptime status` viser præcis én af dem — aldrig bare "nøgle fundet".

| Tilstand | Betydning | Pro i CLI'en |
|---|---|---|
| `active` | Serveren bekræftede ved seneste check, og det er under 7 dage siden | Ja |
| `cached` | Ingen oplysning, men seneste bekræftelse er under 7 dage gammel | Ja |
| `unverified` | Ingen oplysning i over 7 dage — nøglen er **aldrig afslået** | Nej |
| `invalid` | Serveren har afslået nøglen | Nej |
| `free` | Ingen gyldig licens gemt | Nej |

**Et gemt Pro-ord er en påstand om et check.** `status` er read-only, så et ord
bærer videre, indtil næste check modsiger det. Derfor må `active` og `cached`
kun stå som Pro, **mens deres seneste bekræftelse er inden for 7-dages
vinduet** — samme regel for begge, fordi `status` ellers ville svare på
identisk evidens med modsatte ord:

```
{status: 'active', validatedAt: 41 d siden} → "Pro license: active, last verified 2026-08-16"
{status: 'cached', validatedAt: 41 d siden} → "Pro license: unverified — not verified for 41 days"
```

En record **uden** `validatedAt` har ingen bekræftelse og er derfor heller ikke
`active`; før dette skrev den `Pro license: active, nedan: not verified yet`.
`describeLicense()` i `src/license.js` er den ene læsning af dette, og `isPro()`
i `src/watch.js` spørger den — ellers ville gaten og `status` kunne være uenige
om den samme nøgle. `refreshLicense()` gendanner `active` ved det næste
verdikt, og nøglen slettes aldrig, så intet går tabt ved nedgraderingen.

**Én købsvej pr. overflade.** `free` er den eneste Pro-relevante tilstand med
kassen som svar, fordi det er den eneste, hvor kunden endnu ikke har betalt.
`deskuptime status` skal derfor pege på købslinket — det er den første
kommando en gratisbruger kører, og den må ikke ende i `activate <license-key>`
uden en vej til den nøgle. `test/matrix.test.js` låser præcis ét købslink i
`status`-outputtet, og at det er kontraktens.

**Hvorfor `unverified` er et eget ord.** Før dette ord fandtes, læste "ingen
bekræftelse i over 7 dage" som `invalid`, altså som *afslået*. Det er en løgn:
licensserveren svarer aldrig, og kunden kan komme til at tro, at nøglen er død og
købe en ny. Derfor skelnes der nu mellem "kan ikke verificeres" og "er afslået",
og `unverified` **viser aldrig et købslink** — kunden har allerede betalt. Vejen
tilbage er `deskuptime activate <license-key>`, som genverificerer nøglen og
genskaber Pro, hvis serveren svarer igen.

Nøglen slettes **aldrig** automatisk. Den bliver liggende, så en senere vellykket
check gendanner Pro, og så support kan se hvilken nøgle kunden har.

**Én gate-t tekst til alle Pro-overflader.** `proGateMessage(license, feature)`
i `src/license.js` er det eneste sted, der fortæller en kunde hvorfor en
Pro-funktion er lukket, og det bruger `describeLicense()`'s egen tilstand. Derfor
kan `report` og `--webhook` ikke modsige `deskuptime status`: en `unverified`
nøgle får overalt beskedet "genverificér nøglen" og **aldrig** et købslink, en
`invalid` nøgle får købslinket kun som "hvis du ikke har købt endnu", og en helt
manglende licens (`free`) er det eneste tilfælde, hvor kassen er svaret.

En state-fil skrevet før dette felt fandtes (intet `status`-felt) klassificeres
efter alder præcis som `refreshLicense` ville: inden for 7 dage `active`, derefter
`unverified`. Ældre installationer låses altså ikke ude.

## 3. Lagring

- `~/.deskuptime/state.json` skrives atomisk (temp fil → `rename`) og er `0600`
  i en `0700`-mappe på POSIX. En eksisterende fil med for vide rettigheder
  strammes ved næste skrivning.
- En licensrecord valideres ved indlæsning: nøglen skal være 32 hex-tegn,
  `device_id` skal være 1–128 tegn, `status` skal være en af de fem. Alt andet
  læses som "ingen licens" — en beskadiget state-fil giver hverken Pro eller et
  crash.
- `deactivate` sletter først lokal state, når serveren svarer
  `deactivated: true`. Ellers er pladsen stadig optaget, og det siger kommandoen
  til brugeren. *(Rust: samme regel.)*

## 4. Hemmeligheder i output

Alle fejlstrenge fra serveren og fra `fetch` passerer `redactSecrets()`, som
masker 32-hex-nøgler som `«key»` og device-id'er som `deskuptime-«device»`. En
server, der ekkoer nøglen tilbage, kan altså ikke lække den til terminalen.
Ingen licensnøgle, device-id eller webhook-hemmelighed skrives i logfiler.

## 5. Hvad Rust-siden skal spejle

1. Samme klassificering af 200/400/403/404/408/409/425/429/5xx og malformed 200.
2. Samme 10 s timeout pr. forsøg, samme én genprøvning med 400 ms pause, samme
   to-forsøgs-loft og samme regel om at et langt `Retry-After` ikke genprøves.
3. Samme fem tilstande i UI'en — især at `invalid` og `unverified` slår Pro fra med
   det samme, og at `unverified` ikke må få kunden til at tro nøglen er død.
   Samme regel for **`active` og `cached`**: et gemt Pro-ord må kun vises som Pro,
   mens sidste bekræftelse er under 7 dage gammel (reglen ovenfor), ellers viser
   UI'en en bekræftelse der aldrig kom.
4. Samme 7-dages grace uden at skrive gamle `license.instance`-id'er om
   (se P0-6: CLI'en bruger stadig det gemte id, indtil migreringen er dokumenteret).
5. `0600` state-fil i `0700`-mappe, atomisk skrivning, validering ved indlæsning.
6. Ingen rå nøgle i UI-state, events, logfiler eller IPC-payload.

Ændres reglerne her, skal `test/license.test.js` og denne fil ændres i samme
commit, og desktoprepoet følge med.
