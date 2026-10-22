import 'dotenv/config';
import http from 'node:http';
import { spawn, exec } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const scraperPath = join(root, 'similarweb-scraper.mjs');
const dataDir = join(root, 'data');
const indexPath = join(root, 'gui', 'index.html');
const port = Number(process.env.GUI_PORT || 4173);
const defaultChrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const defaultTimeoutSeconds = Number(process.env.SCRAPER_TIMEOUT_MS || 90000) / 1000;
const pauseBetweenMs = 2000;

const clients = new Set();
const logBuffer = [];
let job = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function send(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(event) {
  for (const client of clients) send(client, event);
}

function publicJob() {
  if (!job) return null;
  return {
    id: job.id,
    running: job.running,
    stopped: job.stopped,
    index: job.index,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    options: job.options,
    items: job.items.map(({ input, domain, url, status, error, startedAt, finishedAt, data, files }) => ({
      input,
      domain,
      url,
      status,
      error,
      startedAt,
      finishedAt,
      data,
      files,
    })),
  };
}

function pushState() {
  broadcast({ type: 'state', job: publicJob() });
}

function pushLog(level, text) {
  const entry = { type: 'log', level, text, time: Date.now() };
  logBuffer.push(entry);
  if (logBuffer.length > 1500) logBuffer.shift();
  broadcast(entry);
}

function normalizeTarget(raw) {
  const input = String(raw).trim();
  if (!input) return null;
  let host = input;
  try {
    if (/^https?:\/\//i.test(input)) {
      const parsed = new URL(input);
      if (/(^|\.)similarweb\.com$/i.test(parsed.hostname)) {
        const match = parsed.pathname.match(/\/website\/([^/]+)/i);
        if (!match) return null;
        host = decodeURIComponent(match[1]);
      } else {
        host = parsed.hostname;
      }
    }
  } catch {
    return null;
  }
  host = host.replace(/^www\./i, '').split(/[/?#]/)[0].toLowerCase();
  const valid = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host);
  if (!valid) return null;
  return { input, domain: host, url: `https://www.similarweb.com/website/${host}/` };
}

function lineReader(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk.toString('utf8');
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop();
      parts.forEach(onLine);
    },
    flush() {
      if (buffer) onLine(buffer);
      buffer = '';
    },
  };
}

function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

function runItem(item) {
  return new Promise((resolve) => {
    const saved = {};
    let failure = null;
    let inJson = false;
    let settled = false;

    const child = spawn(process.execPath, [scraperPath, item.url], {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        HEADLESS: String(job.options.headless),
        CHROME_PATH: job.options.chromePath,
        SCRAPER_TIMEOUT_MS: String(Math.round(job.options.timeoutSeconds * 1000)),
      },
    });
    job.child = child;

    const out = lineReader((line) => {
      const match = line.match(/^Saved (CSV|JSON|HTML|text): (.+)$/);
      if (match) saved[match[1] === 'text' ? 'txt' : match[1].toLowerCase()] = basename(match[2].trim());
      if (line === '{') {
        inJson = true;
        return;
      }
      if (inJson) {
        if (line === '}') {
          inJson = false;
          pushLog('ok', 'Report parsed');
        }
        return;
      }
      if (line.trim()) pushLog('out', line);
    });

    const err = lineReader((line) => {
      if (!line.trim()) return;
      if (line.startsWith('[!]')) failure = line.slice(3).trim();
      pushLog('err', line);
    });

    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));

    const finish = async (code) => {
      if (settled) return;
      settled = true;
      out.flush();
      err.flush();
      if (code === 0 && saved.json) {
        try {
          const raw = await readFile(join(dataDir, saved.json), 'utf8');
          item.data = JSON.parse(raw.replace(/^\uFEFF/, ''));
          item.files = saved;
          item.status = 'done';
        } catch (error) {
          item.status = 'failed';
          item.error = `Could not read the saved report: ${error.message}`;
        }
      } else if (job.stopped) {
        item.status = 'stopped';
        item.error = 'Stopped before it finished';
      } else {
        item.status = 'failed';
        item.error = failure || `The scraper exited with code ${code}`;
      }
      resolve();
    };

    child.on('error', (error) => {
      failure = error.message;
      finish(-1);
    });
    child.on('close', (code) => finish(code));
  });
}

async function runQueue() {
  const items = job.items;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (job.stopped) {
      for (let j = i; j < items.length; j += 1) items[j].status = 'skipped';
      break;
    }
    job.index = i;
    item.status = 'running';
    item.startedAt = Date.now();
    pushLog('info', `Starting ${item.domain}`);
    pushState();
    await runItem(item);
    item.finishedAt = Date.now();
    if (item.status === 'done') {
      pushLog('ok', `Finished ${item.domain}`);
    } else {
      pushLog('err', `${item.domain}: ${item.error}`);
    }
    pushState();
    if (i < items.length - 1 && !job.stopped) await sleep(pauseBetweenMs);
  }
  job.running = false;
  job.finishedAt = Date.now();
  job.child = null;
  pushLog('info', job.stopped ? 'Run stopped' : 'Run complete');
  pushState();
}

