# KonfAction Trøndelag Fotballcup

Nettside for cupen i Stjørdal 10. oktober, med norsk livetabell, kamper, sluttspilloppsett, utmerkelser og adminsikret resultatregistrering.

Den ferdige turneringsplanen har 30 seriekamper: seks kamper per lag, uten at et lag spiller tre runder på rad. Fem sluttspillkamper følger etter seriespillet, inkludert finale på bane 1. Totalt er det 35 kamper.

## Nytt i denne versjonen (23.09)

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
- Lasteskjermen vises bare første gang i hver nettleserøkt, og hoppes over ved «redusert bevegelse».

## Adminbrukere

Standardlista er `daniel, eskil, ida, lars, martin, andreas, admin1, admin2, admin3, camilla` (samme passord for alle). Begge oppsettskriptene bruker denne lista når du ikke oppgir `--users`.

## Før publisering

Kjør `python3 setup_admin.py` og velg administratorpassord. Dette lager `private/admin.json`, som ikke skal legges på GitHub.

## Kjør lokalt

Anbefalt: `npx wrangler dev` (kjører selve `worker.js` med en lokal D1, akkurat som i produksjon). Første gang: `npx wrangler d1 execute konfaction --local --file=schema.sql` og `--file=seed.sql`, og legg `ADMIN_USERS` og `SESSION_SECRET` i `.dev.vars`.

Alternativ: `python3 server.py` og åpne `http://127.0.0.1:8767` (samme API, SQLite).

Nettsiden henter nye resultater hvert 12. sekund når en kamp pågår, ellers hvert 30. sekund (admin: hvert 8. sekund). Den stopper mens fanen er i bakgrunnen og henter på nytt med en gang den vises igjen. Resultater lagres i `private/scores.sqlite3`; også denne filen er utelatt fra GitHub og ZIP-en.

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
```

`0003_nominasjoner.sql` lager tabellen for nominasjoner. Den er trygg å kjøre selv om tabellen finnes fra før, og rører ikke resultatene.

Kjør også `python3 setup_admin_cloudflare.py` på nytt (se «Kapasitet»), og kjør kommandoene den skriver ut.

## Kapasitet på gratisplanen

| Grense (gratis) | Før | Nå |
|---|---|---|
| 100 000 Worker-forespørsler/dag | poll hvert 5. s, også i bakgrunnen: ~430 000 ved 150 telefoner | 12 s når noe pågår / 30 s ellers (admin 8 s), pause i bakgrunnen: ~30–45 000 ved 150 telefoner |
| 5 M D1-radlesinger/dag | 36 rader per poll | 2 rader når ingenting er endret (`?since=`-nøkkel), 36 bare når noe har skjedd |
| 100 000 D1-skrivinger/dag | – | 2 per mål (resultat + revisjon) – langt under |
| Bilder, CSS, JS og GIF-er | gikk gjennom Workeren (`run_worker_first: true`) og telte med | bare `/`, `/index.html` og `/api/*` går gjennom Workeren; resten er gratis statiske filer |
| 10 ms CPU per forespørsel | innlogging brukte ~250 ms (PBKDF2 600 000) | 10 000 runder ≈ 4–5 ms. Lagres per bruker i `ADMIN_USERS` (`iter`) |

Brukere laget med det gamle skriptet (uten `iter`) virker fortsatt, men med 600 000 runder – derfor bør `setup_admin_cloudflare.py` kjøres på nytt.

Legg til et custom domain (f.eks. `konfaction.no`) i Cloudflare-dashbordet under Workers → Settings → Domains & Routes, eller:

```
npx wrangler deploy --name konfaction-no
```

og koble domenet i dashbordet etterpå. `.dev.vars` (lokalt secrets-oppsett for `wrangler dev`) skal aldri committes — den ligger i `.gitignore`.
