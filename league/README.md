# KonfAction Trøndelag Fotballcup

Nettside for cupen i Stjørdal 10. oktober, med norsk livetabell, kamper, sluttspilloppsett, utmerkelser og adminsikret resultatregistrering.

## Før publisering

Kjør `python3 setup_admin.py` og velg administratorpassord. Dette lager `private/admin.json`, som ikke skal legges på GitHub.

## Kjør lokalt

Kjør `python3 server.py` og åpne `http://127.0.0.1:8767`.

Nettsiden oppdaterer resultater hvert femte sekund. Resultater lagres i `private/scores.sqlite3`; også denne filen er utelatt fra GitHub og ZIP-en.

## GitHub

Alt som trengs for kildekoden ligger i ZIP-en. `.gitignore` utelater administratoroppsett, lokale resultater og vanlige midlertidige filer. Kontroller at `private/` ikke blir lagt til før du pusher.

## Filstruktur

- `dist/` – den synlige nettsiden, logo og favicon
- `config/tournament.json` – lag, kamper, klokkeslett og baner
- `server.py` – lokal/serverbasert API for delte resultater og admininnlogging
- `setup_admin.py` – lager en lokal, passordbeskyttet administratorfil

Kampoppsettet kan gjenbrukes for en annen cup ved å redigere `config/tournament.json`.
