import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const CONFIG = {
  targets: [
    { name: 'r-programming', url: 'https://www.reddit.com/r/programming/hot.rss?limit=25' },
    { name: 'r-javascript', url: 'https://www.reddit.com/r/javascript/hot.rss?limit=25' },
    { name: 'r-webdev', url: 'https://www.reddit.com/r/webdev/hot.rss?limit=25' },
    { name: 'r-node', url: 'https://www.reddit.com/r/node/hot.rss?limit=25' },
  ],
  proxies: [],
  browser: 'Chrome_131',
  preferEngine: 'auto',
  minDelayMs: 2000,
  maxDelayMs: 6000,
  maxRetries: 3,
  retryBackoffMs: 30000,
  dataDir: 'data',
  mode: 'once',
  loopMinCycleMs: 60000,
  loopMaxCycleMs: 120000,
  timeoutMs: 30000,
  maxExtractChars: 12000,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

let PROXY_POOL = [];
let proxyIndex = 0;
let ghostModulePromise = null;

async function loadProxies() {
  if (CONFIG.proxies.length > 0) {
    PROXY_POOL = CONFIG.proxies;
    return;
  }

  try {
    const data = await readFile('proxies.txt', 'utf8');
    PROXY_POOL = data
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    PROXY_POOL = [];
  }
}

function pickProxy() {
  if (!PROXY_POOL.length) return null;
  const proxy = PROXY_POOL[proxyIndex % PROXY_POOL.length];
  proxyIndex += 1;
  return proxy;
}

function makeAgent(proxy) {
  if (!proxy) return null;
  return proxy.startsWith('socks')
    ? new SocksProxyAgent(proxy)
    : new HttpsProxyAgent(proxy);
}

function maskProxy(proxy) {
  return proxy ? proxy.replace(/:[^:@/]+@/, ':***@') : 'direct';
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTags(html) {
  return normalizeWhitespace(
    String(html || '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
  );
}

function getHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) ?? '';
  const key = Object.keys(headers).find(
    (current) => current.toLowerCase() === name.toLowerCase()
  );
  return key ? String(headers[key]) : '';
}

function getContentType(headers = {}) {
  return getHeader(headers, 'content-type').split(';')[0].trim().toLowerCase();
}

function inferKindFromUrl(url) {
  const ext = extname(new URL(url).pathname).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.xml' || ext === '.rss' || ext === '.atom') return 'xml';
  if (ext === '.txt') return 'text';
  return 'html';
}

function inferKindFromContentType(contentType, url) {
  if (contentType.includes('json')) return 'json';
  if (contentType.includes('xml') || contentType.includes('rss')) return 'xml';
  if (contentType.startsWith('text/plain')) return 'text';
  if (!contentType || contentType.includes('html')) return inferKindFromUrl(url);
  return inferKindFromUrl(url);
}

function isChallenge(body) {
  const head = String(body).slice(0, 3000);
  return /g-recaptcha|cf-mitigated|Just a moment|Prove your humanity|Attention Required/i.test(
    head
  );
}

function extractFirstMatch(input, regex) {
  const match = String(input || '').match(regex);
  return match ? normalizeWhitespace(match[1]) : '';
}

function extractMetaContent(html, names) {
  for (const name of names) {
    const escaped = escapeRegExp(name);
    const patterns = [
      new RegExp(
        `<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
        'i'
      ),
      new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["'][^>]*>`,
        'i'
      ),
      new RegExp(
        `<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
        'i'
      ),
      new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["'][^>]*>`,
        'i'
      ),
    ];

    for (const pattern of patterns) {
      const match = String(html).match(pattern);
      if (match) return normalizeWhitespace(match[1]);
    }
  }

  return '';
}

function extractJsonLd(html) {
  const results = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of String(html).matchAll(re)) {
    try {
      const parsed = JSON.parse(normalizeWhitespace(match[1]));
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        results.push({
          '@type': item['@type'] ?? null,
          name: item.name ?? item.headline ?? null,
          description: item.description ?? null,
          url: item.url ?? null,
        });
        if (results.length >= 10) return results;
      }
    } catch {
      // Ignore malformed JSON-LD.
    }
  }

  return results;
}

function extractLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of String(html).matchAll(re)) {
    try {
      const href = new URL(match[1], baseUrl).href;
      if (seen.has(href)) continue;
      seen.add(href);
      links.push({
        href,
        text: stripTags(match[2]).slice(0, 120),
      });
    } catch {
      // Ignore bad URLs.
    }

    if (links.length >= 75) break;
  }

  return links;
}

function extractHtmlSummary(html, url) {
  const title = extractFirstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = extractMetaContent(html, [
    'description',
    'og:description',
    'twitter:description',
  ]);
  const canonical = extractFirstMatch(
    html,
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i
  );
  const lang = extractFirstMatch(html, /<html[^>]+lang=["']([^"']+)["']/i);
  const robots = extractMetaContent(html, ['robots', 'googlebot']);
  const headings = [];
  const headingRe = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;

  for (const match of String(html).matchAll(headingRe)) {
    const text = stripTags(match[2]);
    if (text) headings.push({ level: Number(match[1]), text: text.slice(0, 200) });
    if (headings.length >= 20) break;
  }

  return {
    kind: 'html',
    title,
    description,
    canonical,
    lang,
    robots,
    headings,
    jsonLd: extractJsonLd(html),
    links: extractLinks(html, url),
    textPreview: stripTags(html).slice(0, CONFIG.maxExtractChars),
  };
}

function extractJsonSummary(json) {
  const isArray = Array.isArray(json);
  const keys =
    json && typeof json === 'object' && !isArray ? Object.keys(json).slice(0, 50) : [];

  return {
    kind: 'json',
    isArray,
    itemCount: isArray ? json.length : null,
    keys,
    preview: JSON.stringify(json, null, 2).slice(0, CONFIG.maxExtractChars),
  };
}

