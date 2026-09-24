# KonfAction Trøndelag Fotballcup

Nettside for cupen i Stjørdal 10. oktober, med norsk livetabell, kamper, sluttspilloppsett, utmerkelser og adminsikret resultatregistrering.

Den ferdige turneringsplanen har 30 seriekamper: seks kamper per lag, uten at et lag spiller tre runder på rad. Fem sluttspillkamper følger etter seriespillet, inkludert finale på bane 1. Totalt er det 35 kamper.

## Nytt i kampdag-versjonen (24.09)

- **Klokka styrer ikke lenger kampene.** En kamp står som «Ikke startet» til dommeren trykker «Start kampen», og som «Pågår» til noen trykker «Avslutt kampen». Før ble kamper automatisk «Avsluttet» på planlagt sluttid, også om de fortsatt ble spilt. Da kunne sluttspilloppsettet låses på et halvferdig resultat hvis runde 9 dro ut.
- **Mål kan bare føres etter start.** Målknappene i dommermodus er låst til kampen er startet, og serveren avviser mål før start og etter avslutning.
- **Tydelig avslutning.** Alle kamper i en runde starter samtidig, så klokka i dommermodus teller oppover fra når dommeren trykket «Start kampen». Når 15 minutter er spilt, blinker klokka, et oransje banner ber dommeren blåse av, og «Avslutt kampen» pulserer (Android vibrerer i tillegg; iPhone støtter ikke vibrering fra nettsider), og det kommer en påminnelse hvis dommeren prøver å lukke uten å avslutte. Alle admin-er ser en oransje boks øverst med kamper som ikke er avsluttet i tide.
- **Dommeren kan rette egne feil.** «Angre start» (mens det står 0–0), «Åpne kampen igjen» etter avslutning, og dobbelttrykk på samme lag innen 0,7 sekunder teller som ett mål. Et mål som ikke blir lagret (dårlig dekning), trekkes tilbake på skjermen med tydelig beskjed.
- **Alle admin-er kan rette resultater i etterkant** med «Rett resultat» på kampkortet. Endringen lagres først når man trykker «Lagre rettelse». Den gamle autolagringen kunne fryse admin-siden etter én mislykket lagring; den er fjernet.
- **Mindre trafikk.** Publikum henter nytt hvert 60. sekund (admin 15 s, dommermodus 20 s), bare mens siden er synlig. Klokkene teller ned lokalt. Siste resultater lagres på telefonen og vises med en gang ved neste besøk, også uten dekning. «Oppdatert kl. …» kan trykkes for å hente nytt med en gang.
- **Enklere oversikt:** «Neste avspark / På banen» er fjernet fra tabellsiden (Kamper-fanen dekker det), og kampkortene viser bare banen. Tiden står i rundestripa. Lagene merkes «Hjemme» og «Borte».
- **Nytt utseende:** mørkt toppfelt med pikselkunst av banen, «Pågår nå»-kort med stort resultat, mørk tabell der radene glir til ny plass, rundestripe og kampkort med bane-fane. Pikselmotivene ligger i `dist/px/` (til sammen ca. 30 KB).
- **Favorittikonet** er krympet fra 942 KB til 12 KB (det inneholdt skjult Adobe-metadata).
- **Norske feilmeldinger** også når nettet eller serveren svikter, og alle kall har tidsgrense (10 s).
- **Backup i regneark:** admin-er får lenken «Last ned alle resultater (regneark)» nederst på siden. Filen har alle kamper (runde, bane, tid, lag, resultat, status, vinner, hvem som registrerte) og tabellen, og åpnes rett i Excel eller Google Sheets. Den bare leser, så den kan ikke påvirke registreringen. Last ned etter hver runde.
- **Mobil og PC:** testet i Safari-motoren (iPhone SE, iPhone 13, iPad) og Chrome (Pixel 7, PC). Toppmenyen får plass ned til 320 px, og liggende dommermodus har målflatene til venstre og knappene til høyre.
- **Android-varsler:** «Følg lag» med systemvarsel kunne stoppe oppdateringen på Android. Rettet.
- **Bibelgåten:** «1. Korinterne» er rettet til «1. Korinterbrev». For 1. Samuelsbok 16 godtas nå også Samuel, Isai og Saul (Goliat kommer først i kapittel 17, men godtas fortsatt).

