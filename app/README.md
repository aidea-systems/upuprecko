# UPU Prečko-zapad – plot ownership map

React + Vite + TypeScript + MapLibre GL.

```
npm install
npm run dev      # http://localhost:5173  (copies ../upu-precko-zapad-map-data into public/data first)
npm test         # unit tests (percent-owned calculation, shares, import)
npm run build    # static build in dist/
```

## Where the ownership data lives

- **`data/ownership.json`** – the file in the repo. While `npm run dev` (or `npm run preview`)
  is running, every save in the app writes this file; the previous version is kept as
  `data/ownership.backup.json`. Commit `ownership.json` to keep history.
- **localStorage** – a copy in the browser. If the app is opened without the dev server
  (static `dist/` hosting) it saves only here – the panel then says
  "Saved in this browser only". Use **Export JSON** and replace `data/ownership.json` with it.
- On start, whichever of the two has the newer `savedAt` wins.

Storage is behind `src/storage/repository.ts` (`OwnershipRepository`). To move to a database,
write another class implementing that interface and pass it in `App.tsx` instead of
`LocalJsonRepository` – the UI does not change.

## Editing plot numbers and borders

Open a plot → **Edit**:
- **Plot number** – the ownership data moves with the number. If the new number is already used by
  another shape, the two shapes become one plot; if both numbers already have ownership data the
  change is refused (nothing is overwritten). "Reset to original number" undoes it.
- **Configure borders on map** – drag corners, click ＋ to add a corner, right-click to delete one,
  Ctrl+Z to undo. Corners snap to nearby corners (hold Alt to stop). With "Move shared corners with
  neighbours" on, neighbouring shapes that share the corner move too, so no gaps or overlaps appear.
  A border that crosses itself cannot be saved.

The source GeoJSON is never changed. Edits are stored in `data/ownership.json` under `edits`, keyed
by shape id; area, area in UPU and zone overlaps are recalculated in EPSG:3907 with the same datum
transformation pyproj used for the source data (unit test checks all 120 shapes match within 1 m²).
**Export plots GeoJSON** writes the shapes as currently shown.

## Roads

`roads.geojson`, `road_lines.geojson` and `road_labels.geojson` are taken from the UPU PDF
(map 1, georeferenced on the cadastral lines, 4 cm RMS): the road area (UPU boundary minus all
zones), the carriageway / kerb lines (red), road edges, parking stalls and crossings (white),
centre lines (yellow) and the street names. Toggle with "Roads (UPU plan)".

## Where the plot shapes and ownership came from

`plots.geojson` started as the 2009 UPU cadastral shapes. On 2026-11-10 they were split along the
zone and road borders into today's plot numbers from `061026_ZK DD Prečko.xlsx`, and the owners,
shares and our share were taken from that workbook ("us" = Opatovina group: Opatovina Projekt,
Projekt Maksimus, Flammula, Moneris, Matara, Aequus, Curis, Sigillum, Landmark Group – list in
`src/config.ts` → `ourOwners`, compared ignoring case). The original shapes and the
full decision log are in `upu-precko-zapad-map-data/_backup_before_excel_import/`.

- Shapes labelled `XXXX (2009)` are parts of old plots outside the UPU boundary that the workbook does
  not cover.
- A plot number like `5562/12 + 5562/18 + …` is one map piece holding several current plots that the
  old geometry cannot separate; its shares are weighted by each plot's area (see its Notes).
- Pieces with id `ZK-…` are "needs review": no workbook plot matches them.

The dev server refuses a save from a browser tab whose data is older than the file (HTTP 409); the
app then asks you to reload, so an old tab can never overwrite newer data.

## Testing without touching real data

`UPU_OWNERSHIP_FILE=/path/to/copy.json npx vite --port 5174` runs a second server that reads and
writes a copy instead of `data/ownership.json`. Use that for any automated UI test.

## Settings and translation

- `src/config.ts` – status colours, zone thresholds (green ≥ 80 %, yellow ≥ 40 %), land-use
  colours from the plan PDF, basemaps, and `geometryShiftMeters` (x/y shift in metres, currently 0).
- `src/i18n/strings.ts` – every visible string. Copy, translate, set `locale: 'hr-HR'`.

## How percent owned is calculated (`src/lib/zoneStats.ts`)

- By area: Σ(overlap_m2 × our share) / Σ overlap_m2 over the plots in the zone.
- By count: Σ(our share) / number of plots (a half-owned plot counts 0.5).
- A plot crossing two zones counts in each with its `overlap_m2`.
- "Our share" is the value entered on the plot. If it is empty and the status is *Owned*,
  100 % is used (the popup says so); otherwise 0.
- **Needs review** shapes are excluded until resolved; each zone shows how much area that is.
  Assigned to a plot number → counted as that plot. Marked "not a plot (road)" → left out.

## Import (Excel / CSV / JSON)

Columns (English or Croatian headers, case-insensitive):
`plot number` (`broj čestice`), `status`, `owners` (`vlasnici`), `shares` (`udjeli`), `notes`
(`napomena`), optional `our share` (`naš udio`) and `contact` (`kontakt`).

- Several owners in one cell: separate with `;` or `|` (use `|` in semicolon-separated CSV files),
  shares in the same order: `1/2 | 1/2`.
- Status: owned / negotiating / not owned / no data (Croatian: naše, u pregovorima, nije u vlasništvu, nema podataka).
- Before anything is changed the app shows a report: plot numbers that are not on the map,
  rows with errors (skipped) and owner shares that do not add up to 1.
- In Excel, format the plot-number and share columns as **Text**, otherwise Excel may turn
  `1/2` into a date. Export Excel already writes them as text.
- A JSON file (from Export JSON) replaces all data after confirmation.
