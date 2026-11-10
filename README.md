# UPU Prečko-zapad – plot ownership map

Interactive map of plot ownership in the UPU (urban development plan) Prečko-zapad area, Zagreb.

- `app/` – the web app (React + Vite + TypeScript + MapLibre). See [app/README.md](app/README.md).
- `upu-precko-zapad-map-data/` – map data (plots, zones, roads, UPU boundary as WGS84 GeoJSON),
  the UPU plan PDF, and backups of earlier data versions.
- `061026_ZK DD Prečko.xlsx` – land-registry (ZK) extract the ownership data was imported from.

## Run

```
cd app
npm install
npm run dev     # http://localhost:5173
npm test
```

Ownership data entered in the app is saved to `app/data/ownership.json`.
