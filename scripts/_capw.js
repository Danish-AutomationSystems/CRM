// Drives concurrent WRITES against the real create paths.
// Usage: node scripts/_capw.js [case|customer|mixed] [levels]
const https = require('https');

const HOST = 'crm.automationsystems.info';
const agent = new https.Agent({ keepAlive: false, maxSockets: 100 });

function one(path) {
  return new Promise((resolve) => {
    const t = Date.now();
    const req = https.get({ host: HOST, path, agent, timeout: 50000 }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        let p = null;
        try {
          p = JSON.parse(b);
        } catch {
          p = null;
        }
        resolve({ ms: Date.now() - t, ok: res.statusCode === 200 && p?.ok === true, id: p?.id, err: p?.error, status: res.statusCode });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ms: Date.now() - t, ok: false, err: 'client timeout 50s', status: 0 });
    });
    req.on('error', (e) => resolve({ ms: Date.now() - t, ok: false, err: e.message, status: 0 }));
  });
}

function pct(s, p) {
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function wave(n, mode) {
  const rs = await Promise.all(
    Array.from({ length: n }, (_, i) => {
      const m = mode === 'mixed' ? (i % 3 === 0 ? 'customer' : 'case') : mode;
      // read requests interleaved for the mixed run, matching real usage
      if (mode === 'mixed' && i % 4 === 3) return one(`/api/cap?u=${i}`);
      return one(`/api/capw?u=${i}&mode=${m}`);
    })
  );
  const ok = rs.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const bad = rs.filter((r) => !r.ok);
  const ids = rs.filter((r) => r.ok && r.id).map((r) => r.id);
  const dupes = ids.length - new Set(ids).size;
  console.log(
    `${mode.padEnd(8)} writers=${String(n).padStart(2)}  ok=${String(ok.length).padStart(2)}/${n}  ` +
      `p50=${String(pct(ok, 50)).padStart(5)}ms  p95=${String(pct(ok, 95)).padStart(5)}ms  ` +
      `DUPLICATE_IDS=${dupes}` +
      (bad.length ? `  FAIL: ${[...new Set(bad.map((b) => (b.err || 'http ' + b.status).slice(0, 70)))].join(' | ')}` : '')
  );
}

(async () => {
  const mode = process.argv[2] || 'case';
  const levels = (process.argv[3] || '5,10,20').split(',').map(Number);
  console.log('--- warmup ---');
  await wave(2, mode);
  await new Promise((r) => setTimeout(r, 4000));
  console.log('--- measured waves ---');
  for (const n of levels) {
    await wave(n, mode);
    await new Promise((r) => setTimeout(r, 6000));
  }
})();