function extractXmlSummary(xml) {
  const title =
    extractFirstMatch(xml, /<title[^>]*>([\s\S]*?)<\/title>/i) ||
    extractFirstMatch(xml, /<channel[^>]*>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);

  const items = [];
  const itemRe = /<(item|entry)\b[\s\S]*?<\/\1>/gi;

  for (const match of String(xml).matchAll(itemRe)) {
    const block = match[0];
    const itemTitle = extractFirstMatch(block, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const link =
      extractFirstMatch(block, /<link[^>]+href=["']([^"']+)["'][^>]*>/i) ||
      extractFirstMatch(block, /<link[^>]*>([\s\S]*?)<\/link>/i);
    if (itemTitle || link) items.push({ title: itemTitle, link });
    if (items.length >= 25) break;
  }

  return {
    kind: 'xml',
    title,
    items,
    textPreview: stripTags(xml).slice(0, CONFIG.maxExtractChars),
  };
}

function normalizeTarget(rawTarget, index) {
  if (typeof rawTarget === 'string') {
    const url = new URL(rawTarget);
    return {
      name: safeName(`${url.hostname}${url.pathname}` || `target_${index + 1}`),
      url: url.href,
    };
  }

  if (!rawTarget || typeof rawTarget !== 'object') {
    throw new Error(`Invalid target at index ${index + 1}`);
  }

  const url = new URL(rawTarget.url);
  return {
    name:
      rawTarget.name ||
      safeName(`${url.hostname}${url.pathname}` || `target_${index + 1}`),
    url: url.href,
    type: rawTarget.type || null,
  };
}

function collectTargetsFromArgs() {
  const args = process.argv.slice(2).filter(Boolean);
  if (!args.length) {
    return CONFIG.targets.map((target, index) => normalizeTarget(target, index));
  }

  return args.map((raw, index) => normalizeTarget(raw, index));
}

async function loadGhostfetch() {
  if (ghostModulePromise) return ghostModulePromise;
  ghostModulePromise = import('ghostfetch').catch(() => null);
  return ghostModulePromise;
}

async function createGhostClient() {
  const mod = await loadGhostfetch();
  if (!mod?.GhostClient) return null;

  return new mod.GhostClient({
    browser: CONFIG.browser,
    timeout: CONFIG.timeoutMs,
    maxChallengeRetries: CONFIG.maxRetries,
    proxyPool: PROXY_POOL.length ? PROXY_POOL : undefined,
    proxyRotation: 'round-robin',
  });
}

function buildFetchHeaders() {
  return {
    'User-Agent': CONFIG.userAgent,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,' +
      'application/rss+xml,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.6',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
}

async function fetchWithGhostfetch(client, target) {
  const res = await client.fetch(target.url, {
    timeout: CONFIG.timeoutMs,
    headers: buildFetchHeaders(),
  });
  const body = await res.text();
  return {
    body,
    status: res.status,
    proxy: PROXY_POOL.length ? 'proxy-pool' : 'direct',
    contentType: getContentType(res.headers),
    engine: 'ghostfetch',
  };
}

async function fetchWithHttp(target) {
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt += 1) {
    const proxy = pickProxy();
    const agent = makeAgent(proxy);

    console.log(`    [http try ${attempt}/${CONFIG.maxRetries}] proxy: ${maskProxy(proxy)}`);

    try {
      const res = await axios.get(target.url, {
        timeout: CONFIG.timeoutMs,
        validateStatus: () => true,
        proxy: false,
        httpAgent: agent,
        httpsAgent: agent,
        headers: buildFetchHeaders(),
      });

      if ([429, 403, 503].includes(res.status)) {
        const wait = CONFIG.retryBackoffMs * attempt;
        console.log(
          `    [!] HTTP ${res.status} - backoff ${(wait / 1000).toFixed(0)}s, rotating proxy`
        );
        await sleep(wait);
        continue;
      }

      if (res.status >= 400) {
        throw new Error(`HTTP ${res.status}`);
      }

      const body =
        typeof res.data === 'string'
          ? res.data
          : Buffer.isBuffer(res.data)
            ? res.data.toString('utf8')
            : JSON.stringify(res.data);

      if (isChallenge(body)) {
        console.log('    [!] Challenge detected - rotating proxy');
        await sleep(CONFIG.retryBackoffMs * attempt);
        continue;
      }

      return {
        body,
        status: res.status,
        proxy: maskProxy(proxy),
        contentType: getContentType(res.headers),
        engine: 'http',
      };
    } catch (err) {
      console.log(`    [!] ${err.code || err.message}`);
      if (attempt < CONFIG.maxRetries) {
        await sleep(5000 * attempt);
      }
    }
  }

  return null;
}

async function fetchTarget(target, ghostClient) {
  const shouldTryGhost =
    CONFIG.preferEngine === 'ghostfetch' ||
    CONFIG.preferEngine === 'auto';

  if (shouldTryGhost && ghostClient) {
    try {
      const result = await fetchWithGhostfetch(ghostClient, target);
      if (!isChallenge(result.body) && result.status < 400) {
        return result;
      }
      console.log('    [!] Ghostfetch response still looked blocked, skipping HTTP fallback');
      return null;
    } catch (err) {
      console.log(`    [!] Ghostfetch failed: ${err.code || err.message}`);
      if (CONFIG.preferEngine === 'ghostfetch') {
        return null;
      }
    }
  }

  return fetchWithHttp(target);
}

async function saveResult(target, result) {
  await mkdir(CONFIG.dataDir, { recursive: true });

  const base = `${safeName(target.name)}_${timestamp()}`;
  const rawExt =
    result.kind === 'json' ? 'json' : result.kind === 'xml' ? 'xml' : result.kind === 'text' ? 'txt' : 'html';
  const rawPath = join(CONFIG.dataDir, `${base}.${rawExt}`);
  const metaPath = join(CONFIG.dataDir, `${base}.meta.json`);

  let rawOutput = result.body;
  let analysis;

  if (result.kind === 'json') {
    try {
      const parsed = JSON.parse(result.body);
      rawOutput = JSON.stringify(parsed, null, 2);
      analysis = extractJsonSummary(parsed);
    } catch {
      analysis = { kind: 'json', preview: result.body.slice(0, CONFIG.maxExtractChars) };
    }
  } else if (result.kind === 'xml') {
    analysis = extractXmlSummary(result.body);
  } else if (result.kind === 'html') {
    analysis = extractHtmlSummary(result.body, target.url);
  } else {
    analysis = {
      kind: 'text',
      preview: normalizeWhitespace(result.body).slice(0, CONFIG.maxExtractChars),
    };
  }

  await writeFile(rawPath, rawOutput, 'utf8');
  await writeFile(
    metaPath,
    JSON.stringify(
      {
        target: target.name,
        url: target.url,
        fetchedAt: new Date().toISOString(),
        proxy: result.proxy,
        status: result.status,
        contentType: result.contentType,
        kind: result.kind,
        engine: result.engine,
        bytes: result.body.length,
        rawFile: rawPath,
        analysis,
      },
      null,
      2
    ),
    'utf8'
  );

  return { rawPath, metaPath, analysis };
}

async function runCycle(targets, ghostClient) {
  console.log(
    `\n=== Cycle start - ${targets.length} targets, ${PROXY_POOL.length || 'no'} proxies ===\n`
  );

  let ok = 0;
  let fail = 0;

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    console.log(`[${i + 1}/${targets.length}] ${target.name}`);
    console.log(`    URL: ${target.url}`);

    const result = await fetchTarget(target, ghostClient);
    if (result) {
      const saved = await saveResult(target, result);
      console.log(`    [✓] Saved ${result.body.length} bytes -> ${saved.rawPath}`);
      ok += 1;
    } else {
      console.log(`    [✗] Failed after ${CONFIG.maxRetries} attempts`);
      fail += 1;
    }

    if (i < targets.length - 1) {
      const delay = randomBetween(CONFIG.minDelayMs, CONFIG.maxDelayMs);
      console.log(`    [z] Random wait ${(delay / 1000).toFixed(1)}s before next target\n`);
      await sleep(delay);
    } else {
      console.log('');
    }
  }

  console.log(`=== Cycle done - ok=${ok} fail=${fail} ===\n`);
}