## Nytt i versjonen fra 23.09

- **Dommermodus:** «Dommermodus» på hvert admin-kort åpner kampen i fullskjerm med begge lagenes logoer. Trykk på et lag = ett mål. «−1» og «Angre» retter feiltrykk. Nedtelling til kampslutt, skjermen holdes våken, og «Avslutt kamp» låser resultatet. Målene lagres atomisk (`/api/goal`), så flere dommere/admins kan registrere samtidig uten konflikt.
- **Hjemme og borte:** «Hjemme · vester» og «Borte» står i dommermodus. På kampkortene er det tatt bort; regelen om vester står under «Om turneringen».
- **Sluttspill som andre kamper:** admin kan «Låse oppsettet nå» (og låse opp igjen hvis ingen sluttspillresultater finnes), og deretter registrere resultater med en gang. Uavgjort i sluttspill → velg vinner.
- **Pall:** når finalen er avgjort, vises 1., 2. og 3. plass med logo og navn øverst under Kamper → Sluttspill.
- **Hvem endret hva:** hvert kort viser «Sist endret av eskil kl. 12:03».
- **Følg lag virker:** man kan følge flere lag (f.eks. sitt eget og en kompis sitt). Lagene utheves i tabellen, neste kamp deres vises øverst, og fanen «★ Favoritter» under Kamper viser et kampskjema med én kolonne per lag. Varsel (på siden, og som systemvarsel hvis det er tillatt) kommer bare ved sluttresultat, og bare mens siden er åpen.
- **Finalen** har egen rad etter plasseringskampene, med dobbel gullkant og stjerne.
- **Inngang:** passordet «siuuuuuuu» frem til 9. oktober, deretter bibelgåte til kampdagen kl. 08.30, så åpent.

## Slått sammen fra forrige versjon (main 5)

- **Nominasjoner til priser:** i dommermodus trykker dommeren «★ Nominer til pris», velger pris (Årets Puskás, Beste lagfeiring eller Årets gullhanske) og lag, skriver spillerens navn (ikke for lagfeiring) og beskriver målet, feiringen eller redningen. Kamp og motstander lagres automatisk, sammen med hvem som nominerte.
- **Legg til i etterkant:** på «Nominert» kan admin trykke «+ Legg til nominasjon», velge blant alle ti lag og (valgfritt) hvilken kamp det gjaldt. Uten kamp lagres den som «lagt til i etterkant».
- **Fanen «Nominert»** vises bare for admin-er. Den samler nominasjonene per pris, slår sammen samme spiller på samme lag og sorterer etter antall nominasjoner. Hver admin kan bare slette sine egne. Publikum ser dem aldri (API-et krever admininnlogging).
- **Dommermodus:** «Start kampen» før avspark, og etter «Avslutt kamp» en knapp til neste kamp på samme bane.
- **Store −/+** ved målfeltene på admin-kortene, og vinneren utheves på ferdige kamper.
- **Mobil:** fanene ligger nederst, og tabellen viser bare K, MF og Poeng.
- **Gratisplan hos Cloudflare:** se «Kapasitet» under.
- Lasteskjermen vises ved hver innlasting i 3–5 sekunder og viser én tilfeldig pikselfotball-GIF. Innloggede admin-er og dommere slipper den.

## Adminbrukere

Standardlista er `daniel, eskil, ida, lars, martin, andreas, admin1, admin2, admin3, camilla` (samme passord for alle). Begge oppsettskriptene bruker denne lista når du ikke oppgir `--users`.

## Før publisering

Kjør `python3 setup_admin.py` og velg administratorpassord. Dette lager `private/admin.json`, som ikke skal legges på GitHub.

## Kjør lokalt

