# 04 · Overlevering

> Merk: I denne økten ble planen også gjennomført (brukeren ba om «planlegg og kjør»). Prompten under beskriver jobben slik den ble gjort, og kan brukes til å gjenta eller videreføre den.

```
/make-plan Redesign resultatregistreringen (admin/dommer) i KonfAction Trøndelag Fotballcup (finales/). Dagens design fikk 14/30 i en Dieter Rams-revisjon, med kritiske mangler i #2 nyttig (1), #4 forståelig (1) og #6 ærlig (1).

Dom:
> REDESIGN – avgrenset til resultatregistreringen (admin/dommer), REFINE for de offentlige visningene. Svakhetene ligger i registreringsflyten (to lagringsmåter, blokkert sluttspill, ingen hjemme/borte, ikke laget for én hånd på en telefon ute), så det er den som bygges på nytt.

Hvorfor redesign og ikke refine: tre bærende prinsipper (#2, #4, #6) skårer 1 og totalen er under 20.

Bevar:
- KRIK-profilen: --color-primary #1c5d9f, --color-primary-dark #0d3c6c, Exo (dist/style.css:1), krik_logo.svg.
- Lagvåpnene i dist/crests.js (crest(), COLORS).
- Tabellen med sluttspill-fargekoding (.pair-0 … .pair-4).
- Sikkerhetsmodellen i worker.js: HMAC-cookie, CSRF, Origin-sjekk, rate limit, versjonsnummer per kamp.
- Flere adminbrukere via ADMIN_USERS (daniel, eskil, ida, lars, martin, andreas, admin1, admin2).

Forkast:
- Små tallfelt + «Lagre resultat» med «Låse inn»-bekreftelse samtidig med autolagring. Bevis: app.js:10–12. Ga feil på #2 og #6.
- Blokkert sluttspill til klokka har avsluttet alle seriekamper. Bevis: app.js:10, worker.js:131. Ga feil på #2.
- Skjult, ufunksjonell «Følg lag». Bevis: index.html:3,11. Ga feil på #6.
- Dobbel rundevelger (select + knapper). Bevis: index.html:7. Ga feil på #10.

Fem grep:
1. #2 – Dommermodus i fullskjerm: trykk på lagets logo = +1, −1/Angre, nedtelling, «Avslutt kamp», vinnervalg ved uavgjort i sluttspill. Atomisk /api/goal. Bevis: app.js:10–12.
2. #2/#4 – Sluttspill likt som andre kamper: /api/seeding lock/unlock + pall (1.–3.) i sluttspillvisningen når finalen er avgjort. Bevis: app.js:10, worker.js:131.
3. #4 – «Hjemme · vester» / «Borte» over hver lagrad; vesteregel i «Om turneringen» (hjemmelaget har vester, henges i målet etter kampen).
4. #6 – Knapper som gjør det de sier; ekte «Følg lag»; én tiebreak-regel overalt. Bevis: index.html:3,11,12; worker.js:117 vs server.py:44.
5. #9 – Gratisplan: ?since=-nøkkel, adaptiv polling med pause i bakgrunnen, PBKDF2-runder per bruker. Bevis: app.js:17, worker.js:23.

Prioritet i redesignet:
1. #2 Nyttig – en dommer registrerer et mål med ett trykk med tommelen, uten å bytte skjerm.
2. #4 Forståelig – en konfirmant ser hvem som har vester uten å spørre.
3. #6 Ærlig – hver knapp og tekst stemmer med det som faktisk skjer.

Leveranser: ny flyt for admin-kort → dommermodus → avslutt; tilstander (tom, laster, feil, lagret, fokus, deaktivert); D1-migrering for eksisterende database (migrations/0002_dommermodus.sql); overgang: gammel flyt fjernes i samme deploy, ingen flagg.

Unngå: gammel struktur med ny stil; begge flyter bak et flagg; trendstyrt design; å hoppe over Bevar-listen.
```
