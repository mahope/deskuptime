# Pro-alerts — kanalmatrix, payload og købsflow

Status: **specificeret 2026-09-25**. Kilden til sandheden er `src/features.js`: den
matrix, der gengives her og i README, er genereret fra den fil af `tools/matrix.mjs`, og
`test/matrix.test.js` fejler, hvis en committet flade afviger. Rækker, der ikke er
implementeret, står her som *ikke bygget* — de skjules i README og `--help`, så ingen
kundeflade kan love dem. Redigér claims i `src/features.js`, ikke i tabellerne.

## 1. Kanalmatrix

<!-- BEGIN GENERATED: matrix -->
| Funktion | Gratis (CLI, MIT) | Pro ($19 one-time, 3 maskiner) | Status |
| --- | --- | --- | --- |
| `check` og `headers` på vilkårlig mange URL'er | ✅ | ✅ | I begge |
| SSL-udløbsnedtælling, issuer og content-ændringsdetektion | ✅ | ✅ | I begge |
| GitHub Action med JSON-output, `down-count` og job-summary | ✅ | ✅ | I begge |
| JSON-output (`--json`) til scripts og CI | ✅ | ✅ | I begge |
| `watch` baggrundsovervågning | 3 URL'er, min. 60 s interval | Ubegrænsede URL'er, min. 30 s interval | I begge |
| Terminal-udskrift ved UP/DOWN/SSL/content-ændring | ✅ | ✅ | I begge |
| `deskuptime status` — licenstilstand og overvågede URL'er, read-only | ✅ | ✅ | I begge |
| Webhook-alerts ved hver hændelse (`--webhook`) | — | ✅ | Kun Pro |
| Lokal desktop-notification (macOS i CLI'en, alle platforme i desktopappen) | — | ✅ | Kun Pro |
| Desktop-app: tray, baggrundsloop, aktivitetsoversigt | — | ✅ | Kun Pro — privat desktopapp |
| Email-alerts | — | — | **Ikke bygget** |
| Slack / Discord / Teams-kanal | — | — | **Ikke bygget** |
| Delelig status-side / kunderapport (`report`, Markdown + JSON) | — | ✅ | Kun Pro |
| Batch-job, flere lokationer, prioriteret support | — | Planlagt | Planlagt — ikke en del af købet |
<!-- END GENERATED: matrix -->

Regel: en kanal må ikke nævnes i README, `--help`, npm eller købsflow, medmindre den
står som implementeret her. Planlagte kanaler nævnes kun som planlagt og uden købsclaim.

### Hvad Pro derfor faktisk koster $19 for i dag

1. Ubegrænsede overvågede URL'er og 30 s interval i CLI'en.
2. Webhook-alerts fra CLI-watch.
3. Den betalte desktop-app med tray og baggrundsovervågning.

Det er ærligt, købbart og mindre end "email + Slack + push". Det er bedre end at love
noget, der ikke findes.

## 2. Webhook (Pro) — payload, timeout, retry

Kommando: `deskuptime watch <url> --webhook <url>`.

- **Hvornår:** én POST pr. hændelse, dog aldrig for `baseline`-begivenheder.
- **Hvornår kommer der et `down`:** når et site *nu* er nede, og forrige måling enten
  var op eller ikke kunne læses. En `wasUp` i state-filen, der hverken er `true` eller
  `false` (håndskrevet, genskabt fra backup, halvskrevet), er **ikke** et site der var
  op: `runPass` læser den gennem `readEntry()` — samme ene ejerskab som `check`,
  `watch --status`, `status` og kundenapporten — så et ulæseligt forrige svar aldrig
  kan få en DOWN-begivenhed til at tie. Beskeden siger *er* nede, aldrig *hvornår* det
  gik ned, for det kan den ikke vide. Passet skriver `wasUp` tilbage fra målingen, så
  det er én alarm og ikke én pr. pass.
- **Metode:** `POST`, `Content-Type: application/json`.
- **Timeout:** 10 s. Et hangende endpoint kan ikke låse overvågningsloopet.
- **Retry:** ingen. Levering er best-effort; næste hændelse sender igen. Ingen outbox,
  ingen afspilning, ingen dødbrev.
- **Auth/signering:** brugeren kan selv lægge en token i webhook-URL'en (Slack, Discord m.fl.
  bruger den model). DeskUptime sender ingen egen signatur — modtageren skal derfor
  validere afsender selv (netværkskilde, IP, eller en uigennemsigtig URL).
