# UPU Prečko-zapad – plot ownership map

React + Vite + TypeScript + MapLibre GL.

```
npm install
npm run dev      # http://localhost:5173  (copies ../upu-precko-zapad-map-data into public/data first)
npm test         # unit tests (percent-owned calculation, shares, import, land-registry refresh)
npm run build    # static build in dist/
```

The site is static except for one server function, `api/oss-parcel.ts`, used by **Refresh ownership**
(see below).

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

**Ownership update of 16 Nov 2026 (OSS).** The eight `*_azurirano.xlsx` workbooks in the repository root
(Kazeta D4, M1-2, M1-4, M1-6, M2-1, M2-3, Ulica 1B, Ulica 3) hold the state per oss.uredjenazemlja.hr on
16 Nov 2026. The records of their 79 plots were updated from them on 17 Nov 2026 (owners, shares, our share,
status, pending registrations, encumbrances); each record's Notes name the source and, where the owners
changed, the owners before. The other kazete/streets still show the 6 Oct 2026 workbook. Details:

- several register parts of one owner are added up (the parts are listed in the Notes);
- `3676/1` now has its own owner; `3676/2` (the land the workbooks count in D4 under "3676/1") was not
  re-checked and still shows the 6 Oct 2026 owner;
- `6366/1` and `6367/1` have no row in the workbooks – their owners come from the remarks on 6366/2 and
  6367/2 (for 6366/1 the shares are not stated, so they are empty);
- the file from before, the script and a report of every change are in
  `upu-precko-zapad-map-data/_backup_before_oss_update/` (`update_ownership_oss.py` can be run again).

Everything from before the switch to the official cadastre (old shapes, old ownership file, the review
assignments and border edits that no longer apply, and a report of what changed) is in
`upu-precko-zapad-map-data/_backup_before_official_cadastre/`.

The dev server refuses a save from a browser tab whose data is older than the file (HTTP 409); the
app then asks you to reload, so an old tab can never overwrite newer data.

## Refresh ownership (land registry)

**Data → Refresh ownership** checks every plot against the land registry and shows what differs from the
stored data. Nothing is saved until you confirm.

**What it reads.** Two public services of oss.uredjenazemlja.hr, per plot:

1. `…/oss/public/cad/parcel-info?parcelId=…` – the cadastre's record of the parcel; only the plot number,
   the municipality code, the area and the link to the land-registry unit (ZK uložak) are used;
2. `…/oss/public/lr/lr-unit?lrUnitNumber=…&mainBookId=…` – that unit; the owners are taken from ownership
   sheet B, the pending registrations (plombe) from `activePlumbs`.

The owners are always the land registry's (sheet B). The possessors the cadastre lists are never read.
The parcel id is `oss_parcel_id` in `plots.geojson` – the number in the DGU feature id (`CP.41106113`),
written by `tools/build_plots.py`.

**How it runs.** The browser asks `/api/oss-parcel?parcelId=…` for one plot after another, with a pause of
1.5 s between two plots (`refreshPauseMs` in `src/config.ts`) – about 7 minutes for 189 plots. A plot that
fails is noted and the run goes on; **Cancel** stops it and shows what was checked so far. At the end a list
opens:

- **Changed** – the differences in words, one tick box per plot. Only ticked plots are changed: owners, our
  share and status are replaced; notes and contact are never touched. The plots in `protectedPlots`
  (`src/config.ts`: 6390, 3676/2, 6366/1, 6367/1, 6394/3 – set by hand on purpose) are shown as
  "edited by hand" and are not ticked.
- **Needs a look** – no change is proposed, the reason is given: no land-registry unit, condominium ownership
  (etažno vlasništvo), sub-shares or a pre-registration (predbilježba), a share without a fraction or without
  an owner, shares that do not add up to 1, a share held jointly by one of our companies and somebody else,
  or the registry answering with another plot number or municipality than the map has (split or renumbered
  parcel). These plots are left exactly as they are.
- **Failed** – with **Retry failed**.
- **Unchanged** – a count. For these only the registry note is stored.

Every plot that is updated or found unchanged gets a registry note in its record (`registry`: parcel id,
ZK uložak, main book, last Z number, pending registrations, date of the check). The popup shows it under
"Land registry", with a yellow chip when a registration was pending. Records that were never checked have no
such note; the file format is still version 1.

**Rules.**

- One owner row per share entry of sheet B; several persons in one entry become one row ("A, B"). Rows of the
  same owner are added up exactly – the same owner means the same OIB where the registry gives one, otherwise
  the same name.
- Names are compared without regard to case, spaces and additions such as "(predbilježba)" or ", OIB: …";
  shares as exact fractions. The spelling already in the data is kept for an owner who stays.
- **Ours** = the OIB is in `ourOwnerOibs` **or** the name is in `ourOwners` (both in `src/config.ts`). If a
  name matches but its OIB is not in the list, the list at the end says so – add the OIB to `ourOwnerOibs`.
- **Our share** = the sum of our companies' shares. **Status**: our share is 1 → Owned; otherwise Not owned,
  except that a Negotiating set by hand stays Negotiating.
- OIBs are used for comparing only. No OIB is stored with an owner.

**Saving and publishing** work as for every other edit: on the deployed site the result is saved in that
browser only. To publish it: **Export JSON**, replace `data/ownership.json` with the file, commit and push.

### The service behind it: `/api/oss-parcel`

The browser cannot call OSS directly, so a small server function does: `api/oss-parcel.ts` on Vercel, and the
same handler inside the dev server (`npm run dev`, `npm run preview`). The logic is in `server/ossParcel.ts`.

- `GET /api/oss-parcel?parcelId=<number>` with header `X-Refresh-Token`.
- **`REFRESH_TOKEN`** (environment variable) is the secret the header must equal. Not set → the service
  answers 503 and the refresh is switched off; wrong or missing token → 401. The app asks for the token on
  first use and keeps it in that browser's localStorage; after a 401 it asks again.
  - Vercel: Project → Settings → Environment Variables → add `REFRESH_TOKEN` (any long random text), then
    redeploy. The function needs the project's Root Directory to be `app` (Settings → Build and Deployment →
    Root Directory).
  - Locally: put `REFRESH_TOKEN=…` in `app/.env.local` (not committed) or set it in the shell.
- Only parcels on the map are accepted (403 otherwise). The list is `server/parcelAllowlist.generated.ts`,
  written by `scripts/sync-data.mjs` on every `npm run dev` / `npm run build` and also committed; a unit test
  fails if it does not match `plots.geojson`.
- Each call to OSS may take 15 s and is repeated up to 3 times (after 0.5, 1 and 2 s) on a network error or
  a 5xx answer; the whole request gives up after 25 s (the function is limited to 30 s). OSS failing gives
  502, not answering in time 504.
- Answers are sent with `Cache-Control: no-store`. Nothing from an answer is logged – on a failure only the
  parcel id, the step and the HTTP status.

After the cadastre changes (`tools/fetch_cadastre.py`, `tools/build_plots.py`) the parcel ids are refreshed
with the plots; run `npm run sync-data` and commit `server/parcelAllowlist.generated.ts` with them.

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
