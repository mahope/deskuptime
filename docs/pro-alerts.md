# Pro-alerts — kanalmatrix, payload og købsflow

Status: **specificeret 2026-09-25**. Denne fil er source of truth for hvad gratis- og
Pro-udgaven gør. README, `--help`, npm-beskrivelse og den private desktop-app skal
matche denne matrix. `test/claims.test.js` fejler, hvis en kundeflade lover en kanal,
der ikke står her som implementeret.

## 1. Kanalmatrix

| Funktion | Gratis (CLI, MIT) | Pro ($19 engang, 3 maskiner) | Implementeret |
|---|---|---|---|
| `check` — engangskontrol af vilkårlig mange URL'er | ✅ | ✅ | Ja |
| `headers` — redirect-kæde + sikkerhedsheadere | ✅ | ✅ | Ja |
| SSL-udløbsvarsel, issuer, gyldighed | ✅ | ✅ | Ja |
| Content-ændringsdetektion (SHA-256) | ✅ | ✅ | Ja |
| GitHub Action: `json`-output, `down-count`, job-summary | ✅ | ✅ | Ja |
| `watch` — baggrundsovervågning | ✅ op til 3 URL'er, min. interval 60 s | ✅ ubegrænsede URL'er, min. interval 30 s | Ja |
| Terminal-udskrift ved UP/DOWN/SSL/content | ✅ | ✅ | Ja |
| Webhook-POST ved hændelse | ❌ | ✅ | Ja — se §2 |
| Lokal desktop-notification | ❌ | ✅ (macOS) | Ja — se §3 |
| Desktop-app: tray, baggrundsloop, aktivitetsoversigt | ❌ | ✅ | Privat repo `mahope/deskuptime-desktop` |
| Email-alerts | ❌ | ❌ | **Nej.** Der loves ingen email i nogen kundeflade. |
| Slack / Discord / Teams-kanal | ❌ | ❌ | **Nej.** Kræver en kanaladapter, der ikke findes. |
| Delelig status-side / kunderapport | ❌ | Planlagt | **Nej.** |
| Batch-job, flere lokationer, prioriteret support | ❌ | Planlagt | **Nej.** |

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
  "type": "down | up | ssl_warning | content_changed",
  "url": "https://yoursite.com",
  "message": "is DOWN — HTTP 503",
  "timestamp": "2026-09-25T14:26:12.000Z"
}
```

Ingen licensnøgle, device-id eller brugerdata sendes i payloaden. Se §5.

## 3. Lokal notification (Pro)

- macOS: `osascript display notification`. Fungerer i CLI-watch og i desktopappen.
- Windows/Linux i CLI'en: ingen lokal notification. **Lov ikke dette i CLI-help.**
- Desktopappen dækker Windows/Linux; det er hendes ansvar at holde claim'en ærlig.

## 4. Offline- og degrade-adfærd

| Situation | Adfærd |
|---|---|
| Licensserver nede eller 5xx | Pro fortsætter med cachet status i 7 dage, ingen låsning ude |
| Webhook-endpoint nede eller timeout | Advarsel på stderr, overvågningen fortsætter, ingen retry |
| Overvåget site nede | Gentages `is DOWN`-linje hvert pass; kun `down`-begivenheden går i webhook |
| `watch` kørt to gange samtidig | Anden proces afvises med exit 1, ingen state-skrivning |

## 5. Privacy

- Licensserveren (`https://mahope.tools/api/license/*`) modtager `license_key`,
  `device_id` (maskinnavn, maks. 128 tegn) og `product`. Ingen overvågede URL'er,
  ingen IP-adresser, ingen historik.
- Webhook-modtageren ser kun felterne i §2 — den URL, der netop ændrede tilstand.
- Gemt state (`~/.deskuptime/state.json`) indeholder de URL'er, brugeren selv har
  tilføjet, plus sidste status, SSL-dage og content-hash. Filen skrives `0600` på POSIX.

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
