import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.SIMILARWEB_DASHBOARD_PORT || 4123);
const dataDir = join(__dirname, 'data');
const scraperPath = join(__dirname, 'similarweb-scraper.mjs');
const jobs = new Map();
let activeJob = null;

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function normalizeTarget(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) throw new Error('Please enter a Similarweb report URL or a domain.');

  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.replace(/^www\./i, '');
    if (host !== 'similarweb.com') throw new Error('Please use a Similarweb report URL or enter a domain.');
    return parsed.toString();
  }

  const domain = trimmed.replace(/^www\./i, '').replace(/\/.*$/, '').toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    throw new Error('Please enter a valid domain, for example hamariweb.com.');
  }

  return `https://www.similarweb.com/website/${domain}/`;
}

function snapshot(job) {
  return {
    id: job.id,
    url: job.url,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    error: job.error,
    logs: job.logs.slice(-300),
    result: job.result,
  };
}

async function latestReports(limit = 20) {
  await mkdir(dataDir, { recursive: true });
  const files = await readdir(dataDir).catch(() => []);
  const reports = await Promise.all(
    files
      .filter((file) => /^similarweb_.+\.json$/i.test(file))
      .map(async (file) => {
        try {
          const jsonPath = join(dataDir, file);
          const [raw, info] = await Promise.all([readFile(jsonPath, 'utf8'), stat(jsonPath)]);
          const data = JSON.parse(raw);
          const base = file.slice(0, -5);
          const downloads = {};

          for (const extension of ['json', 'csv', 'html', 'txt']) {
            const artifact = join(dataDir, `${base}.${extension}`);
            try {
              await stat(artifact);
              downloads[extension] = `/download/${encodeURIComponent(`${base}.${extension}`)}`;
            } catch {}
          }

          return { file, base, modifiedAt: info.mtime.toISOString(), data, downloads };
        } catch {
          return null;
        }
      })
  );

  return reports
    .filter(Boolean)
    .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt))
    .slice(0, limit);
}

async function runScraper(input) {
  if (activeJob?.status === 'running') {
    throw new Error('A scrape is already running. Please wait for it to finish.');
  }

  const url = normalizeTarget(input);
  const id = Date.now().toString(36);
  const job = {
    id,
    url,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    error: null,
    logs: [],
    result: null,
  };

  jobs.set(id, job);
  activeJob = job;

  const child = spawn(process.execPath, [scraperPath, url], {
    cwd: __dirname,
    env: process.env,
    shell: false,
    windowsHide: false,
  });

  const pushLog = (chunk, stream) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) job.logs.push({ at: new Date().toISOString(), stream, line });
    }
  };

  child.stdout.on('data', (chunk) => pushLog(chunk, 'stdout'));
  child.stderr.on('data', (chunk) => pushLog(chunk, 'stderr'));
  child.on('error', (error) => {
    job.status = 'failed';
    job.error = error.message;
    job.finishedAt = new Date().toISOString();
    if (activeJob?.id === job.id) activeJob = null;
  });
  child.on('close', async (code) => {
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    job.status = code === 0 ? 'completed' : 'failed';
    if (code !== 0 && !job.error) job.error = `Scraper exited with code ${code}.`;
    const reports = await latestReports(1);
    job.result = reports[0] || null;
    if (activeJob?.id === job.id) activeJob = null;
  });

  return snapshot(job);
}

function pageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Similarweb Scraper Dashboard</title>
<style>
:root{color-scheme:dark;--bg:#060812;--card:rgba(255,255,255,.08);--card-strong:rgba(255,255,255,.13);--text:#f8f9ff;--muted:#aab2ca;--brand:#8b5cf6;--brand2:#06b6d4;--ok:#22c55e;--bad:#fb7185;--line:rgba(255,255,255,.15);--shadow:0 26px 90px rgba(0,0,0,.42)}*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;background:radial-gradient(circle at 15% 9%,rgba(139,92,246,.34),transparent 32%),radial-gradient(circle at 84% 0,rgba(6,182,212,.28),transparent 30%),linear-gradient(135deg,#060812 0%,#11162a 58%,#070915 100%);color:var(--text)}.shell{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:32px 0 48px}.hero{display:grid;grid-template-columns:1.22fr .78fr;gap:22px}.panel{background:linear-gradient(145deg,rgba(255,255,255,.12),rgba(255,255,255,.06));border:1px solid var(--line);box-shadow:var(--shadow);border-radius:30px;backdrop-filter:blur(18px)}.intro{padding:34px}.eyebrow{display:inline-flex;gap:9px;align-items:center;border:1px solid rgba(255,255,255,.17);background:rgba(255,255,255,.075);border-radius:999px;padding:8px 12px;color:#dce2ff;font-size:13px;font-weight:800}.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 22px var(--ok)}h1{font-size:clamp(34px,6vw,66px);line-height:.95;margin:22px 0 16px;letter-spacing:-.055em}.lead{font-size:18px;color:var(--muted);line-height:1.7;max-width:700px}.form{display:flex;gap:12px;margin-top:28px}.input{flex:1;min-width:0;border:1px solid var(--line);border-radius:18px;background:rgba(6,8,18,.72);color:var(--text);font-size:16px;padding:16px 18px;outline:none}.input:focus{border-color:rgba(139,92,246,.82);box-shadow:0 0 0 4px rgba(139,92,246,.16)}.btn{border:0;border-radius:18px;padding:0 22px;font-weight:900;color:white;background:linear-gradient(135deg,var(--brand),var(--brand2));cursor:pointer;box-shadow:0 14px 42px rgba(91,121,246,.3)}.btn:disabled{opacity:.55;cursor:not-allowed}.status{padding:28px;display:grid;gap:18px}.status-card{padding:18px;border-radius:22px;background:rgba(0,0,0,.17);border:1px solid var(--line)}.label{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);font-weight:900}.status-value{font-size:26px;font-weight:950;margin-top:8px;word-break:break-word}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:22px 0}.metric{padding:22px;border-radius:24px;background:var(--card);border:1px solid var(--line)}.metric strong{display:block;font-size:28px;margin-top:10px;letter-spacing:-.03em}.metric span{color:var(--muted);font-size:13px}.content{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:20px}.section{padding:24px}.section h2{margin:0 0 16px;font-size:22px}.log{height:360px;overflow:auto;background:#050711;border:1px solid var(--line);border-radius:20px;padding:16px;font:13px/1.6 Consolas,ui-monospace,monospace;color:#dbe6ff}.log .err{color:#ff9fb0}.report{display:flex;justify-content:space-between;gap:14px;padding:16px;border:1px solid var(--line);background:rgba(255,255,255,.06);border-radius:20px;margin-bottom:12px}.report h3{margin:0;font-size:17px}.report p{margin:6px 0 0;color:var(--muted);font-size:13px}.links{display:flex;flex-wrap:wrap;gap:8px;align-content:flex-start;justify-content:flex-end}.links a{color:#eff6ff;text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:8px 10px;background:rgba(255,255,255,.075);font-size:12px;font-weight:900}.pill{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:8px 12px;background:rgba(34,197,94,.13);color:#bbf7d0;font-weight:900}.failed{background:rgba(251,113,133,.13);color:#fecdd3}.empty{color:var(--muted);padding:24px;border:1px dashed var(--line);border-radius:20px;text-align:center}@media(max-width:900px){.hero,.content{grid-template-columns:1fr}.grid{grid-template-columns:repeat(2,1fr)}.form{flex-direction:column}.btn{height:54px}}@media(max-width:560px){.grid{grid-template-columns:1fr}.shell{width:min(100% - 20px,1180px);padding-top:18px}.intro,.status,.section{padding:18px}}
</style>
</head>
<body>
<main class="shell">
  <section class="hero">
    <div class="panel intro">
      <div class="eyebrow"><span class="dot"></span> Local Similarweb scraper control room</div>
      <h1>Beautiful reports without touching your scraper.</h1>
      <p class="lead">Run the existing Similarweb script, watch live output, review extracted metrics, and download every generated JSON, CSV, HTML, and text artifact from one local dashboard.</p>
      <form class="form" id="scrapeForm">
        <input class="input" id="target" placeholder="hamariweb.com or https://www.similarweb.com/website/example.com/" value="hamariweb.com" autocomplete="off">
        <button class="btn" id="runBtn" type="submit">Run Scrape</button>
      </form>
    </div>
    <aside class="panel status">
      <div class="status-card"><div class="label">Current Status</div><div class="status-value" id="statusText">Ready</div></div>
      <div class="status-card"><div class="label">Last Target</div><div class="status-value" id="lastTarget">None yet</div></div>
      <div id="statusPill" class="pill">Idle</div>
    </aside>
  </section>
  <section class="grid" id="metrics"></section>
  <section class="content">
    <div class="panel section"><h2>Live Output</h2><div class="log" id="logs">Waiting for a run...</div></div>
    <div class="panel section"><h2>Report History</h2><div id="reports"></div></div>
  </section>
</main>
<script>
const state = { running: false };
const metrics = document.getElementById('metrics');
const logs = document.getElementById('logs');
const reports = document.getElementById('reports');
const runBtn = document.getElementById('runBtn');
const statusText = document.getElementById('statusText');
const lastTarget = document.getElementById('lastTarget');
const statusPill = document.getElementById('statusPill');
const fmt = (value) => value === null || value === undefined || value === '' ? 'N/A' : new Intl.NumberFormat().format(value);
const escapeHtml = (value) => String(value).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
function setStatus(text, kind) { statusText.textContent = text; statusPill.textContent = text; statusPill.className = 'pill ' + (kind === 'bad' ? 'failed' : ''); }
function renderMetrics(report) { const data = report && report.data; const cards = [ ['Global Rank', data && data.rankings && data.rankings.global ? '#' + fmt(data.rankings.global) : 'N/A'], ['Country Rank', data && data.rankings && data.rankings.country ? '#' + fmt(data.rankings.country) : 'N/A', data && data.rankings && data.rankings.countryName], ['Bounce Rate', data && data.engagement && data.engagement.bounceRate || 'N/A'], ['Pages / Visit', data && data.engagement && data.engagement.pagesPerVisit != null ? data.engagement.pagesPerVisit : 'N/A'], ['Visit Duration', data && data.engagement && data.engagement.averageVisitDuration || 'N/A'], ['Traffic Change', data && data.engagement && data.engagement.lastMonthTrafficChange || 'N/A'], ['Category Rank', data && data.rankings && data.rankings.category ? '#' + fmt(data.rankings.category) : 'N/A', data && data.rankings && data.rankings.categoryName], ['Period', data && data.period || 'N/A'] ]; metrics.innerHTML = cards.map(([label, value, note]) => '<article class="metric"><span>' + label + '</span><strong>' + value + '</strong>' + (note ? '<span>' + note + '</span>' : '') + '</article>').join(''); }
function renderLogs(job) { if (!job || !job.logs || !job.logs.length) { logs.textContent = state.running ? 'Scraper started. Waiting for output...' : 'Waiting for a run...'; return; } logs.innerHTML = job.logs.map((entry) => '<div class="' + (entry.stream === 'stderr' ? 'err' : '') + '">[' + new Date(entry.at).toLocaleTimeString() + '] ' + escapeHtml(entry.line) + '</div>').join(''); logs.scrollTop = logs.scrollHeight; }
function renderReports(items) { if (!items.length) { reports.innerHTML = '<div class="empty">No Similarweb reports yet.</div>'; return; } reports.innerHTML = items.map((item) => { const d = item.data || {}; const links = Object.entries(item.downloads || {}).map(([kind, href]) => '<a href="' + href + '">' + kind.toUpperCase() + '</a>').join(''); const rank = d.rankings && d.rankings.global ? '#' + fmt(d.rankings.global) : 'N/A'; const bounce = d.engagement && d.engagement.bounceRate || 'N/A'; return '<article class="report"><div><h3>' + escapeHtml(d.domain || item.base) + '</h3><p>' + escapeHtml(d.period || 'Unknown period') + ' · ' + new Date(item.modifiedAt).toLocaleString() + '</p><p>Global ' + rank + ' · Bounce ' + bounce + '</p></div><div class="links">' + links + '</div></article>'; }).join(''); }
async function refresh() { const res = await fetch('/api/state'); const data = await res.json(); state.running = data.activeJob && data.activeJob.status === 'running'; runBtn.disabled = state.running; if (data.activeJob) { setStatus(data.activeJob.status === 'running' ? 'Running' : data.activeJob.status, data.activeJob.status === 'failed' ? 'bad' : 'ok'); lastTarget.textContent = data.activeJob.url; renderLogs(data.activeJob); if (data.activeJob.result) renderMetrics(data.activeJob.result); } else { setStatus('Ready'); if (data.reports[0]) { renderMetrics(data.reports[0]); lastTarget.textContent = data.reports[0].data.reportUrl || data.reports[0].data.domain || 'None yet'; } else { renderMetrics(null); } } renderReports(data.reports); }
document.getElementById('scrapeForm').addEventListener('submit', async (event) => { event.preventDefault(); runBtn.disabled = true; setStatus('Starting'); logs.textContent = 'Starting scraper...'; const res = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: document.getElementById('target').value }) }); const data = await res.json(); if (!res.ok) { setStatus('Failed', 'bad'); logs.textContent = data.error || 'Unable to start scrape.'; runBtn.disabled = false; return; } await refresh(); });
setInterval(refresh, 1800); refresh();
</script>
</body>
</html>`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pageHtml());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, {
        activeJob: activeJob ? snapshot(activeJob) : null,
        jobs: [...jobs.values()].slice(-10).map(snapshot),
        reports: await latestReports(),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendJson(res, 202, await runScraper(body.target));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/download/')) {
      const file = decodeURIComponent(url.pathname.replace('/download/', ''));
      if (!/^similarweb_[a-z0-9._-]+\.(json|csv|html|txt)$/i.test(file)) {
        sendJson(res, 400, { error: 'Invalid download name.' });
        return;
      }

      const filePath = resolve(dataDir, file);
      if (!filePath.startsWith(resolve(dataDir))) {
        sendJson(res, 403, { error: 'Download not allowed.' });
        return;
      }

      await stat(filePath);
      res.writeHead(200, {
        'content-type': contentTypes[extname(filePath)] || 'application/octet-stream',
        'content-disposition': `attachment; filename="${file}"`,
      });
      createReadStream(filePath).pipe(res);
      return;
    }

    sendJson(res, 404, { error: 'Not found.' });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

await mkdir(dataDir, { recursive: true });
createServer(handle).listen(port, () => {
  console.log(`Similarweb dashboard: http://localhost:${port}`);
  console.log('The existing similarweb-scraper.mjs is run unchanged as a child process.');
});
