#!/usr/bin/env python3
"""Lager kampoppsett.tex fra config/tournament.json og lagfargene i dist/crests.js.

Bruk (fra finales/print/):
    python3 generate.py
    /Library/TeX/texbin/pdflatex -interaction=nonstopmode kampoppsett.tex

Skriptet leser selve turneringsdataen, så oppsettet er alltid det som faktisk
ligger i config/tournament.json -- ingen tall er tastet inn for hånd.
"""
import json, re, pathlib

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent
CONFIG = json.loads((ROOT / "config/tournament.json").read_text())
CRESTS = (ROOT / "dist/crests.js").read_text()

TEAMS = re.search(r"const TEAMS=\[(.*?)\];", CRESTS).group(1)
TEAMS = [t.strip().strip("'") for t in TEAMS.split(",")]
COLORS = re.search(r"const COLORS=\[(.*?)\];", CRESTS).group(1)
COLORS = [c.strip().strip("'").lstrip("#").upper() for c in COLORS.split(",")]
TEAM_COLOR = dict(zip(TEAMS, COLORS))
assert len(TEAM_COLOR) == 10, TEAM_COLOR

matches = CONFIG["matches"]
by_round = {}
for m in matches:
    by_round.setdefault(m["round"], []).append(m)
for r in by_round:
    by_round[r].sort(key=lambda m: m["pitch"])
ROUNDS = sorted(by_round)
assert ROUNDS == list(range(1, 11)), ROUNDS  # 9 seriespillrunder + runde 10 (sluttspill)


def esc(s):
    return s.replace("&", r"\&").replace("%", r"\%").replace("#", r"\#")


def team_cmd(name):
    return "team" + re.sub(r"[^A-Za-z]", "", name)


def hm(t):
    return t.replace(":", ".")


PLACE = {1: "Finale", 3: "Bronsekamp"}


def league_row(m):
    return rf"\kamprad{{{m['pitch']}}}{{{team_cmd(m['home'])}}}{{{esc(m['home'])}}}{{{team_cmd(m['away'])}}}{{{esc(m['away'])}}}"


def league_block(r, wide):
    # wide=False: halvbredde (to runder side om side). wide=True: full sidebredde
    # (runden som ikke har noen makker på siden -- se build_page).
    ms = by_round[r]
    width = "6.2cm" if wide else "2.75cm"
    rows = "\n".join(league_row(m) for m in ms)
    return rf"""\rundeblokk{{RUNDE {r}}}{{Kl. {hm(ms[0]['start'])}}}{{%
\begin{{tabular}}{{@{{}}l C{{{width}}} C{{{width}}}@{{}}}}
{rows}
\end{{tabular}}%
}}"""


def sluttspillkort():
    # Lagene i sluttspillet er ikke kjent før seriespillet er ferdig, så dette
    # er en kompakt infoliste (bane + klokkeslett + hva kampen gjelder) i stedet
    # for fargede lagceller -- annerledes utseende er tilsiktet: dette er info,
    # ikke et kampoppsett med kjente lag ennå.
    ms = by_round[10]
    rows = []
    for m in ms:
        lo, hi = sorted(m["ranks"])
        label = PLACE.get(m["ranks"][1], f"Nr. {lo} mot nr. {hi}")
        rows.append(rf"\sluttspillrad{{{m['pitch']}}}{{{esc(label)}}}{{{hm(m['start'])}}}")
    rows_tex = "\n".join(rows)
    return rf"""\noindent\colorbox{{konfgold}}{{%
  \parbox[c][10mm]{{\dimexpr\textwidth-6pt}}{{\color{{konfgreendark}}\bfseries\Large SLUTTSPILLET\hfill\normalsize Hvem som møtes avgjøres av sluttabellen}}%
}}\par
\vspace{{3mm}}
\begin{{tabular}}{{@{{}}l l r@{{}}}}
{rows_tex}
\end{{tabular}}
\vspace{{2mm}}\par
{{\small Straffer (best av 3, deretter én og én) avgjør uavgjorte sluttspillkamper -- se instruksene.}}"""


color_defs = "\n".join(f"\\definecolor{{{team_cmd(t)}}}{{HTML}}{{{TEAM_COLOR[t]}}}" for t in TEAMS)

# 10 runder fordelt over TO sider med LIKT antall runder på hver (5 + 5): to
# runder side om side, så én full-bredde runde nederst -- gir plass nok til at
# en 4-5-kampers runde aldri renner over, og fyller hele siden via \vfill i
# hoved-flyten (ikke faste minipage-prosenter, som ikke strekket seg ut).
PAGE1 = [1, 2, 3, 4, 5]
PAGE2 = [6, 7, 8, 9, 10]


