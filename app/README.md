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
- On start, whichever of the two has the newer `savedAt` wins. On the deployed (static) site the same rule
  applies between the published data and the browser copy, so newly published data replaces an older browser copy.

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
by shape id; area, area in UPU and zone overlaps are recalculated in EPSG:3765 (HTRS96/TM, the system the
cadastre publishes in). **Export plots GeoJSON** writes the shapes as currently shown.

The plots are the official cadastral parcels (see below), so a border should normally not be edited – an
edited plot no longer matches the cadastre, and the popup then stops showing the cadastre area.

## Where the map data comes from

**Plots – the official cadastre.** `plots.geojson` holds one shape per official cadastral parcel, exactly
as the State Geodetic Administration (DGU) publishes it – the data behind oss.uredjenazemlja.hr/map:

- source: DGU INSPIRE download service, `https://api.uredjenazemlja.hr/services/inspire/cp/wfs`, layer
  `cp:CadastralParcel` (open, no login). The download is kept untouched, in the official coordinates
  (EPSG:3765, centimetres), in `upu-precko-zapad-map-data/official/cadastre_parcels_EPSG3765.geojson`;
- a parcel is on the map if it is in the ZK workbook or has at least 1 m² inside the UPU boundary;
- parcels are never cut, merged or simplified. The coordinates are only converted to longitude/latitude
  (9 decimals); a unit test checks that every corner converts back to the published coordinate within 1 mm;
- the popup shows the area registered in the cadastre and, below it, the area enclosed by the borders
  (these two differ by a few m² for many parcels – that is how the cadastre is).

To refresh after the cadastre changes (needs Python with `pyproj shapely openpyxl`):

```
cd upu-precko-zapad-map-data
python tools/fetch_cadastre.py     # downloads the parcels again
python tools/build_plots.py        # rebuilds plots.geojson and lists plots without an ownership record
```

**Zones, UPU boundary, roads – the UPU plan.** These come from the plan PDF (map 1), not from the
cadastre. The plan was drawn on the 2009 cadastral lines, which sit 0.375 m east / 0.455 m south of
today's official cadastre (a constant shift, measured on 471 identical parcel corners, spread 1.5 cm);
all plan layers were moved by that amount on 2026-11-11. Zone outlines are the colour fills of the PDF
(placed on the plan's road lines, RMS 0.4 cm); road area = UPU boundary minus all zones;
`road_lines.geojson` are the carriageway / kerb lines (red), road edges, parking stalls and crossings
(white) and centre lines (yellow). `tools/build_plan_layers.py` reproduces all of this.

A plot counts as lying in a zone when the overlap is at least 0.5 m² and wider than 20 cm (hairline
overlaps where a zone border is meant to follow a parcel border are ignored).

**Ownership – the ZK workbook.** Owners, shares and our share come from `061026_ZK DD Prečko.xlsx`
(6 Oct 2026). "Us" = Opatovina group: Opatovina Projekt, Projekt Maksimus, Flammula, Moneris, Matara,
Aequus, Curis, Sigillum, Landmark Group – list in `src/config.ts` → `ourOwners`, compared ignoring case.
Status: 100 % ours → Owned, otherwise Not owned. Records are keyed by plot number. Where the workbook and
the cadastre use different numbers for the same land, the record says so in its Notes:

- `3676/2` – the workbook calls it 3676/1 (same ZK uložak and area);
- `6366/1`, `6366/2` – the workbook's plot 6366, split in the cadastre on 18 Oct 2026;
- `6394/3` – its 281 m² in M1-7 are counted under 6394/1 in the workbook;
- parcels that are not in the workbook show "No data".

Everything from before the switch to the official cadastre (old shapes, old ownership file, the review
assignments and border edits that no longer apply, and a report of what changed) is in
`upu-precko-zapad-map-data/_backup_before_official_cadastre/`.

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
- **Needs review** shapes (the current map has none – every shape is an official parcel) are excluded until
  resolved; each zone shows how much area that is.
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
