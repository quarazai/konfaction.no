# 00 · Omfang

**Revidert:** KonfAction Trøndelag Fotballcup (`finales/`), versjonen på Desktop 23.09.2026 (identisk med `konfaction.no-main 3.zip`).
**Flater:** Tabell, Kamper (runde 1–9 og sluttspill), Om turneringen, admin-innlogging, admin-registrering av resultater.
**Metode:** Kildekode lest i sin helhet + kjørt lokalt i workerd (`wrangler dev`, lokal D1) + skjermbilder i Chromium på 390 px (telefon) og 1280 px.

**Primærbrukere og -oppgaver**
1. Dommer/admin på sidelinja (telefon, ute, ofte én hånd): registrere mål mens kampen pågår og avslutte kampen. Opptil 8 admins samtidig.
2. Konfirmanter og ledere (telefon): se tabell, neste kamp og hvilket lag som har vester.

**Rammer:** Norsk, mobil først. Cloudflare Workers + D1 på gratisplan (100 000 forespørsler/dag, 10 ms CPU per forespørsel, 5 M radlesinger/dag). Vanlig JS uten rammeverk. KRIK-profil (blå, Exo).
**Kampdag:** 10. oktober 2026, 35 kamper kl. 10.35–14.10.