- **TLS:** kun `https://` i praksis; `fetch` følger platformens tillidsstore.

Payload:

```json
{
  "product": "deskuptime",
  "type": "down | up | redirect | ssl_warning | ssl_expired | content_changed",
  "url": "https://yoursite.com",
  "message": "is DOWN — HTTP 503",
  "timestamp": "2026-09-25T14:26:12.000Z",
  "measuredAt": "2026-09-25T14:26:11.204Z",
  "previousChecked": "2026-09-25T14:25:41.000Z",
  "transition": "observed",
  "finalUrl": "https://yoursite.com/",
  "offHostRedirect": false
}
```

Listen er den **ene** type-værdi, loopet sender, og de er låst til
`WEBHOOK_EVENT_TYPES` i `src/watch.js` af `test/webhook.test.js`: en type der
tilføjes i koden uden at stå her, eller en der står her uden at blive sendt, giver
en rød gate. `baseline` er den eneste type der *findes* i koden og ikke sendes —
den er en første iagttagelse, ikke en hændelse.

**`redirect` — oplysningen, ikke en fejl.** `type: "redirect"` betyder, at svaret
kom fra en **anden vært** end den adresserede: et udløbet kunde-domæne der er blevet
parkeret, et domæne der er hijacket og peger på en phishing-side, eller en
tastefejl der lander på registrarens "mente du"-side. HTTP-koden er normalt `200`,
så **uden denne type nåede alle disse som et grønt `up`**. En kanal skal derfor
ikke behandle den som nedbrud — den skal vise den. `finalUrl` er, hvor svaret
faktisk kom fra, og `offHostRedirect` er sand præcis når det ikke er den
adresserede vært (`:80`/`:443`-varianter af samme vært er ikke cross-host). Begge
felter findes i hver payload, også når de er `false`/`null`, så modtageren aldrig
skal gætte. Låsen følger den *svarende vært* og ikke URL'en, så et domæne der
bliver liggende parkeret sender **én** besked og ikke én pr. pass.

**Tider.** `timestamp` er, som altid, hvornår denne POST blev bygget — ikke hvornår
sitet blev målt. Det er den eneste tid feltet havde indtil 26/9, og en kanal der
viser den som "sitet brød kl. 14:26" læser en leveringstid som en måling.
`measuredAt` er passens egen tid: samme værdi som skrives til state-filen og vises
af `deskuptime status`. Forskellen kan ikke læses fra ét tal, fordi
`printPass` og webhook-modtagerens egen svartid ligger imellem. `previousChecked`
er tidspunktet for den måling, en overgang sammenlignes med.

**`transition` — tre ord, og hvorfor de findes.** `observed` betyder, at
DeskUptime faktisk så skiftet: det forudgående pass er til stede og nyere end
staleness-vinduet. `unobserved` betyder, at hændelsen er en sammenligning med en
måling, der mangler, er ulæselig eller er ældre end vinduet — typisk fordi
overvågningsloopet har været dødt. `none` er alt, der ikke er en tilstandsovergang
(`ssl_warning`, `ssl_expired`, `content_changed`, `redirect`, `baseline`).

Målt 26/9, før dette blev skrevet: en state-fil med et pass fra 41 dage siden —
loopet var dødt, og sitet var aldrig nede — gav

```json
{ "type": "up", "message": "is UP (200) — 12ms" }
```

`type: "up"` er en maskinlæsbar påstand om en tilstandsendring, og overgangen var
målt mod en læsning fra seks uger siden. `deskuptime status` sagde på samme fil
`stale — last check 41 d ago`, og kundenapporten sagde det samme, så de to
menneske-flader havde alderen, og payloaden — den eneste en maskine læser — havde
intet. Nu følger beskeden med `⚠️ not an observed transition — the last check was
41 d ago`, og `transition` er `unobserved`.

