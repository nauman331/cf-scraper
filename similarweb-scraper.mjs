import 'dotenv/config';
import { chromium } from 'playwright-core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const reportUrl = process.argv[2] || 'https://www.similarweb.com/website/hamariweb.com/';
const outputDir = 'data';
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const headless = process.env.HEADLESS !== 'false';
const timeout = Number(process.env.SCRAPER_TIMEOUT_MS || 90000);
const proxyFile = process.env.PROXY_FILE || 'proxies.txt';
const maxProxyAttempts = Math.max(0, Number(process.env.MAX_PROXY_ATTEMPTS || 3));
const proxyCursorFile = join(outputDir, '.proxy-cursor');
const similarwebApiKey = process.env.SIMILARWEB_API_KEY?.trim();

class RetryableAccessError extends Error {}

function maskProxy(value) {
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return 'configured proxy';
  }
}

function parseProxy(value) {
  const providerFormat = value.match(/^([^:\s]+):(\d+):([^:]+):(.+)$/);
  if (providerFormat && !value.includes('://')) {
    const [, host, port, username, password] = providerFormat;
    return {
      label: `http://${host}:${port}`,
      server: `http://${host}:${port}`,
      username,
      password,
    };
  }

  const normalized = value.includes('://') ? value : `http://${value}`;
  const url = new URL(normalized);
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol)) {
    throw new Error(`Unsupported proxy protocol: ${url.protocol}`);
  }
  if (!url.hostname) throw new Error('Proxy host is missing');

  const proxy = {
    label: maskProxy(normalized),
    server: `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`,
  };
  if (url.username) proxy.username = decodeURIComponent(url.username);
  if (url.password) proxy.password = decodeURIComponent(url.password);
  return proxy;
}

async function loadProxies() {
  try {
    const text = await readFile(proxyFile, 'utf8');
    const proxies = [];
    for (const line of text.split(/\r?\n/)) {
      const value = line.trim();
      if (!value || value.startsWith('#')) continue;
      try {
        proxies.push(parseProxy(value));
      } catch (error) {
        console.error(`[proxy] Skipping invalid entry: ${error.message}`);
      }
    }
    return proxies;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`[proxy] Could not read ${proxyFile}: ${error.message}`);
    return [];
  }
}

async function selectProxyWindow(allProxies) {
  const count = Math.min(maxProxyAttempts, allProxies.length);
  if (!count) return [];

  let cursor = 0;
  try {
    cursor = Number.parseInt((await readFile(proxyCursorFile, 'utf8')).trim(), 10);
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
  } catch {}

  const selected = Array.from({ length: count }, (_, index) =>
    allProxies[(cursor + index) % allProxies.length]
  );
  await writeFile(proxyCursorFile, String((cursor + count) % allProxies.length), 'utf8');
  return selected;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function domainFromReportUrl(url) {
  const match = new URL(url).pathname.match(/\/website\/([^/]+)/i);
  if (!match) throw new Error('Expected a Similarweb URL like /website/example.com/');
  return decodeURIComponent(match[1]).toLowerCase();
}

function clean(value) {
  return value?.replace(/\s+/g, ' ').trim() || null;
}

function first(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return clean(match[1]);
  }
  return null;
}

