import { defineConfig } from 'vitest/config';
import type { Connect, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
// UPU_OWNERSHIP_FILE lets automated tests use a throwaway copy instead of the real data
const OWNERSHIP_FILE = process.env.UPU_OWNERSHIP_FILE
  ? path.resolve(process.env.UPU_OWNERSHIP_FILE)
  : path.join(root, 'data', 'ownership.json');
const EMPTY_DOC = { version: 1, savedAt: null, plots: {}, reviews: {}, edits: {} };

/**
 * Tiny local API so edits made in the browser are written to data/ownership.json
 * (a file in the repo). GET returns the file, PUT replaces it. The previous version
 * is kept as data/ownership.backup.json. Only active under `vite` / `vite preview`.
 */
function ownershipFileApi(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url || !req.url.startsWith('/api/ownership')) return next();
    const send = (code: number, body: string) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(body);
    };
    (async () => {
      if (req.method === 'GET') {
        const txt = await fs.readFile(OWNERSHIP_FILE, 'utf8').catch(() => null);
        return send(200, txt ?? JSON.stringify(EMPTY_DOC));
      }
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        let doc: unknown;
        try {
          doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(400, '{"error":"invalid JSON"}');
        }
        const d = doc as { version?: unknown; plots?: unknown; reviews?: unknown };
        if (d.version !== 1 || typeof d.plots !== 'object' || typeof d.reviews !== 'object') {
          return send(400, '{"error":"not an ownership document"}');
        }
        // Refuse to overwrite a file that changed since this client loaded it
        // (another tab, an import or a script) – the client must reload first.
        const base = req.headers['x-base-saved-at'];
        if (typeof base === 'string') {
          const current = await fs.readFile(OWNERSHIP_FILE, 'utf8').then((t) => JSON.parse(t).savedAt ?? null).catch(() => null);
          if ((current ?? '') !== base) return send(409, JSON.stringify({ error: 'conflict', fileSavedAt: current }));
        }
        await fs.mkdir(path.dirname(OWNERSHIP_FILE), { recursive: true });
        await fs.copyFile(OWNERSHIP_FILE, OWNERSHIP_FILE.replace(/\.json$/, '.backup.json')).catch(() => undefined);
        const tmp = OWNERSHIP_FILE + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
        await fs.rename(tmp, OWNERSHIP_FILE);
        return send(200, '{"ok":true}');
      }
      return send(405, '{"error":"method not allowed"}');
    })().catch((e) => send(500, JSON.stringify({ error: String(e) })));
  };
  return {
    name: 'ownership-file-api',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), ownershipFileApi()],
  test: { environment: 'node' },
});
