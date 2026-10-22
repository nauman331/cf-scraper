import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const reportUrl = process.argv[2] || 'https://www.similarweb.com/website/hamariweb.com/';
const outputDir = 'data';
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const headless = process.env.HEADLESS !== 'false';
const timeout = Number(process.env.SCRAPER_TIMEOUT_MS || 90000);

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

async function main() {
  const domain = domainFromReportUrl(reportUrl);
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: 'en-US',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout });

    await page.waitForFunction(
      () => document.body?.innerText.includes('Global Rank') && document.body?.innerText.includes('Bounce Rate'),
      null,
      { timeout }
    ).catch(() => {});

    const bodyText = await page.locator('body').innerText();
    const html = await page.content();
    const challenged = /verify that you.re not a robot|challenge-container|AwsWafIntegration/i.test(`${bodyText}\n${html}`);
    if (challenged || !bodyText.includes('Global Rank')) {
      throw new Error(
        'Similarweb did not render report data. Retry with a visible browser: $env:HEADLESS="false"; npm run scrape:similarweb'
      );
    }

    const data = extractReport(bodyText, page.url(), await page.title());
    const suffix = timestamp();
    const base = `similarweb_${domain.replace(/[^a-z0-9.-]/gi, '_')}_${suffix}`;
    const jsonPath = join(outputDir, `${base}.json`);
    const csvPath = join(outputDir, `${base}.csv`);
    const htmlPath = join(outputDir, `${base}.html`);
    const textPath = join(outputDir, `${base}.txt`);

    await Promise.all([
      writeFile(jsonPath, JSON.stringify(data, null, 2), 'utf8'),
      writeFile(csvPath, `\uFEFF${reportToCsv(data)}`, 'utf8'),
      writeFile(htmlPath, html, 'utf8'),
      writeFile(textPath, bodyText, 'utf8'),
    ]);

    console.log(JSON.stringify(data, null, 2));
    console.log(`\nSaved CSV: ${csvPath}`);
    console.log(`Saved JSON: ${jsonPath}`);
    console.log(`Saved HTML: ${htmlPath}`);
    console.log(`Saved text: ${textPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`[!] ${error.message}`);
  process.exitCode = 1;
});