**Beskeden siger aldrig, hvornår sitet brød.** Den note, der kan stå i `message`,
handler om det *forudgående tjek* og ikke om nedbruddet. `docs/pro-alerts.md` §2's
garanti om `down` består derfor uændret.

Ingen licensnøgle, device-id eller brugerdata sendes i payloaden. Se §5.

## 3. Lokal notification (Pro)

- macOS: `osascript display notification`. Fungerer i CLI-watch og i desktopappen.
- Windows/Linux i CLI'en: ingen lokal notification. **Lov ikke dette i CLI-help.**
- Desktopappen dækker Windows/Linux; det er hendes ansvar at holde claim'en ærlig.

## 4. Offline- og degrade-adfærd

| Situation | Adfærd |
|---|---|
| Licensserver nede, timeout, 429/408/5xx eller ulæseligt svar | Pro fortsætter med cachet status i 7 dage, ingen låsning ude |
| Licensnøgle afslået (400/403/404/409) | Pro slår fra med det samme; nøglen bevares til diagnose |
| Webhook-endpoint nede eller timeout | Advarsel på stderr, overvågningen fortsætter, ingen retry |
| Overvåget site nede | Gentages `is DOWN`-linje hvert pass; kun `down`-begivenheden går i webhook |
| `watch` kørt to gange samtidig | Anden proces afvises med exit 1, ingen state-skrivning |

Den fulde klassificering, timeout og tilstandsmaskineri står i
`docs/license-lifecycle.md`. `deskuptime status` viser tilstanden som `active`,
`cached/offline`, `invalid` eller `free`.

## 5. Privacy

<!-- BEGIN GENERATED: license data -->
Licensserveren modtager pr. kald præcis tre felter: `license_key`, `device_id`, `product`. Aldrig: overvågede URL'er, sideindhold, kontrolresultater, IP-adresser eller historik.

| Felt | Hvad det er |
| --- | --- |
| `license_key` | Din 32-tegns licensnøgle |
| `device_id` | Et maskine-id udledt af computerens navn (`deskuptime-` + navn, maks. 128 tegn) |
| `product` | Produktnøglen `deskuptime-pro` |
<!-- END GENERATED: license data -->

- Licensserveren kaldes kun fra `activate` og den daglige re-check; intet andet i
  CLI'en taler med `mahope.tools`.
- `device_id` på native Windows læses `COMPUTERNAME`, fordi `os.hostname()` der
  returnerer det 15-tegns NetBIOS-navn, som CLI'en ellers ville afvige fra
  desktopappen på. Scheme'et er låst i `test/fixtures/device-id.golden.json`,
  som Rust-siden skal køre mod samme fil.
- Webhook-modtageren ser kun felterne i §2 — den URL, der netop ændrede tilstand.
- Gemt state (`~/.deskuptime/state.json`) indeholder de URL'er, brugeren selv har
  tilføjet, plus sidste status, SSL-dage og content-hash. Licensnøglen ligger i
  samme fil og skrives `0600` i en `0700`-mappe på POSIX.

## 6. Pris og entitlement

- Ét produkt: **DeskUptime Pro**, `deskuptime-pro`, $19 engang, 3 maskiner.
- Betalingslink: `https://buy.stripe.com/7sY9AS9eX3Iu418fJ5bMQ01`.
- Licensserveren: `https://mahope.tools/api/license/{activate,validate,deactivate}`.
- Donation: `https://donate.stripe.com/7sYeVcbn50wieFM8gDbMQ0c` — kun i README's
  afslutning og `.github/FUNDING.yml`, aldrig i et købsflow.
- Der oprettes ingen nye Stripe-produkter, priser eller links af agenten.

## 7. Åbne beslutninger (kræver Mads)

1. Skal email og Slack/Discord/Teams implementeres som Pro-kanaler, eller forbliver de
   uden for matrixen, indtil de er bygget? Svar afgør om næste iteration går i gang med
   en kanaladapter.
2. Hvilken rapport/status-side skal være første bureau-feature, og hvilke felter må en
   kunderapport indeholde?
3. Skal desktoptray og lokale notifications være gratis i stedet for Pro?

Svarene indarbejdes her, og `test/claims.test.js` låser matrixen til det, der faktisk
er bygget.
