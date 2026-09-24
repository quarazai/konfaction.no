# 03 · Dom

**REDESIGN – avgrenset til resultatregistreringen (admin/dommer), REFINE for de offentlige visningene.**

Totalen er 14/30 (< 20), og de bærende prinsippene #2 nyttig, #4 forståelig og #6 ærlig skårer alle 1 – derfor REDESIGN etter regelen. Svakhetene ligger i registreringsflyten (to lagringsmåter, blokkert sluttspill, ingen hjemme/borte, ikke laget for én hånd på en telefon ute), så det er den som bygges på nytt. Tabellen og profilen bevares.

## De fem viktigste grepene
1. **#2 Nyttig – dommermodus:** fullskjerm per kamp med lagenes logoer; trykk på laget = +1 mål, −1 og «Angre». Atomisk økning i D1 så flere admins kan trykke samtidig. *Bevis: `app.js:10–12` (små tallfelt + lagreknapp).*
2. **#2/#4 – sluttspill som alle andre kamper:** manuell «Lås oppsettet nå» (og «Lås opp»); pall med 1.–3. plass når finalen er avgjort. *Bevis: `app.js:10` (`editable=admin&&!m.provisional`), `worker.js:131`.*
3. **#4 Forståelig – hjemme/borte og vester:** «Hjemme · vester» / «Borte» over hver lagrad og i dommermodus; regelen i «Om turneringen». *Bevis: ingen forekomst i originalen.*
4. **#6 Ærlig – knapper som gjør det de sier:** «Lagre resultat» erstattes av «Avslutt kamp» (setter status); «Følg lag» virker (utheving, neste kamp øverst, varsler mens siden er åpen); én tiebreak-regel i begge servere og i teksten. *Bevis: `index.html:3,11,12`, `worker.js:117` vs `server.py:44`.*
5. **#9 Miljøvennlig – gratisplanen:** endringsnøkkel (`?since=`) gjør at uendret poll leser 2 rader; 8 s når noe pågår, 20 s ellers, pause i bakgrunnsfaner; PBKDF2-runder per bruker (10 000 ≈ 5 ms). *Bevis: `app.js:17`, `worker.js:23`.*
