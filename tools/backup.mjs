// Weekly backup onto this computer (run by Windows Task Scheduler, or by hand).
// Usage: node tools/backup.mjs <config.json>
// config: { "folder": "C:/Users/<me>/Documents/HC-Backups", "keep": 12, "targets": [
//   { "name": "local", "type": "local", "db": ".../data/hub.db", "storage": ".../storage" },
//   { "name": "online", "type": "url", "url": "https://...", "keyFile": "online.key" } ] }
// Each run writes <folder>/<name>/HC-backup-<date>.zip, keeps the newest <keep> files, and logs to <folder>/backup.log.
import fs from 'node:fs';
import path from 'node:path';
import { buildBackup } from '../src/backup.js';

const cfgPath = process.argv[2];
if (!cfgPath) { console.error('usage: node tools/backup.mjs <config.json>'); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const folder = cfg.folder || path.dirname(cfgPath);
const keep = Number(cfg.keep) || 12;
const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Riyadh' }).slice(0, 16).replace(/[: ]/g, '-');
const log = (msg) => { const line = `${new Date().toISOString()}  ${msg}\n`; fs.appendFileSync(path.join(folder, 'backup.log'), line); process.stdout.write(line); };

let failed = 0;
for (const t of cfg.targets || []) {
  const dir = path.join(folder, t.name);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `HC-backup-${stamp}.zip`);
  try {
    let zip;
    if (t.type === 'local') {
      if (!fs.existsSync(t.db)) throw new Error(`database not found: ${t.db}`);
      zip = buildBackup(t.db, t.storage).zip;
    } else if (t.type === 'url') {
      const keyFile = path.isAbsolute(t.keyFile) ? t.keyFile : path.join(folder, t.keyFile);
      if (!fs.existsSync(keyFile)) { log(`${t.name}: skipped — no backup key yet (${path.basename(keyFile)})`); continue; }
      const key = fs.readFileSync(keyFile, 'utf8').trim();
      const r = await fetch(new URL('/api/backup', t.url), { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`server answered ${r.status}`);
      zip = Buffer.from(await r.arrayBuffer());
      if (zip.subarray(0, 2).toString() !== 'PK') throw new Error('not a backup file');
    } else throw new Error(`unknown type ${t.type}`);
    fs.writeFileSync(out, zip);
    const old = fs.readdirSync(dir).filter((f) => /^HC-backup-.*\.zip$/.test(f)).sort().reverse().slice(keep);
    for (const f of old) fs.rmSync(path.join(dir, f));
    log(`${t.name}: saved ${path.basename(out)} (${Math.round(zip.length / 1024)} KB)${old.length ? `, removed ${old.length} older` : ''}`);
  } catch (e) {
    failed++;
    log(`${t.name}: FAILED — ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