# Litt under 1/3 (ikke nøyaktig), med vilje: gir noen mm klaring slik at små
# mellomromskilder (f.eks. før første rad) aldri kan dytte siste rad over på
# en ny side. Resten samler seg som en tynn, jevn kant nederst -- ikke en stor
# ubrukt sone.
ROW_H = r"0.322\pagerowsheight"


def build_page(rounds):
    # Strengt symmetrisk rutenett: alltid tre rader, alle nøyaktig like høye
    # (1/3 av siden hver). Hver CELLE (ikke raden som helhet) er en
    # fast-høyde, toppjustert boks -- det er det som gir symmetri: begge
    # rundeoverskriftene i en rad starter i nøyaktig samme høyde, uansett om
    # den ene runden har færre kamper enn den andre. \nointerlineskip mellom
    # radene hindrer at TeX legger til automatisk linjeavstand som ellers ville
    # gjort tre rader a 1/3 side til (vagt) mer enn hele siden.
    pairs = [(rounds[i], rounds[i + 1]) for i in range(0, len(rounds) - 1, 2)]
    leftover = rounds[-1] if len(rounds) % 2 else None
    rows = []
    for a, b in pairs:
        rows.append(
            rf"""\noindent\begin{{minipage}}[t][{ROW_H}][t]{{0.492\textwidth}}
{league_block(a, wide=False)}
\end{{minipage}}\hfill
\begin{{minipage}}[t][{ROW_H}][t]{{0.492\textwidth}}
{league_block(b, wide=False)}
\end{{minipage}}\par\nointerlineskip"""
        )
    if leftover == 10:
        content = sluttspillkort()
    elif leftover is not None:
        content = league_block(leftover, wide=True)
    else:
        content = None
    if content is not None:
        rows.append(
            rf"""\noindent\begin{{minipage}}[t][{ROW_H}][t]{{\textwidth}}
{content}
\end{{minipage}}\par\nointerlineskip"""
        )
    return "\n".join(rows)


grid_tex_1 = build_page(PAGE1)
grid_tex_2 = build_page(PAGE2)

MONTHS = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"]
_y, _mo, _d = CONFIG.get("date", "2026-01-01").split("-")
date = f"{int(_d)}. {MONTHS[int(_mo) - 1]} {_y}"
place = CONFIG.get("location", "")

