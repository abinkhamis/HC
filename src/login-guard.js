// Slows down password guessing: after repeated failed sign-ins the name is locked for a while.
// Two limits: per (address + name) — the usual case — and per name from anywhere, higher so a
// stranger cannot easily lock a real user out. Kept in memory (one server process).
const WINDOW_MS = 15 * 60 * 1000;
export const LIMITS = { perAddress: 5, perName: 20 };

export function createLoginGuard({ now = () => Date.now() } = {}) {
  const fails = new Map(); // key -> [timestamps]
  const recent = (key) => (fails.get(key) || []).filter((t) => now() - t < WINDOW_MS);
  const keys = (ip, name) => [`a:${ip}|${name}`, `n:${name}`];

  return {
    // minutes left when locked, 0 otherwise
    lockedFor(ip, name) {
      const [a, n] = keys(ip, name);
      const ra = recent(a), rn = recent(n);
      const hit = ra.length >= LIMITS.perAddress ? ra : rn.length >= LIMITS.perName ? rn : null;
      if (!hit) return 0;
      return Math.max(1, Math.ceil((hit[0] + WINDOW_MS - now()) / 60000));
    },
    failed(ip, name) { for (const k of keys(ip, name)) fails.set(k, [...recent(k), now()]); },
    succeeded(ip, name) { fails.delete(keys(ip, name)[0]); },
  };
}

// The visitor's address. Behind a hosting proxy (Railway, a load balancer) the first
// X-Forwarded-For entry is the visitor; on this computer it is the socket address.
export function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || 'unknown';
}

export const isHttps = (req) => req.socket?.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
