# UPU Prečko-zapad – plot ownership map

Interactive map of plot ownership in the UPU (urban development plan) Prečko-zapad area, Zagreb.

- `app/` – the web app (React + Vite + TypeScript + MapLibre). See [app/README.md](app/README.md).
- `upu-precko-zapad-map-data/` – map data as WGS84 GeoJSON: plots (the official cadastral parcels, exactly as
  published by DGU), zones / roads / UPU boundary (from the UPU plan PDF), the untouched cadastre download in
  `official/`, the scripts that build the data in `tools/`, and backups of earlier data versions.
- `061026_ZK DD Prečko.xlsx` – land-registry (ZK) extract the ownership data was imported from.

## Run

```
cd app
npm install
npm run dev     # http://localhost:5173
npm test
```

Ownership data entered in the app is saved to `app/data/ownership.json`.
