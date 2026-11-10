import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error – plain JS module used by Vercel
import middleware, { gate, makeSecrets } from '../middleware.js';

// A throwaway password – the real one is never written in the code or the tests.
const PW = 'Test-Žaba-ČČ-42!';
const site = 'https://upuprecko.vercel.app';
const form = (fields: Record<string, string>) =>
  new Request(`${site}/__login`, { method: 'POST', body: new URLSearchParams(fields) });
let secrets: Record<string, unknown>;
const run = (r: Request) => gate(r, secrets);

describe('password gate', () => {
  beforeAll(async () => {
    secrets = await makeSecrets(PW, 1000);
  });

  it('the deployed gate blocks requests without a session', async () => {
    const r: Response = await middleware(new Request(site + '/data/ownership.seed.json'));
    expect(r.status).toBe(401);
  });

  it('shows only the password screen without a session, for pages and data files', async () => {
    for (const path of ['/', '/data/ownership.seed.json', '/data/plots.geojson', '/assets/index.js']) {
      const r: Response = await run(new Request(site + path));
      expect(r.status, path).toBe(401);
      const html = await r.text();
      expect(html).toContain('type="password"');
      expect(html).not.toMatch(/FeatureCollection|"plots"|"owners"/); // no data, only the form
    }
  });

  it('rejects a wrong password', async () => {
    const r: Response = await run(form({ password: PW.toLowerCase(), next: '/' }));
    expect(r.status).toBe(401);
    expect(await r.text()).toContain('Incorrect password');
  });

  it('accepts the right password, sets a session cookie and lets that session through', async () => {
    const r: Response = await run(form({ password: PW, next: '/data/plots.geojson' }));
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/data/plots.geojson');
    const cookie = r.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^upu_session=[0-9a-f]{64}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
    const pass = await run(new Request(site + '/data/plots.geojson', { headers: { cookie: cookie.split(';')[0] } }));
    expect(pass).toBeUndefined();
  });

  it('accepts the password typed with decomposed accents (č, ž)', async () => {
    const r: Response = await run(form({ password: PW.normalize('NFD'), next: '/' }));
    expect(r.status).toBe(303);
  });

  it('rejects a forged cookie and does not redirect to other sites', async () => {
    const forged: Response = await run(new Request(site + '/', { headers: { cookie: 'upu_session=' + 'a'.repeat(64) } }));
    expect(forged.status).toBe(401);
    const r: Response = await run(form({ password: PW, next: '//evil.example' }));
    expect(r.headers.get('location')).toBe('/');
  });
});
