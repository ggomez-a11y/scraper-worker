// server.js — Goodreads scraper with CORS + resilient timeouts + JSON-LD fallbacks

import express from 'express';
import { setTimeout as delay } from 'timers/promises';

// Render/Playwright settings
process.env.PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright';
process.env.PLAYWRIGHT_SKIP_DOWNLOAD = '1';

const app = express();

/* -------------------- CORS -------------------- */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* -------------------- Helpers -------------------- */
const clean = (s) => (s ? String(s).replace(/\s+/g, ' ').trim() : null);
function withDeadline(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    (async () => { await delay(ms); throw new Error(`${label} timed out after ${ms}ms`); })(),
  ]);
}

/* -------------------- Playwright lifecycle -------------------- */
let browserRef = null, launching = null;

async function launchBrowserOnce() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-extensions','--no-zygote'],
  });
  browser.on('disconnected', () => { browserRef = null; });
  return browser;
}
async function getBrowser({ timeoutMs = 20000 } = {}) {
  if (browserRef) return browserRef;
  if (!launching) {
    launching = (async () => {
      try { return await launchBrowserOnce(); }
      finally { launching = null; }
    })().then(b => (browserRef = b), e => { browserRef = null; throw e; });
  }
  return withDeadline(launching, timeoutMs, 'Chromium launch');
}
async function newContextSafe() {
  try {
    const browser = await getBrowser();
    return await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
    });
  } catch {
    try { if (browserRef) await browserRef.close(); } catch {}
    browserRef = null;
    const browser = await getBrowser();
    return await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
    });
  }
}

/* -------------------- Routes -------------------- */
app.get('/', (_req, res) => res.send('OK - scraper server running'));

app.get('/warmup', async (_req, res) => {
  try {
    await withDeadline((async () => {
      const ctx = await newContextSafe();
      const page = await ctx.newPage();
      page.setDefaultNavigationTimeout(15000);
      page.setDefaultTimeout(5000);
      await page.goto('https://www.goodreads.com/', { waitUntil: 'domcontentloaded' });
      await ctx.close();
    })(), 20000, 'warmup');
    res.send('warmed');
  } catch (e) {
    res.status(500).send(String(e?.message || e));
  }
});

