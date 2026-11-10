/**
 * Password gate for the deployed app (Vercel Routing Middleware – runs on the server before every request,
 * so the page AND the data files are protected). Not used by `npm run dev`.
 *
 * The password itself is not stored here – only a salted PBKDF2 hash of it. The session cookie is
 * HMAC(password, "upu-session-v1"); only its SHA-256 is stored, so a cookie cannot be forged from this file.
 * To change the password, regenerate the three constants (see README) – old sessions stop working.
 */
const SECRETS = {
  SALT: 'bc293aab3255cb607100a6d0669ab1fc',
  ITER: 30000,
  PW_HASH: 'b0a0e975a8d0a0ea48629a5943fd97703d7f5608976f137e004d8a0a63b9f49b',
  SESSION_HASH: '5ecf399b05de10802048c44c87990a7a3f126273698de98f1e56c7945ee64335',
};

const COOKIE = 'upu_session';
const LOGIN_PATH = '/__login';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export const config = { matcher: '/:path*' };

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function passwordOk(pw, s) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(s.SALT), iterations: s.ITER }, key, 256);
  return sameText(hex(bits), s.PW_HASH);
}

async function sessionFor(pw) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw.normalize('NFC')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode('upu-session-v1')));
}

async function sessionOk(token, s) {
  if (!/^[0-9a-f]{64}$/.test(token)) return false;
  return sameText(hex(await crypto.subtle.digest('SHA-256', fromHex(token))), s.SESSION_HASH);
}

/** Hashes for a password (used by the tests with a throwaway password, and to change the password). */
export async function makeSecrets(pw, iterations = 30000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  const session = await crypto.subtle.digest('SHA-256', fromHex(await sessionFor(pw)));
  return { SALT: hex(salt), ITER: iterations, PW_HASH: hex(bits), SESSION_HASH: hex(session) };
}

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function loginPage(next, failed) {
  const html = `<!doctype html>
<html lang="hr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>UPU Prečko-zapad</title>
<style>
  html,body{margin:0;height:100%;background:#000;color:#ddd;font:15px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  body{display:grid;place-items:center}
  form{display:grid;gap:10px;width:min(320px,calc(100vw - 32px))}
  input{background:#0b0b0b;border:1px solid #333;border-radius:10px;color:#fff;padding:12px 14px;font:inherit;outline:none;text-align:center;letter-spacing:.05em}
  input:focus{border-color:#8b5cf6}
  input.bad{border-color:#ef4444;animation:shake .3s}
  p{margin:0;min-height:1.2em;text-align:center;color:#ef4444;font-size:13px}
  @keyframes shake{25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}
</style></head>
<body><form method="post" action="${LOGIN_PATH}" accept-charset="utf-8" autocomplete="on">
  <input type="hidden" name="next" value="${esc(next)}">
  <input type="password" name="password" placeholder="Password" aria-label="Password" autofocus required${failed ? ' class="bad"' : ''}>
  <p>${failed ? 'Incorrect password' : ''}</p>
</form></body></html>`;
  return new Response(html, {
    status: 401,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
}

export default function middleware(request) {
  return gate(request, SECRETS);
}

export async function gate(request, s) {
  const url = new URL(request.url);

  if (url.pathname === LOGIN_PATH && request.method === 'POST') {
    const form = await request.formData();
    const pw = String(form.get('password') || '');
    const next = safeNext(String(form.get('next') || '/'));
    if (pw && (await passwordOk(pw, s))) {
      return new Response(null, {
        status: 303,
        headers: {
          location: next,
          'set-cookie': `${COOKIE}=${await sessionFor(pw)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
          'cache-control': 'no-store',
        },
      });
    }
    return loginPage(next, true);
  }

  if (await sessionOk(readCookie(request, COOKIE), s)) return; // signed in: continue to the app / file

  return loginPage(url.pathname === LOGIN_PATH ? '/' : url.pathname + url.search, false);
}