Kjør `npm run lokal` (eller `sh start-lokalt.sh`) fra `finales/`. Første gang lager den en lokal admininnlogging (du velger passord) og en lokal database. Deretter starter den selve `worker.js`, akkurat som på Cloudflare:

- PC: http://localhost:8787
- Mobil på samme wifi: adressen som skrives ut (http://10.x.x.x:8787 eller http://192.168.x.x:8787)

`npm run nullstill-lokalt` sletter alle lokale resultater. Innloggingscookien er uten `Secure` bare på localhost og lokale nettverksadresser, ellers ville Safari avvist den over http. På konfaction.no er den alltid `Secure`. Over http://10.x på mobilen virker ikke «hold skjermen våken» og systemvarsler (nettleseren krever https), men alt annet gjør det.

Alternativ: `python3 server.py` og åpne `http://127.0.0.1:8767` (samme API, SQLite).

Nettsiden henter nye resultater hvert 60. sekund (admin: hvert 15. sekund, dommermodus: hvert 20. sekund). Den stopper mens fanen er i bakgrunnen og henter på nytt når den vises igjen, hvis det er mer enn 15 sekunder siden sist. Resultater lagres i `private/scores.sqlite3`; også denne filen er utelatt fra GitHub og ZIP-en.

Tilgangen styres i tre faser. Frem til 9. oktober kl. 00:00 må besøkende skrive passordet «siuuuuuuu». Fra 9. oktober kl. 00:00 til 10. oktober kl. 08:30 må de løse en tilfeldig bibelgåte. Fra kl. 08:30 på kampdagen er siden åpen for alle. Tilgangen gjelder bare fasen den ble gitt i, så den som skrev passordet før 9. oktober må også løse bibelgåten. Administratorinnlogging er fortsatt tilgjengelig. Svarene ligger i serverkoden (`server.py` lokalt, `worker.js` på Cloudflare), så siden skal ikke publiseres som en åpen, statisk fil-side dersom inngangsgåten skal fungere som adgangskontroll.

## Inkludert i finalen

- 2–5 sekunders (tilfeldig, ned til millisekundet) pixel-art lasteskjerm med tilfeldig valgt GIF. GIF vises kun her — forsiden og inngangssiden bruker stillbilder generert fra samme motiver.
- Mulighet for å følge et lag og velge nettleservarsler
- Bekreftelsesboks før administrator låser inn et resultat
- Oppdatert informasjon om sammenhengende kamper, matpause og premieutdeling kl. 14.15

## GitHub

Alt som trengs for kildekoden ligger i ZIP-en. `.gitignore` utelater administratoroppsett, lokale resultater og vanlige midlertidige filer. Kontroller at `private/` ikke blir lagt til før du pusher.

## Filstruktur

- `dist/` – den synlige nettsiden, logo og favicon
- `config/tournament.json` – lag, kamper, klokkeslett og baner
- `server.py` – lokal/serverbasert API for delte resultater og admininnlogging (Python, kun for lokal kjøring)
- `worker.js` – samme API som en Cloudflare Worker, for produksjonshosting
- `setup_admin.py` – lager en lokal, passordbeskyttet administratorfil for `server.py`
- `setup_admin_cloudflare.py` – genererer admin-hemmeligheter og skriver ut `wrangler secret put`-kommandoene for `worker.js`
- `schema.sql` / `seed.sql` – D1-databaseskjema og startrader (én per kamp)
- `wrangler.jsonc` – Cloudflare Worker-konfigurasjon

Kampoppsettet kan gjenbrukes for en annen cup ved å redigere `config/tournament.json`.

## Publisere på Cloudflare

Python-serveren (`server.py`) er kun for lokal testing — Cloudflare Workers kjører ikke Python. `worker.js` er den faktiske produksjonsversjonen: samme API, men med D1 i stedet for SQLite og en signert cookie i stedet for en økter-i-minnet-liste (en Worker har ingen langlevd prosess å holde den i).

Kjør fra `finales/` (`npm install` er allerede gjort i denne økten):

```
npx wrangler login
npx wrangler d1 create konfaction
```

Lim `database_id` fra output inn i `wrangler.jsonc`. Deretter:

```
npx wrangler d1 execute konfaction --remote --file=schema.sql
npx wrangler d1 execute konfaction --remote --file=seed.sql
python3 setup_admin_cloudflare.py   # skriver ut to "wrangler secret put"-kommandoer — kjør dem
npx wrangler deploy
```

### Oppdatere en database som allerede er i drift

Har du kjørt `schema.sql` før 23.09, kjør migreringen én gang før `wrangler deploy`:

```
npx wrangler d1 execute konfaction --remote --file=migrations/0002_dommermodus.sql
npx wrangler d1 execute konfaction --remote --file=migrations/0003_nominasjoner.sql
npx wrangler d1 execute konfaction --remote --file=migrations/0004_starttid.sql
```

`0004_starttid.sql` legger til kolonnen for når dommeren trykket «Start kampen». Den må kjøres på en database laget før 24.09, ellers feiler «Start kampen». Nye databaser laget med dagens `schema.sql` trenger ingen migreringer.

`0003_nominasjoner.sql` lager tabellen for nominasjoner. Den er trygg å kjøre selv om tabellen finnes fra før, og rører ikke resultatene.

Kjør også `python3 setup_admin_cloudflare.py` på nytt (se «Kapasitet»), og kjør kommandoene den skriver ut.

## Kapasitet på gratisplanen

| Grense (gratis) | Før | Nå |
|---|---|---|
| 100 000 Worker-forespørsler/dag | poll hvert 5. s, også i bakgrunnen: ~430 000 ved 150 telefoner | 60 s for publikum (admin 15 s), pause i bakgrunnen. Verste tilfelle, 100 skjermer åpne i alle fire timene: ~24 000, pluss 8 admin-er: ~7 700 |
| 5 M D1-radlesinger/dag | 36 rader per poll | 2 rader når ingenting er endret (`?since=`-nøkkel), 36 bare når noe har skjedd |
| 100 000 D1-skrivinger/dag | – | 2 per mål (resultat + revisjon) – langt under |
| Bilder, CSS, JS og GIF-er | gikk gjennom Workeren (`run_worker_first: true`) og telte med | bare `/`, `/index.html` og `/api/*` går gjennom Workeren; resten er gratis statiske filer |
| 10 ms CPU per forespørsel | innlogging brukte ~250 ms (PBKDF2 600 000) | 10 000 runder ≈ 4–5 ms. Lagres per bruker i `ADMIN_USERS` (`iter`) |

Brukere laget med det gamle skriptet (uten `iter`) virker fortsatt, men med 600 000 runder – derfor bør `setup_admin_cloudflare.py` kjøres på nytt.

Legg til et custom domain (f.eks. `konfaction.no`) i Cloudflare-dashbordet under Workers → Settings → Domains & Routes, eller:

```
npx wrangler deploy --name konfaction-no
```

og koble domenet i dashbordet etterpå. Domenet peker i dag mot GitHub Pages («Site not found») og må flyttes til Workeren.

## Sjekkliste før 9. oktober

1. Workeren er publisert, og konfaction.no viser passordsiden.
2. `ADMIN_USERS` er laget med `setup_admin_cloudflare.py` (med `iter`), og alle admin-er har testet innlogging.
3. Test hele flyten én gang i produksjon med en testkamp: Start → mål → Avslutt → Rett resultat. Nullstill kampen etterpå med «Rett resultat» → Status «Ikke startet».
4. Slå på varsel om bruk i Cloudflare. Vurder Workers Paid (5 USD) for oktober: på gratisplanen stopper hele siden hvis grensen på 100 000 forespørsler nås, og vi har ingen reserve.
5. Del ut en kort instruks til dommerne: Start kampen når du blåser i gang, trykk på laget som scorer, Avslutt kampen når du blåser av. `.dev.vars` (lokalt secrets-oppsett for `wrangler dev`) skal aldri committes — den ligger i `.gitignore`.
