# Printmateriell

Klart-til-å-printe A4-plansjer for kampdagen, i lagfargene fra selve nettsiden.

## Filer

- **`kampoppsett.pdf`** — det som skal printes og henges opp: 2 sider med hele kampoppsettet (5 runder per side, 2 og 2 side om side, sluttspillet som eget infokort nederst på side 2), 1 liggende infoside (nettside/følg-live), 1 KRIK-logoplansje.
- **`generate.py`** — lager `kampoppsett.tex` fra `../config/tournament.json` (kamper/tider/baner) og `../dist/crests.js` (lagfarger). Ingen tall er tastet inn for hånd.
- **`kampoppsett.tex`** — generert av `generate.py`. Ikke rediger for hånd.
- **`krik_logo.png`** — KRIK-logoen, beskjært for logoplansjen.

## Slik printes det på nytt

Etter en endring i `config/tournament.json` (nytt kampoppsett) eller `dist/crests.js` (nye lagfarger):

```bash
cd print
python3 generate.py
/Library/TeX/texbin/pdflatex -interaction=nonstopmode kampoppsett.tex
/Library/TeX/texbin/pdflatex -interaction=nonstopmode kampoppsett.tex   # to ganger: TikZ-hullmarkeringen trenger det
```

Krever en LaTeX-installasjon (testet med BasicTeX/TeX Live) med `xcolor`, `array`, `graphicx`, `pdflscape`, `tikz` — alle standard i en full TeX-distribusjon.

## Praktisk

- **Hull til strips:** to grå sirkler øverst på hver stående side viser hvor det er trygt å stanse hull, uten å treffe farget felt eller tekst.
- **Heng opp i plastlomme** med strips gjennom hullene, f.eks. på et gjerde eller en tavle ved banene.
- Fargene på hvert lag matcher nøyaktig fargene på nettsiden (lest direkte fra `dist/crests.js`), så det er lett å kjenne igjen laget sitt fra avstand.
