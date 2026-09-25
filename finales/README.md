# KonfAction Trøndelag Fotballcup

Nettside for cupen i Stjørdal 10. oktober, med norsk livetabell, kamper, sluttspilloppsett, utmerkelser og adminsikret resultatregistrering.

Den ferdige turneringsplanen har 30 seriekamper: seks kamper per lag, uten at et lag spiller tre runder på rad. Fem sluttspillkamper følger etter seriespillet, inkludert finale på bane 1. Totalt er det 35 kamper.

## Endelig versjon (25.09)

**Kampdagsplan (`config/tournament.json`):**
- Første avspark kl. 10.30. Hver seriekamp er 15 minutter, med runder hvert 20. minutt: runde 1 kl. 10.30 … runde 9 kl. 13.10–13.25.
- Ekstra pause etter runde 9: sluttspillet starter kl. 13.35 (10 minutter etter siste seriekamp), finalen kl. 13.55–14.10 og premieutdeling kl. 14.15.
- Baner: runder med to eller tre samtidige kamper bruker bare bane 1–2 eller 1–3 (aldri bane 4). Ingen lag spiller på samme bane to runder på rad, og ingen lag har mer enn to seriekamper på samme bane. Bane 4 brukes bare i de fire rundene med fire kamper, og i sluttspillet.
- Kampene vises alltid i banenummerets rekkefølge.
- Tabellen skiller lag på poeng, målforskjell, scorede mål og innbyrdes oppgjør. Er lagene fortsatt helt like, avgjøres det ved **myntkast** (står i Om turneringen). Det gjelder bare når hele serien er ferdig og de like lagene havner i hvert sitt sluttspillpar (grensen mellom plass 2|3, 4|5, 6|7 eller 8|9). Like lag i samme par (f.eks. 1 og 2) bytter bare hjemme/borte og står i fast lagrekkefølge, uten myntkast.
- **Myntkast i to trinn (admin):** 1) «Kast» – serveren trekker utfallet (to lag: mynt, tre eller flere: loddtrekning) og viser det som forslag. Bare ett kast per gruppe kan lagres; flere som trykker samtidig får samme utfall, og det kan ikke kastes på nytt. 2) «Godkjenn» – en admin (samme eller en annen) godkjenner, og sluttspillet låses automatisk når ingen flere myntkast venter. Før det er sluttspillet foreløpig, og «Lås oppsettet nå» er sperret.
- **Nødutgang:** så lenge ingen har kastet for gruppen, kan en admin velge fast lagrekkefølge i stedet. Det teller som godkjent med en gang, så turneringen aldri blir stående fast. Avgjørelsene lagres i `meta` (`tie:Lag1|Lag2`), uten ny migrering. Endrer en rettelse hvilke lag som er like, gjelder ikke den gamle avgjørelsen, og en ny gruppe må kastes på nytt.
- Lasteskjermens GIF-er er skalert ned (1 136 → 500 KB); pikselkunsten er lagret i sin egen oppløsning og skalert opp med hele tall, så den ser lik ut.

**Sluttspillet under Kamper:** låst med hengelås-skjold til alle 30 seriekamper er ferdigspilt. Da settes lagene inn automatisk etter tabellen (admin kan også låse oppsettet manuelt). Låsen viser fremdrift («5 av 30 seriekamper spilt»). Dommermodus virker på sluttspillkampene så snart de er åpnet; uavgjort krever vinner fra straffer.

**Inngang (Worker og lokal server):**
- Før 9. oktober kl. 00.00 (norsk tid): passordet.
- 9. oktober kl. 00.00 til 10. oktober kl. 08.30: bibelgåte (fem spørsmål, ett trekkes tilfeldig; svar skiller ikke mellom store og små bokstaver). Et passordbevis fra før 9. oktober åpner *ikke* gåtefasen.
- Fra 10. oktober kl. 08.30: åpent for alle uten passord. Inngangssiden og hovedsiden sendes med `Cache-Control: no-store`, så ingen ser en gammel inngangsside etter åpning.