async function main() {
  await loadProxies();
  const targets = collectTargetsFromArgs();
  const ghostClient = await createGhostClient();

  console.log(`Proxies loaded : ${PROXY_POOL.length || 0}`);
  console.log(`Mode           : ${CONFIG.mode}`);
  console.log(`Engine         : ${ghostClient ? 'ghostfetch + http fallback' : 'http only'}`);
  console.log(`Browser        : ${CONFIG.browser}`);
  console.log(`Data folder    : ${CONFIG.dataDir}/`);
  console.log(`Delay range    : ${CONFIG.minDelayMs / 1000}-${CONFIG.maxDelayMs / 1000}s (random)`);
  console.log(`Targets        : ${targets.length}\n`);

  try {
    if (CONFIG.mode === 'loop') {
      let cycle = 1;
      while (true) {
        console.log(`\n########## Cycle #${cycle} ##########`);
        await runCycle(targets, ghostClient);
        const wait = randomBetween(CONFIG.loopMinCycleMs, CONFIG.loopMaxCycleMs);
        console.log(`Next cycle in ${(wait / 1000).toFixed(0)}s (Ctrl+C to stop)\n`);
        await sleep(wait);
        cycle += 1;
      }
    } else {
      await runCycle(targets, ghostClient);
      console.log('Done. Pass URLs on the command line to scrape any site.');
    }
  } finally {
    await ghostClient?.destroy?.().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[!] Fatal:', err.message);
  process.exit(1);
});
