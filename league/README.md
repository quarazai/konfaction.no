# Touchline — Local League

## Open locally

Open `dist/index.html` in a modern browser. No installation, build, internet connection, or account is needed.

For a consistent browser storage location, run this from the league folder with Python 3:

```
python3 -m http.server 8080 --bind 127.0.0.1 --directory dist
```

Then open http://127.0.0.1:8080. Stop the server with Ctrl+C.

## Use

- Select a matchday to edit any of the 90 fixtures.
- Enter whole-number scores from 0 to 99. Set the match to Live or Finished to count it in the table. Changing status to Live/Finished initializes missing scores to zero.
- Upcoming scores do not count. A live/finished match with either score cleared is temporarily excluded until both scores are entered.
- Scores save automatically in this browser. Different browsers, devices, addresses, and ports have separate saved data. This is a local score manager, not an external live feed or shared online database.
- The Matches tab provides a wider view of match cards; Table returns to the standings.

## Workbook reference

Imported all 90 fixtures in their original order from `02a-sports-league-table-10-team-blank-1.xlsx`. Each team plays every other team twice, once at home and once away. Consecutive groups of five fixtures form 18 matchdays, each involving all ten teams. Dates were not supplied, so fixtures are marked Date TBC. The supplied Alfa 1–3 Bravo score is retained and interpreted as finished.

Scoring: win 3, draw 1, loss 0. Sorting: points descending, goal difference descending, then original team order (Alfa through Juliett), matching the workbook. Original-order ranking is a stable presentation fallback, not an additional sporting tie-break.

## Files

- `dist/index.html`: page and structure
- `dist/style.css`: responsive styling
- `dist/fixtures.js`: imported starting fixtures and score
- `dist/app.js`: ten original SVG crests, standings calculations, score editor and local saving

All assets are included. No external fonts, images, libraries, trackers or network calls are required. A read-only standings tool is exposed when a browser supports WebMCP.

## Verification

Checked 90 unique directed fixtures, all 18 matchdays, workbook result, original-order ties and live draw calculations. Browser checks covered live score editing, goal-difference ranking, draws, return to upcoming, and persistence after reload. Narrow layout was checked for horizontal page overflow.