**Utseende:** gressbane som tema (samme gresstepper på forside, lasteskjerm, inngang og bakgrunn), grønne kort, gule markeringer, egne skjold for premiene og hengelås. Legg til `?lys` i adressen for å se den lyse utgaven.

**Flere dommere samtidig:** hvert måltrykk får en unik id som serveren teller bare én gang, og appen sender samme id på nytt ved nettfeil (ingen dobbelttelling eller tapt mål). Skjermen hopper ikke tilbake til gammel stilling. Databasefeil gir en ryddig melding (503) i stedet for krasj. Se testene som er beskrevet i pull requesten.

**Sikkerhetshoder:** HTML-sidene får CSP, `X-Frame-Options`, HSTS og `no-store` fra Worker; statiske filer får sine fra `dist/_headers`.

**Før publisering:**
1. Sett GitHub-repoet til **privat** (Settings → Danger zone). Passordet og bibelsvarene står i `worker.js`/`server.py`, og repoet er offentlig så lenge det ikke er endret.
2. Kjør `python3 setup_admin_cloudflare.py` og lag de to `wrangler secret put`-kommandoene med et langt, tilfeldig passord (ikke det enkle testpassordet).
3. Etter `wrangler deploy`: logg inn som admin med én gang. Skriptet bruker 5 000 PBKDF2-runder (≈3–4 ms CPU av 10 ms på gratisplanen). Får du feil 1102 ved innlogging, kjør skriptet på nytt med `--iterations 2000` eller bytt til betalt plan. Innloggingen varer i 8 timer, så logg inn tidlig på morgenen.
4. Kjør `npx wrangler deploy --dry-run` før hver publisering for å sjekke konfigurasjonen.

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

## Lokal Python-server (bare for testing)

Kjør `python3 setup_admin.py` og velg administratorpassord. Dette lager `private/admin.json` (brukes bare av `server.py`, ikke av Cloudflare), og den skal ikke legges på GitHub.

## Kjør lokalt

Kjør `npm run lokal` (eller `sh start-lokalt.sh`) fra `finales/`. Første gang lager den en lokal admininnlogging (du velger passord) og en lokal database. Deretter starter den selve `worker.js`, akkurat som på Cloudflare. Dette krever macOS 13.5 eller nyere (Cloudflare-motoren `workerd` virker ikke på eldre macOS); på en eldre Mac bruker du `python3 server.py` (se under).

`start-lokalt.sh` lytter på alle nettverkskort (`--ip 0.0.0.0`) så mobilen kan teste på samme wifi. Bruk det bare hjemme eller på et nett du stoler på, aldri på åpent wifi: den lokale innloggingen og cookien går over vanlig http.