async function listHistory() {
  let names = [];
  try {
    names = await readdir(dataDir);
  } catch {
    return [];
  }
  const present = new Set(names);
  const jsonNames = names.filter((name) => /^similarweb_.+\.json$/.test(name));
  const rows = await Promise.all(
    jsonNames.map(async (name) => {
      try {
        const path = join(dataDir, name);
        const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
        const base = name.slice(0, -5);
        const files = {};
        for (const ext of ['csv', 'json', 'html', 'txt']) {
          if (present.has(`${base}.${ext}`)) files[ext] = `${base}.${ext}`;
        }
        return { id: base, data: JSON.parse(raw.replace(/^\uFEFF/, '')), files, mtime: info.mtimeMs };
      } catch {
        return null;
      }
    })
  );
  return rows.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 100_000) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const fileTypes = {
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  html: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

async function handleStart(req, res) {
  if (job?.running) return json(res, 409, { error: 'A run is already in progress.' });
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return json(res, 400, { error: error.message });
  }

  const lines = Array.isArray(body.targets) ? body.targets : String(body.targets || '').split(/[\r\n,]+/);
  const parsed = lines.map((line) => ({ line: String(line).trim(), target: normalizeTarget(line) })).filter((entry) => entry.line);
  const invalid = parsed.filter((entry) => !entry.target).map((entry) => entry.line);
  if (invalid.length) return json(res, 400, { error: `These entries are not valid websites: ${invalid.join(', ')}`, invalid });

  const seen = new Set();
  const targets = [];
  for (const { target } of parsed) {
    if (seen.has(target.domain)) continue;
    seen.add(target.domain);
    targets.push(target);
  }
  if (!targets.length) return json(res, 400, { error: 'Add at least one website to scrape.' });
  if (targets.length > 50) return json(res, 400, { error: 'Queue is limited to 50 websites per run.' });

  const timeoutSeconds = Math.min(600, Math.max(10, Number(body.timeoutSeconds) || defaultTimeoutSeconds));
  const chromePath = String(body.chromePath || '').trim() || defaultChrome;

  job = {
    id: Date.now(),
    running: true,
    stopped: false,
    index: 0,
    startedAt: Date.now(),
    finishedAt: null,
    child: null,
    options: { headless: body.headless !== false, chromePath, timeoutSeconds },
    items: targets.map((target) => ({ ...target, status: 'queued', error: null, startedAt: null, finishedAt: null, data: null, files: null })),
  };
  logBuffer.length = 0;
  broadcast({ type: 'reset' });
  pushLog('info', `Queued ${targets.length} website${targets.length === 1 ? '' : 's'} (${job.options.headless ? 'hidden browser' : 'visible browser'})`);
  pushState();
  runQueue();
  json(res, 202, { ok: true });
}

function handleStop(res) {
  if (!job?.running) return json(res, 409, { error: 'Nothing is running.' });
  job.stopped = true;
  pushLog('info', 'Stopping…');
  killTree(job.child);
  json(res, 200, { ok: true });
}

async function handleFile(url, res) {
  const name = url.searchParams.get('name') || '';
  const match = name.match(/^similarweb_[A-Za-z0-9._-]+\.(json|csv|html|txt)$/);
  if (!match) return json(res, 400, { error: 'Invalid file name.' });
  try {
    const content = await readFile(join(dataDir, name));
    const headers = { 'Content-Type': fileTypes[match[1]], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (url.searchParams.get('download') === '1') {
      headers['Content-Disposition'] = `attachment; filename="${name}"`;
      if (match[1] === 'html') headers['Content-Type'] = 'text/html; charset=utf-8';
    }
    res.writeHead(200, headers);
    res.end(content);
  } catch {
    json(res, 404, { error: 'File not found.' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Forbidden origin.' });
  }

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const html = await readFile(indexPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, { chromePath: defaultChrome, headless: process.env.HEADLESS !== 'false', timeoutSeconds: defaultTimeoutSeconds });
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      return json(res, 200, await listHistory());
    }

    if (req.method === 'GET' && url.pathname === '/api/file') {
      return handleFile(url, res);
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      send(res, { type: 'state', job: publicJob() });
      for (const entry of logBuffer) send(res, entry);
      clients.add(res);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/run') return handleStart(req, res);
    if (req.method === 'POST' && url.pathname === '/api/stop') return handleStop(res);

    json(res, 404, { error: 'Not found.' });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[!] Port ${port} is already in use. Start with a different port: $env:GUI_PORT=4180; node similarweb-gui.mjs`);
  } else {
    console.error(`[!] ${error.message}`);
  }
  process.exit(1);
});

function openBrowser(target) {
  if (process.env.GUI_NO_OPEN === 'true') return;
  const command = process.platform === 'win32' ? `start "" "${target}"` : process.platform === 'darwin' ? `open "${target}"` : `xdg-open "${target}"`;
  exec(command, () => {});
}

async function boot() {
  try {
    await stat(scraperPath);
  } catch {
    console.error('[!] similarweb-scraper.mjs was not found next to similarweb-gui.mjs');
    process.exit(1);
  }
  server.listen(port, '127.0.0.1', () => {
    const address = `http://127.0.0.1:${port}`;
    console.log(`Similarweb Scraper GUI running at ${address}`);
    console.log('Press Ctrl+C to stop.');
    openBrowser(address);
  });
}

process.on('SIGINT', () => {
  killTree(job?.child);
  process.exit(0);
});

boot();