function number(value) {
  if (!value) return null;
  const parsed = Number(value.replace(/[,%#,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDuration(value) {
  if (!value) return null;
  const parts = value.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function reportToCsv(data) {
  const row = {
    source: data.source,
    report_url: data.reportUrl,
    domain: data.domain,
    period: data.period,
    scraped_at: data.scrapedAt,
    global_rank: data.rankings.global,
    country_rank: data.rankings.country,
    country_name: data.rankings.countryName,
    category_rank: data.rankings.category,
    category_name: data.rankings.categoryName,
    bounce_rate: data.engagement.bounceRate,
    bounce_rate_percent: data.engagement.bounceRatePercent,
    pages_per_visit: data.engagement.pagesPerVisit,
    average_visit_duration: data.engagement.averageVisitDuration,
    average_visit_duration_seconds: data.engagement.averageVisitDurationSeconds,
    last_month_traffic_change: data.engagement.lastMonthTrafficChange,
  };

  return `${Object.keys(row).map(csvCell).join(',')}\r\n${Object.values(row).map(csvCell).join(',')}\r\n`;
}

function titleCase(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase()) || null;
}

function extractEmbeddedReport(html, url, title) {
  const marker = 'window.__APP_DATA__ = ';
  const start = html.indexOf(marker);
  if (start < 0) return null;

  const valueStart = start + marker.length;
  const valueEnd = html.indexOf('\n', valueStart);
  if (valueEnd < 0) return null;

  try {
    const appData = JSON.parse(html.slice(valueStart, valueEnd).trim().replace(/;$/, ''));
    const website = appData?.layout?.data;
    const overview = website?.overview;
    if (!website?.domain || !overview || overview.globalRank == null) return null;

    const snapshot = website.snapshotDate ? new Date(website.snapshotDate) : null;
    const period = snapshot && !Number.isNaN(snapshot.getTime())
      ? snapshot.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      : first(title, [/\[([^\]]+)\]\s*\|\s*Similarweb/i]);
    const bouncePercent = overview.bounceRate == null ? null : overview.bounceRate * 100;
    const trafficChange = website.traffic?.visitsTotalCountChange;

    return {
      source: 'Similarweb public website report',
      reportUrl: url,
      domain: website.domain,
      period,
      scrapedAt: new Date().toISOString(),
      rankings: {
        global: overview.globalRank,
        country: overview.countryRank ?? null,
        countryName: titleCase(overview.countryUrlCode),
        category: overview.categoryRank ?? null,
        categoryName: titleCase(website.categoryId),
      },
      engagement: {
        bounceRate: bouncePercent == null ? null : `${bouncePercent.toFixed(2)}%`,
        bounceRatePercent: bouncePercent,
        pagesPerVisit: overview.pagesPerVisit ?? null,
        averageVisitDuration: overview.visitsAvgDurationFormatted ?? null,
        averageVisitDurationSeconds: parseDuration(overview.visitsAvgDurationFormatted),
        lastMonthTrafficChange: trafficChange == null ? null : `${trafficChange >= 0 ? '+' : ''}${(trafficChange * 100).toFixed(2)}%`,
      },
    };
  } catch {
    return null;
  }
}

function extractReport(text, url, title) {
  const globalRank = first(text, [/Global Rank\s*#([\d,]+)/i]);
  const countryBlock = first(text, [/Country Rank\s*#([\d,]+\s+[\s\S]{0,80}?)(?=Category Rank)/i]);
  const categoryBlock = first(text, [/Category Rank\s*#([\d,]+\s+[\s\S]{0,120}?)(?=Showing Similarweb)/i]);
  const bounceRate = first(text, [/Bounce Rate\s*([\d.]+%)/i]);
  const pagesPerVisit = first(text, [/Pages per Visit\s*([\d.]+)/i]);
  const visitDuration = first(text, [/Avg Visit Duration\s*(\d{2}:\d{2}:\d{2})/i]);
  const monthlyChange = first(text, [/web traffic has (?:increased|decreased) by\s*([\d.]+%)/i, /Last Month Change\s*([+-]?[\d.]+%)/i]);
  const period = first(title, [/\[([^\]]+)\]\s*\|\s*Similarweb/i]);
  const category = categoryBlock?.replace(/^\d[\d,]*\s*/, '').replace(/\s*\(In [^)]+\).*$/i, '') || null;
  const country = countryBlock
    ?.replace(/^\d[\d,]*\s+(?:\d[\d,]*\s+)?/, '')
    .trim() || null;

  return {
    source: 'Similarweb public website report',
    reportUrl: url,
    domain: domainFromReportUrl(url),
    period,
    scrapedAt: new Date().toISOString(),
    rankings: {
      global: number(globalRank),
      country: number(first(countryBlock || '', [/^([\d,]+)/])),
      countryName: country,
      category: number(first(categoryBlock || '', [/^([\d,]+)/])),
      categoryName: category,
    },
    engagement: {
      bounceRate,
      bounceRatePercent: number(bounceRate),
      pagesPerVisit: number(pagesPerVisit),
      averageVisitDuration: visitDuration,
      averageVisitDurationSeconds: parseDuration(visitDuration),
      lastMonthTrafficChange: monthlyChange,
    },
  };
}

function previousMonth() {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
}

function durationText(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return null;
  const value = Math.max(0, Math.round(Number(seconds)));
  const hours = String(Math.floor(value / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((value % 3600) / 60)).padStart(2, '0');
  const remaining = String(value % 60).padStart(2, '0');
  return `${hours}:${minutes}:${remaining}`;
}

async function apiRequest(path, params) {
  const url = new URL(path, 'https://api.similarweb.com');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url, {
    headers: { 'api-key': similarwebApiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {}

  if (!response.ok) {
    const detail = payload?.message || payload?.error || text.slice(0, 300) || response.statusText;
    throw new Error(`Similarweb API returned HTTP ${response.status}: ${detail}`);
  }
  return payload;
}

async function fetchOfficialReport(domain) {
  const month = previousMonth();
  console.log(`Using official Similarweb API for ${domain} (${month})`);

  const [engagement, ranking] = await Promise.all([
    apiRequest('/v5/website-analysis/websites/traffic-and-engagement', {
      domain,
      start_date: month,
      end_date: month,
      granularity: 'monthly',
      web_source: 'total',
      country: 'ww',
      metrics: 'visits,bounce_rate,pages_per_visit,average_visit_duration',
      main_domain_only: 'true',
      format: 'json',
    }),
    apiRequest('/v5/website-analysis/websites/website-rank', {
      domain,
      start_date: month,
      end_date: month,
      granularity: 'monthly',
      web_source: 'total',
      country: 'ww',
      metrics: 'category_rank,category',
      format: 'json',
    }),
  ]);

  const engagementRow = engagement?.data?.at?.(-1);
  const rankingRow = ranking?.data?.at?.(-1) || {};
  if (!engagementRow) throw new Error(`Similarweb API returned no data for ${domain} in ${month}`);

  const bounceValue = engagementRow.bounce_rate == null ? null : Number(engagementRow.bounce_rate);
  const bouncePercent = bounceValue == null ? null : bounceValue <= 1 ? bounceValue * 100 : bounceValue;
  const durationSeconds = engagementRow.average_visit_duration == null
    ? null
    : Number(engagementRow.average_visit_duration);

  return {
    source: 'Similarweb official API',
    reportUrl,
    domain,
    period: new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'long', year: 'numeric', timeZone: 'UTC',
    }),
    scrapedAt: new Date().toISOString(),
    rankings: {
      global: null,
      country: null,
      countryName: null,
      category: rankingRow.category_rank ?? null,
      categoryName: titleCase(rankingRow.category),
    },
    engagement: {
      bounceRate: bouncePercent == null ? null : `${bouncePercent.toFixed(2)}%`,
      bounceRatePercent: bouncePercent,
      pagesPerVisit: engagementRow.pages_per_visit ?? null,
      averageVisitDuration: durationText(durationSeconds),
      averageVisitDurationSeconds: durationSeconds,
      lastMonthTrafficChange: null,
    },
  };
}

async function saveReport(data, artifacts = {}) {
  const suffix = timestamp();
  const base = `similarweb_${data.domain.replace(/[^a-z0-9.-]/gi, '_')}_${suffix}`;
  const jsonPath = join(outputDir, `${base}.json`);
  const csvPath = join(outputDir, `${base}.csv`);
  const htmlPath = join(outputDir, `${base}.html`);
  const textPath = join(outputDir, `${base}.txt`);
  const text = artifacts.text || JSON.stringify(data, null, 2);
  const html = artifacts.html || `<pre>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;

  await Promise.all([
    writeFile(jsonPath, JSON.stringify(data, null, 2), 'utf8'),
    writeFile(csvPath, `\uFEFF${reportToCsv(data)}`, 'utf8'),
    writeFile(htmlPath, html, 'utf8'),
    writeFile(textPath, text, 'utf8'),
  ]);

  console.log(JSON.stringify(data, null, 2));
  console.log(`\nSaved CSV: ${csvPath}`);
  console.log(`Saved JSON: ${jsonPath}`);
  console.log(`Saved HTML: ${htmlPath}`);
  console.log(`Saved text: ${textPath}`);
}

async function scrapeWith(proxy) {
  const launchOptions = {
    executablePath: chromePath,
    headless,
  };
  if (proxy) {
    launchOptions.proxy = {
      server: proxy.server,
      ...(proxy.username ? { username: proxy.username } : {}),
      ...(proxy.password ? { password: proxy.password } : {}),
    };
  }

  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: 'en-US',
    });
    const page = await context.newPage();
    const response = await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout });
    const status = response?.status();

    if ([403, 429, 503].includes(status)) {
      throw new RetryableAccessError(`Similarweb returned HTTP ${status}`);
    }
    if (status && status >= 400) {
      throw new Error(`Similarweb returned HTTP ${status} while loading ${reportUrl}`);
    }

    if (page.isClosed()) {
      throw new Error('The browser page was closed before the Similarweb report finished loading. Keep the browser window open until the run completes.');
    }

    let bodyText;
    let html;
    let title;
    try {
      [bodyText, html, title] = await Promise.all([
        page.locator('body').innerText(),
        page.content(),
        page.title(),
      ]);
    } catch (error) {
      if (page.isClosed() || /Target page, context or browser has been closed/i.test(error.message)) {
        throw new Error('The browser page was closed before the Similarweb report could be read. Keep the browser window open until the run completes.');
      }
      throw error;
    }

    const challengePattern = /verify that you.re not a robot|challenge-container|AwsWafIntegration|request could not be satisfied/i;
    let challenged = challengePattern.test(`${bodyText}\n${html}`);

    if (challenged && !headless) {
      console.log(`Verification page opened${proxy ? ` through ${proxy.label}` : ''}. Complete it in the visible browser; waiting up to ${Math.round(timeout / 1000)} seconds.`);
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (page.isClosed()) {
          throw new Error('The browser was closed while waiting for verification. Keep it open until the report loads.');
        }
        await page.waitForTimeout(1000);
        [bodyText, html, title] = await Promise.all([
          page.locator('body').innerText(),
          page.content(),
          page.title(),
        ]);
        const dataReady = extractEmbeddedReport(html, page.url(), title) || bodyText.includes('Global Rank');
        if (dataReady) {
          challenged = false;
          console.log('Verification completed; report data loaded.');
          break;
        }
      }
    }

    if (challenged) {
      throw new RetryableAccessError(
        headless
          ? 'Similarweb displayed a verification challenge; retry with "Show browser window" enabled'
          : `Similarweb verification was not completed within ${Math.round(timeout / 1000)} seconds`
      );
    }

    const embeddedData = extractEmbeddedReport(html, page.url(), title);
    if (!embeddedData && !bodyText.includes('Global Rank')) {
      throw new RetryableAccessError('Similarweb loaded the page but did not provide report data');
    }

    return { bodyText, html, title, url: page.url(), embeddedData };
  } finally {
    await browser.close();
  }
}

async function main() {
  const domain = domainFromReportUrl(reportUrl);
  await mkdir(outputDir, { recursive: true });

  if (similarwebApiKey) {
    const data = await fetchOfficialReport(domain);
    await saveReport(data);
    return;
  }

  const proxies = await selectProxyWindow(await loadProxies());
  const attempts = [null, ...proxies];
  let report = null;
  let lastError = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const proxy = attempts[index];
    console.log(proxy ? `Trying proxy ${index}/${proxies.length}: ${proxy.label}` : 'Trying direct connection');
    try {
      report = await scrapeWith(proxy);
      if (proxy) console.log(`Proxy succeeded: ${proxy.label}`);
      break;
    } catch (error) {
      lastError = error;
      const hasNext = index + 1 < attempts.length;
      const proxyNetworkError = proxy && /ERR_(?:PROXY|TUNNEL|TIMED_OUT|CONNECTION|NAME_NOT_RESOLVED|SOCKS)|ECONN|ETIMEDOUT|ESOCKET|EAI_AGAIN|ENOTFOUND|Timeout/i.test(error.message);
      if (error instanceof RetryableAccessError || proxyNetworkError) {
        if (hasNext) {
          console.log(`${error.message}; ${proxy ? 'rotating to the next proxy' : 'trying proxy fallback'}`);
          continue;
        }
        break;
      }
      throw error;
    }
  }

  if (!report) {
    const suffix = proxies.length
      ? ` after direct access and ${proxies.length} proxy attempt${proxies.length === 1 ? '' : 's'}`
      : '; add proxies to proxies.txt to enable limited fallback';
    throw new Error(`${lastError?.message || 'Similarweb report could not be loaded'}${suffix}`);
  }

  const data = report.embeddedData || extractReport(report.bodyText, report.url, report.title);
  await saveReport(data, { html: report.html, text: report.bodyText });
}
main().catch((error) => {
  console.error(`[!] ${error.message}`);
  process.exitCode = 1;
});