TEX = rf"""% Genereres av print/generate.py -- ikke rediger for hånd, kjør skriptet på nytt
% etter en endring i config/tournament.json eller dist/crests.js.
\documentclass[10pt]{{extarticle}}
% Ekstra plass øverst (13mm i stedet for 6mm) til hullstans for strips -- se
% \hullmarkering, som viser nøyaktig hvor det er trygt å stanse, uten å treffe
% grønne felt eller tekst.
\usepackage[a4paper,margin=7mm,top=13mm,bottom=6mm]{{geometry}}
\usepackage[table]{{xcolor}}
\usepackage{{array}}
\usepackage{{graphicx}}
\usepackage{{pdflscape}}
\usepackage{{tikz}}
% To tynne sirkler øverst i hver side, midt i margen: her stanses hullene til
% stripsen som fester arket (i plastlomme) til f.eks. et gjerde eller en tavle.
\newcommand{{\hullmarkering}}{{%
\begin{{tikzpicture}}[remember picture,overlay]
\node[draw=gray,line width=.4pt,circle,minimum size=6mm] at ([xshift=16mm,yshift=-10mm]current page.north west) {{}};
\node[draw=gray,line width=.4pt,circle,minimum size=6mm] at ([xshift=-16mm,yshift=-10mm]current page.north east) {{}};
\end{{tikzpicture}}%
}}
\hyphenpenalty=10000\exhyphenpenalty=10000
% Latin Modern Sans (ikke Helvetica -- psnfss' Type1-metrikker mangler i denne
% BasicTeX-installasjonen og lar seg ikke generere uten nett-tilgang til CTAN).
\renewcommand{{\familydefault}}{{\sfdefault}}
\setlength{{\parindent}}{{0pt}}
\pagestyle{{empty}}

% -- Fargene fra selve nettsiden (dist/crests.js), én per lag --
{color_defs}
\definecolor{{konfgreen}}{{HTML}}{{14513F}}
\definecolor{{konfgreendark}}{{HTML}}{{0B2B26}}
\definecolor{{konfgold}}{{HTML}}{{F2C14E}}
\definecolor{{konfcream}}{{HTML}}{{EEF8F1}}

\newcolumntype{{C}}[1]{{>{{\centering\arraybackslash}}p{{#1}}}}
\renewcommand{{\arraystretch}}{{1.6}}
% Bredere kolonnemarg mellom hjemme- og bortelag-cellene: to farger som ligger
% tett inntil hverandre er vanskeligere å skille på avstand enn to som har litt
% luft mellom seg.
\setlength{{\tabcolsep}}{{5mm}}

% Én kamp: bane, hjemmelag (farget, stor skrift), bortelag (farget, stor skrift)
\newcommand{{\kamprad}}[5]{{%
\normalsize Bane~#1 & \cellcolor{{#2}}{{\color{{white}}\bfseries\Large #3}} & \cellcolor{{#4}}{{\color{{white}}\bfseries\Large #5}} \\
}}
% Én sluttspillrad i infolisten: bane, hva kampen gjelder, klokkeslett
\newcommand{{\sluttspillrad}}[3]{{%
\normalsize\bfseries Bane~#1 & \normalsize #2 & \normalsize\bfseries Kl.~#3 \\
}}

% Én rundeblokk: tittel, klokkeslett-undertekst, kamp-tabell.
\newcommand{{\rundeblokk}}[3]{{%
\noindent\colorbox{{konfgreen}}{{%
  \parbox[c][10mm]{{\dimexpr\linewidth-6pt}}{{\color{{white}}\bfseries\Large #1\hfill\color{{konfgold}}\normalsize #2}}%
}}\par
\vspace{{3mm}}
#3
}}

\newlength{{\pagerowsheight}}

\begin{{document}}
\setlength{{\pagerowsheight}}{{\textheight}}
\hullmarkering\par\nointerlineskip

{grid_tex_1}

\newpage
\hullmarkering\par\nointerlineskip

{grid_tex_2}

\newpage
\begin{{landscape}}
\pagestyle{{empty}}
% Ingen \hullmarkering her: pdflscape roterer selve PDF-siden (/Rotate), så TikZs
% "current page"-hjørner ville ikke lenger stemt med det man faktisk ser/printer.
% Den grønne boksen har egen luft til kanten, så et hull kan stanses trygt i hjørnet.
\noindent\colorbox{{konfgreendark}}{{%
\begin{{minipage}}[c][\dimexpr\textheight-2pt][c]{{\dimexpr\linewidth-4pt}}
\centering
\color{{konfcream}}
\vspace{{1cm}}
{{\fontsize{{40}}{{44}}\selectfont\bfseries KonfAction Trøndelag Fotballcup}}\\[10mm]
{{\fontsize{{24}}{{28}}\selectfont {esc(place)} \textbullet\ {esc(date)}}}\\[16mm]
\colorbox{{konfgold}}{{\parbox{{12cm}}{{\centering\color{{konfgreendark}}\bfseries\fontsize{{40}}{{46}}\selectfont\vspace{{5mm}}konfaction.no\vspace{{5mm}}}}}}\\[10mm]
{{\fontsize{{18}}{{22}}\selectfont Følg live resultater, kampoppsett og tabell på nettsiden}}
\vspace{{1cm}}
\end{{minipage}}%
}}
\end{{landscape}}

\newpage
\thispagestyle{{empty}}
\hullmarkering
\null\vfill
\begin{{center}}
\colorbox{{konfgreendark}}{{%
\begin{{minipage}}[c][0.86\textheight][c]{{\dimexpr\textwidth-4pt}}
\centering
\vspace{{1cm}}
\includegraphics[width=7cm]{{krik_logo.png}}\\[16mm]
{{\color{{konfcream}}\fontsize{{30}}{{34}}\selectfont\bfseries KonfAction\\[3mm]Trøndelag Fotballcup}}\\[10mm]
{{\color{{konfgold}}\fontsize{{18}}{{22}}\selectfont\bfseries {esc(place)}, {esc(date)}}}
\vspace{{1cm}}
\end{{minipage}}%
}}
\end{{center}}
\vfill

\end{{document}}
"""

(HERE / "kampoppsett.tex").write_text(TEX, encoding="utf-8")
print("skrevet: print/kampoppsett.tex")
print(f"{len(TEAMS)} lag, {len(matches)} kamper, {len(ROUNDS)} runder (9 seriespill + sluttspill), 5 runder per side over 2 sider")