- PC: http://localhost:8787
- Mobil på samme wifi: adressen som skrives ut (http://10.x.x.x:8787 eller http://192.168.x.x:8787)

`npm run nullstill-lokalt` sletter alle lokale resultater. Innloggingscookien er uten `Secure` bare på localhost og lokale nettverksadresser, ellers ville Safari avvist den over http. På konfaction.no er den alltid `Secure`. Over http://10.x på mobilen virker ikke «hold skjermen våken» og systemvarsler (nettleseren krever https), men alt annet gjør det.

Alternativ: `python3 server.py` og åpne `http://127.0.0.1:8767` (samme API og samme regler, SQLite). Den lytter bare på denne maskinen; `--host 0.0.0.0` slipper inn mobiler på samme wifi (samme advarsel som over).

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

Kjør fra `finales/` (krever Node.js 20 eller nyere og en Cloudflare-konto):

```
npm install
npx wrangler login
npx wrangler d1 create konfaction --location weur
```

`d1 create` skriver ut en `database_id` (en lang id med bindestreker). Spør wrangler om den skal legge databasen inn i konfigurasjonen for deg, svar **nei**. Åpne `wrangler.jsonc` og bytt ut `REPLACE_AFTER_CREATING_D1` med id-en. La `"binding": "DB"` og `"database_name": "konfaction"` stå som de er. Deretter:

```
npx wrangler d1 execute konfaction --remote --file=schema.sql
npx wrangler d1 execute konfaction --remote --file=seed.sql
npx wrangler deploy
python3 setup_admin_cloudflare.py   # spør etter passord, skriver ut to "wrangler secret put"-kommandoer
```

Kjør de to kommandoene skriptet skriver ut (`ADMIN_USERS` og `SESSION_SECRET`). Hemmelighetene gjelder med en gang, uten ny `deploy`. Test deretter: åpne adressen `wrangler deploy` skrev ut (`https://konfaction-no.<konto>.workers.dev`), skriv passordet på forsiden, og logg inn som admin.

- Glemmer du hemmelighetene, svarer siden «Serveren er ikke ferdig satt opp» ved inngang og innlogging. Glemmer du `schema.sql`, svarer den «Databasen er ikke satt opp riktig». `wrangler tail` viser hva som mangler.
- `seed.sql` lager én rad per kamp. Workeren lager radene selv hvis de mangler, så det er ufarlig å kjøre den flere ganger eller å glemme den.
- Bruk bare `schema.sql` og `seed.sql` på en ny database. Migreringene under er for gamle databaser.

### Oppdatere en database som allerede er i drift

Har du kjørt `schema.sql` før 23.09, kjør migreringen én gang før `wrangler deploy`. Feiler en av dem med `duplicate column name`, finnes kolonnen allerede. Det er ufarlig; gå videre til neste fil.

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
| 10 ms CPU per forespørsel | innlogging brukte ~250 ms (PBKDF2 600 000) | 5 000 runder ≈ 3 ms (hele innloggingen ≈ 4–5 ms målt i Node; 10 000 runder ≈ 6 ms, for tett på grensen). Lagres per bruker i `ADMIN_USERS` (`iter`) |

Brukere laget med det gamle skriptet (uten `iter`) virker fortsatt, men med 600 000 runder – derfor bør `setup_admin_cloudflare.py` kjøres på nytt.

**Eget domene (konfaction.no):** domenet må først ligge i samme Cloudflare-konto (Add a domain i dashbordet, og bytt navnetjenere hos registraren til dem Cloudflare oppgir; det kan ta noen timer). Deretter: Workers & Pages → `konfaction-no` → Settings → Domains & Routes → Add → Custom domain → `konfaction.no` (og gjerne `www.konfaction.no`). Cloudflare lager DNS-posten og sertifikatet selv. Slett de gamle GitHub Pages-postene (A/CNAME) for domenet først. Domenet peker i dag mot GitHub Pages («Site not found»). Gjør dette i god tid før 9. oktober.

## Sjekkliste før 9. oktober

1. Workeren er publisert, og konfaction.no viser passordsiden.
2. `ADMIN_USERS` er laget med `setup_admin_cloudflare.py` (med `iter`), og alle admin-er har testet innlogging.
3. Test hele flyten én gang i produksjon med en testkamp: Start → mål → Avslutt → Rett resultat. Nullstill kampen etterpå med «Rett resultat» → Status «Ikke startet».
4. Slå på varsel om bruk i Cloudflare. Vurder Workers Paid (5 USD) for oktober: på gratisplanen stopper hele siden hvis grensen på 100 000 forespørsler nås, og vi har ingen reserve.
5. Del ut en kort instruks til dommerne: Start kampen når du blåser i gang, trykk på laget som scorer, Avslutt kampen når du blåser av. `.dev.vars` (lokalt secrets-oppsett for `wrangler dev`) skal aldri committes — den ligger i `.gitignore`.

## Kampdag-runbook

Kort oppskrift for det som kan gå galt 10. oktober. Alt under er testet mot `worker.js` i en lokal etterligning av Cloudflare, ikke mot selve Cloudflare.

**Før første kamp**
- Admin-er logger inn tidligst kl. 07.00. Innloggingen varer i 8 timer, og en innlogging kl. 06.00 går ut midt i finalen.
- Last ned regnearket («Last ned alle resultater») etter hver runde. Det er backupen hvis alt annet svikter.
- Ha papir og penn ved hver bane. Et resultat på papir kan alltid føres inn i etterkant med «Rett resultat».

**Databasen svarer ikke (D1 nede et øyeblikk)**
- Appen viser «Databasen er travel akkurat nå» og prøver målet på nytt av seg selv. Samme trykk telles bare én gang, så ikke trykk flere ganger.
- Varer det mer enn et par minutter: før resultatet på papir og legg det inn med «Rett resultat» når siden virker igjen. Se feilene med `npx wrangler tail`.

**Dommerens telefon dør midt i kampen**
- Kampen blir stående som «Pågår». Klokka avslutter aldri en kamp av seg selv.
- En annen admin logger inn, åpner kampen (dommermodus eller «Rett resultat») og fortsetter. Alle admin-er kan føre mål, avslutte og rette alle kamper.
- Er stillingen feil, rett den med «Rett resultat» og lagre, eller avslutt og bruk «Åpne kampen igjen».

**Feil resultat er registrert**
- «Rett resultat» på kampkortet, velg riktig stilling og status, og trykk «Lagre rettelse». Tabellen oppdateres med en gang.
- Sluttspilloppsettet låses automatisk når alle 30 seriekampene er avsluttet, og det endres **ikke** av en senere rettelse. Endrer rettelsen hvem som står hvor, trykk «Sett opp på nytt fra tabellen» under Kamper → Sluttspill. Oppsettet settes da straks på nytt fra den rettede tabellen. (Er ikke alle 30 avsluttet, heter knappen «Lås opp igjen», og oppsettet blir foreløpig til seriespillet er ferdig.)
- Knappen vises og virker bare så lenge ingen sluttspillkamp har resultat (også 0–0 etter «Start kampen» teller). Er sluttspillet i gang, må de kampene først settes til «Ikke startet» («Angre start» ved 0–0, ellers «Rett resultat» → «Ikke startet»). Ellers er det arrangøren som bestemmer.
- Står lag helt likt over en pargrense etter runde 9, låses ikke sluttspillet før myntkastet er kastet **og** godkjent (Kamper → Sluttspill). Stopper det opp (f.eks. ingen admin kan kaste), bruk nødutgangen «fast rekkefølge» før noen har kastet.
- Ble oppsettet låst for tidlig med «Lås oppsettet nå» (før runde 9 var ferdig), gjelder det samme: trykk «Sett opp på nytt fra tabellen» når alle 30 er avsluttet.

**Siden er nede for alle (grensen på 100 000 forespørsler per døgn)**
- På gratisplanen stopper Workeren når døgnkvoten er brukt opp. Da laster ikke forsiden, og åpne sider viser feilmelding (sist hentede resultater står fortsatt på skjermen). Kvoten nullstilles kl. 02.00 norsk tid, altså ikke før dagen etter.
- Vanlig bruk ligger godt under grensen (se «Kapasitet»), men én person med et skript kan bruke den opp. Det sikre valget er Workers Paid (5 USD) for oktober. Oppgradering i dashbordet virker med en gang, også midt på dagen. Slå på varsel om bruk uansett.
- Mens siden er nede: før resultater på papir og legg dem inn når den er tilbake.

**Hemmeligheter**
- Et nytt `SESSION_SECRET` logger ut alle: admin-er må logge inn på nytt, og før kl. 08.30 må publikum gjennom inngangen igjen. Bytt det bare hvis en admintelefon er mistet eller innloggingen kan være lekket. «Logg ut» alene gjør ikke en kopiert innloggingscookie ugyldig før den går ut (8 timer).
- Nytt passord eller ny admin: kjør `setup_admin_cloudflare.py` på nytt og bare `ADMIN_USERS`-kommandoen. Innloggede admin-er blir ikke logget ut.

**Nullstille produksjonen etter prøvekjøring (bare før 10. oktober)**

```
npx wrangler d1 execute konfaction --remote --command "UPDATE scores SET hs=NULL,aws=NULL,status='auto',winner=NULL,started_at=NULL,updated_by=NULL,updated_at=NULL,version=0; DELETE FROM meta WHERE key='seeding' OR key LIKE 'g:%' OR key LIKE 'tie:%'; DELETE FROM nominations; DELETE FROM attempts; UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='rev';"
```

Sletter alle resultater, nominasjoner, myntkast og sluttspilloppsettet. Last ned regnearket først hvis noe skal tas vare på.
