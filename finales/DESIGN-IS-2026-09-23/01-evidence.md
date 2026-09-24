# 01 · Bevis (før endringene)

Alle linjehenvisninger gjelder originalfilene.

## Struktur
- Interaktive elementer, Kamper-fanen som admin: 4 faner + rundevelger **to ganger** (`<select id="round">` + 10 rundeknapper, `index.html:7`, `app.js:14`) + per kamp 2 tallfelt, 1 statusvalg, 1 «Lagre resultat» (`app.js:10`).
- Dupliserte affordanser: rundevelger ×2; lagring ×2 (autolagring etter 550 ms, `app.js:12`, **og** «Lagre resultat» med bekreftelse, `app.js:12`).
- Død funksjon: «Følg lag»-knappen er `hidden` (`index.html:3`) og vises bare hvis et lag allerede er lagret (`app.js:19`) – kan aldri åpnes første gang. Valgt lag brukes ingen steder, og varsler sendes aldri.
- Sluttspill: `editable=admin&&!m.provisional` (`app.js:10`); `provisional` er sann til alle 30 seriekamper er *avsluttet etter klokka* (`worker.js:131`). Ingen måte å låse oppsettet manuelt.

## Visuelt (lest fra CSS + skjermbilder)
- Typeskala (px): 10, 11, 12, 14, 15, 16, 18, 19, 20, 22, 24, 26, 28, 30, 32, 33, 42, 44 – 18 trinn.
- Farger: 11 variabler + ~20 hardkodede hex (`#126b4c`, `#983322`, `#e8f0f9`, `#092c50` …).
- Tilstander: fokus ✔ (`style.css:1`), deaktivert ✔, feil ✔ (`#error`), suksess ✔ («Lagret»), lasting ✘ (kunstig lasteskjerm 2–5 s i stedet), tom-tilstand delvis. `prefers-reduced-motion` ✘. `100vh` på inngangssiden.
- Hjemme/borte vises ikke noe sted; vester nevnes ikke.

## Tekst og ærlighet
- «Loading KonfAction-turnering …» – engelsk på norsk side, og lasteskjermen venter kunstig 2–5 s uansett (`app.js:19`).
- «Låse inn … Resultatet blir synlig for alle» (`index.html:12`) – men resultatet er allerede lagret og synlig via autolagring.
- «Velg et lag for å se deres kamper først. Du kan også få varsler …» (`index.html:11`) – ingen av delene er implementert.
- Rangering ved likhet: `server.py:44–58` bruker målforskjell → scorede mål → innbyrdes; `worker.js:117` bruker bare poeng → målforskjell. Produksjon og lokal test kan gi ulik tabell, og regelen står ikke i «Om turneringen».
- Forkortelser K/S/U/T/MF uten forklaring.

## Vekt og friksjon
- JS: app.js 11 KB + crests.js 1 KB – bra.
- `krik_favicon.svg` **942 KB** lastes på hver side. Laste-GIF opptil 410 KB.
- Polling hvert 5. sekund, også i bakgrunnsfaner (`app.js:17`). Hver poll = `SELECT * FROM scores` (35 rader) + 1 meta-rad.
  - 150 telefoner × 12 poll/min × 240 min ≈ **432 000 forespørsler/dag** (grense 100 000) og ≈ 15,5 M radlesinger (grense 5 M).
- Innlogging: PBKDF2 600 000 runder = ~250–280 ms CPU målt i workerd. Gratisplanen tillater 10 ms → risiko for feil 1102 når admins logger inn på kampdagen.

## Tilgjengelighet
- Ingen hopp-til-innhold-lenke. Lukkeknapper (×) uten `aria-label` i to dialoger. Fokusringer finnes. Landemerker: header, nav, main, footer.