app.get('/scrape', async (req, res) => {
  const isbn = String(req.query.isbn || '').trim();
  const timeout = Math.max(15000, Math.min(60000, parseInt(req.query.timeout || '45000', 10) || 45000)); // default 45s
  if (!isbn) return res.status(400).json({ error: 'Missing ?isbn=' });

  try {
    const data = await withDeadline(runScrape(isbn), timeout, 'scrape');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* -------------------- Server -------------------- */
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, async () => {
  console.log(`server listening on http://${HOST}:${PORT}`);
  try { await withDeadline(getBrowser(), 20000, 'initial launch'); console.log('Chromium launched (warm)'); }
  catch (e) { console.log('Warm launch failed:', e?.message || e); }
});

/* -------------------- Scraper -------------------- */
async function runScrape(isbn) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let ctx;
    try {
      ctx = await newContextSafe();
      const page = await ctx.newPage();

      // Tight defaults; individual gets have their own timeouts
      page.setDefaultNavigationTimeout(18000);
      page.setDefaultTimeout(3500);

      // Block heavy assets, but KEEP CSS so hydration/visibility is reliable
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (/\.(jpg|jpeg|png|svg|gif|webp|avif|woff2?|ttf|otf)($|\?)/i.test(url)) route.abort();
        else route.continue();
      });

      // 1) Search → open first book
      await page.goto(`https://www.goodreads.com/search?q=${encodeURIComponent(isbn)}`, { waitUntil: 'domcontentloaded' });
      try { await page.locator('[class*="Overlay__close"], button[aria-label="Close"]').first().click({ timeout: 2000 }); } catch {}
      if (!page.url().includes('/book/show/')) {
        const first = page.locator('a[href*="/book/show/"]:not([href*="/reviews"])').first();
        await first.waitFor({ state: 'visible', timeout: 10000 });
        await first.click();
        await page.waitForLoadState('domcontentloaded');
      }

      // 2) Ensure title section is present (hydration hint)
      await page.waitForSelector('h1[data-testid="bookTitle"], .BookPageTitleSection__title', { timeout: 8000 });

      // Try to expand description (best-effort)
      try { await page.locator('.BookPageMetadataSection__description .Button--text').click({ timeout: 1500 }); } catch {}

      // Non-blocking attempt to open details drawer
      const openDetails = (async () => {
        const quickSeen = await page
          .locator('dt:has-text("Published") + dd, dt:has-text("Format") + dd, dt:has-text("Language") + dd, [data-testid="bookDetails"]')
          .first().isVisible().catch(() => false);
        if (quickSeen) return true;
        const labels = [/book details & editions/i,/book details and editions/i,/book details/i,/details/i,/editions/i];
        for (const rx of labels) {
          const btn = page.locator('button', { hasText: rx }).first();
          try {
            await btn.waitFor({ state: 'visible', timeout: 800 });
            await btn.click({ timeout: 600 });
            await page.waitForTimeout(250);
            const opened = await Promise.race([
              page.waitForSelector('[data-testid="bookDetails"]', { timeout: 700 }).then(() => true).catch(() => false),
              page.waitForSelector('dt:has-text("Published") + dd', { timeout: 700 }).then(() => true).catch(() => false),
            ]);
            if (opened) return true;
          } catch {}
        }
        return false;
      })();

      // Helper
      const getText = async (locator, ms=5000) =>
        await locator.first().textContent({ timeout: ms }).then(clean).catch(() => null);

      // Pull JSON-LD early for resilience
      const ldjsonScripts = await page.locator('script[type="application/ld+json"]').allTextContents().catch(() => []);
      let ldBook = null;
      try {
        const blobs = (ldjsonScripts || []).map(t => { try { return JSON.parse(t); } catch { return null; } }).filter(Boolean);
        const flat = [];
        const flatten = (o) => { if (Array.isArray(o)) return o.forEach(flatten); if (o && typeof o === 'object') { flat.push(o); for (const v of Object.values(o)) flatten(v); } };
        blobs.forEach(flatten);
        const isBookType = (t) => typeof t === 'string' && /\bBook\b/i.test(t);
        ldBook = flat.find(o => o && (isBookType(o['@type']) || (Array.isArray(o['@type']) && o['@type'].some(isBookType)))) || null;
      } catch {}

      // Core fields (+ LD fallbacks)
      const [title, author, ratingValue, ratingsCountText, descriptionRaw, genres, ogCover,
             sub1, sub2, sub3, sub4] = await Promise.all([
        getText(page.locator('h1[data-testid="bookTitle"]'), 6000).then(v => v || clean(ldBook?.name)),
        getText(page.locator('.ContributorLink__name'), 6000).then(v => v || clean(ldBook?.author?.name || (Array.isArray(ldBook?.author)? ldBook.author[0]?.name: null))),
        getText(page.locator('.RatingStatistics__rating'), 5000),
        getText(page.locator('[data-testid="ratingsCount"]'), 5000),
        getText(page.locator('[data-testid="description"] [data-testid="contentContainer"]'), 6000).then(v => v || clean(ldBook?.description)),
        page.locator('[data-testid="genresList"] .Button__labelItem').allTextContents().catch(() => []),
        page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null),
        getText(page.locator('[data-testid="bookSubtitle"]'), 3000),
        getText(page.locator('.BookPageTitleSection__subtitle'), 3000),
        getText(page.locator('.BookPageTitleSection__title h3').first(), 3000),
        getText(page.locator('[data-testid="bookPageTitleSection"] h3').first(), 3000),
      ]);
      const subtitle = sub1 || sub2 || sub3 || sub4 || null;

      // Allow the non-blocking details attempt to finish but don't stall
      await Promise.race([openDetails, delay(500)]);

      // Build dt/dd map if drawer visible
      let detailsMap = {};
      try {
        detailsMap = await page.$$eval('[data-testid="bookDetails"] dt', (dts) => {
          const toText = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
          const map = {};
          for (const dt of dts) {
            const label = toText(dt).toLowerCase();
            const dd = dt.nextElementSibling;
            const value = toText(dd);
            if (label) map[label] = value;
          }
          return map;
        }).catch(() => ({}));
      } catch { detailsMap = {}; }

      // Extract language / format / original title / series from details
      const formatText = detailsMap['format'] || null;
      let language = detailsMap['language'] || clean(ldBook?.inLanguage || ldBook?.language) || null;
      let originaltitle = detailsMap['original title'] || null;
      const seriesFromDD = detailsMap['series'] || null;

      // Parse format & pageCount
      let format = null, pageCount = null;
      if (formatText) {
        const parts = formatText.split(/,|\//).map(p => p.trim()).filter(Boolean);
        for (const part of parts) {
          if (/pages?/i.test(part)) {
            const n = parseInt(part.replace(/\D/g, ''), 10);
            if (!Number.isNaN(n)) pageCount = n;
          } else if (!format) {
            const cleaned = part.replace(/\s*\(\d+(st|nd|rd|th)\s*edition\)/i, '').trim();
            if (!/^\d/.test(cleaned)) format = cleaned;
          }
        }
      }
      if (!format && ldBook?.bookFormat) {
        const bf = clean(ldBook.bookFormat);
        const map = { 'EBook':'Ebook', 'Hardcover':'Hardcover', 'Paperback':'Paperback', 'AudiobookFormat':'Audiobook' };
        const norm = map[bf] || (bf?.replace(/^https?:.*\//, '').replace(/Format$/,'') || null);
        if (norm) format = norm;
      }

      // publishedfull from details / LD / text scan
      let publishedfull = null;
      // Quick pass: any "Published" dd we can read?
      try {
        const publishedCandidates = await page.locator('dt:has-text("Published") + dd').allTextContents();
        const cleaned = (publishedCandidates||[]).map(t => clean(t)).filter(Boolean).filter(t => !/^First published/i.test(t));
        const withBy = cleaned.find(t => /\sby\s/i.test(t));
        if (withBy || cleaned.length) publishedfull = withBy || cleaned[cleaned.length - 1];
      } catch {}
      // LD fallback
      if (!publishedfull && ldBook) {
        const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        const fmtISO = (iso) => {
          const m = String(iso||'').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
          if (!m) return null; const [,y,mm,dd]=m;
          if (y && mm && dd) return `${monthNames[+mm-1]} ${+dd}, ${y}`;
          if (y && mm) return `${monthNames[+mm-1]} ${y}`;
          return y || null;
        };
        const dateText = fmtISO(clean(ldBook.datePublished));
        let publisherName = null;
        const pub = ldBook.publisher;
        if (typeof pub === 'string') publisherName = clean(pub);
        else if (pub && typeof pub === 'object') {
          publisherName = Array.isArray(pub)
            ? clean(pub.find(p => p && (p.name || typeof p === 'string'))?.name || pub.find(p => typeof p === 'string'))
            : clean(pub.name);
        }
        if (dateText && publisherName) publishedfull = `${dateText} by ${publisherName}`;
        else if (dateText) publishedfull = dateText;
      }
      // Visible text fallback
      if (!publishedfull) {
        try {
          const txt = await page.locator('body').innerText();
          const lines = (txt || '').split('\n').map(s => s.trim()).filter(Boolean);
          const hit = lines.find(l => /[A-Za-z]+\s+\d{1,2},\s*\d{4}\s+by\s+.+/i.test(l) && !/^First published/i.test(l));
          if (hit) {
            const m = hit.match(/([A-Za-z]+\s+\d{1,2},\s*\d{4}\s+by\s+.+)$/i);
            if (m && m[1]) publishedfull = m[1].replace(/[•·]\s*.*$/, '').trim();
          }
        } catch {}
      }

      // Series cleanup: prefer DD, else the inline link if present
      let series = seriesFromDD;
      if (!series) {
        const seriesText = await getText(page.locator('dt:has-text("Series") + dd a'), 3000);
        if (seriesText) series = seriesText.replace(/\s*\(#\d+\.?\d*\)$/, '').trim();
      }

      // Original title fallback
      if (!originaltitle) {
        originaltitle = await getText(page.locator('dt:has-text("Original title") + dd [data-testid="contentContainer"]'), 3000)
          .then(v => v ?? getText(page.locator('dt:has-text("Original title") + dd'), 2500));
      }

      const avgRating = (() => { const n = parseFloat(ratingValue); return Number.isNaN(n) ? undefined : n; })();
      const ratingCount = (() => { const rc = parseInt((ratingsCountText||'').replace(/\D/g,''), 10); return Number.isNaN(rc) ? undefined : rc; })();
      const category = (() => {
        const cleanedGenres = (genres||[]).map(g => clean(g)).filter(Boolean).filter(g => !/^\.\.\.more$/i.test(g));
        return cleanedGenres.length ? cleanedGenres.join(', ') : undefined;
      })();

      const result = {
        isbn,
        title: title || null,
        subtitle,
        originaltitle: originaltitle || null,
        author: author || null,
        cover: clean(ogCover) || null,
        avgRating,
        ratingCount,
        description: descriptionRaw?.replace(/\s*\.{3}\s*more\s*$/i, '').trim() || null,
        category,
        language: language || null,
        format: format || null,
        pageCount: pageCount ?? undefined,
        series: series || undefined,
        publishedfull: publishedfull || null,
      };

      await ctx.close();
      return result;
    } catch (err) {
      try { if (ctx) await ctx.close(); } catch {}
      if (attempt === 2) throw err;
      try { if (browserRef) await browserRef.close(); } catch {}
      browserRef = null;
      await delay(300);
    }
  }
}
