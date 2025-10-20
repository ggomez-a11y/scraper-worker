import express from 'express';
import { setTimeout as delay } from 'timers/promises';

process.env.PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright';
process.env.PLAYWRIGHT_SKIP_DOWNLOAD = '1';

const app = express();

function withDeadline(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    (async () => { await delay(ms); throw new Error(`${label} timed out after ${ms}ms`); })(),
  ]);
}
const clean = (s) => (s ? String(s).replace(/\s+/g, ' ').trim() : null);

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
    launching = (async () => { try { return await launchBrowserOnce(); } finally { launching = null; } })()
      .then(b => (browserRef = b), e => { browserRef = null; throw e; });
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
  if (!isbn) return res.status(400).json({ error: 'Missing ?isbn=' });
  try {
    const data = await withDeadline(runScrape(isbn), 30000, 'scrape');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, async () => {
  console.log(`server listening on http://${HOST}:${PORT}`);
  try { await withDeadline(getBrowser(), 20000, 'initial launch'); console.log('Chromium launched (warm)'); } catch (e) { console.log('Warm launch failed:', e?.message || e); }
});

// ---------------- SCRAPER ----------------
async function runScrape(isbn) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let ctx;
    try {
      ctx = await newContextSafe();
      const page = await ctx.newPage();

      // Tight defaults but we explicitly wait longer for key selectors
      page.setDefaultNavigationTimeout(18000);
      page.setDefaultTimeout(4000);

      // Block heavy assets (keep HTML/JS)
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (/\.(css|jpg|jpeg|png|svg|gif|woff2?)($|\?)/i.test(url)) route.abort();
        else route.continue();
      });

      await page.goto(`https://www.goodreads.com/search?q=${encodeURIComponent(isbn)}`, { waitUntil: 'domcontentloaded' });

      // Close overlay if present
      try { await page.locator('[class*="Overlay__close"], button[aria-label="Close"]').first().click({ timeout: 2500 }); } catch {}

      // Go to first result if still on search page
      if (!page.url().includes('/book/show/')) {
        const first = page.locator('a[href*="/book/show/"]:not([href*="/reviews"])').first();
        await first.waitFor({ state: 'visible', timeout: 10000 });
        await first.click();
        await page.waitForLoadState('domcontentloaded');
      }

      // --- Wait for React hydration of the title section (critical!) ---
      // Either the test-id title appears, or the legacy title wrapper.
      await page.waitForSelector('h1[data-testid="bookTitle"], .BookPageTitleSection__title', { timeout: 8000 });

      // Expand description if there is a “...more” button
      try { await page.locator('.BookPageMetadataSection__description .Button--text').click({ timeout: 2000 }); } catch {}

      // Try opening details drawer (best-effort)
      const openDetails = (async () => {
        const visible = await page
          .locator('dt:has-text("Original title") + dd, dt:has-text("Published") + dd, [data-testid="bookDetails"]')
          .first().isVisible().catch(() => false);
        if (visible) return true;
        const labels = [/book details & editions/i,/book details and editions/i,/book details/i,/details/i,/editions/i];
        for (const rx of labels) {
          const btn = page.locator('button', { hasText: rx }).first();
          try {
            await btn.waitFor({ state: 'visible', timeout: 1000 });
            await btn.click({ timeout: 800 });
            await page.waitForTimeout(350);
            const opened = await Promise.race([
              page.waitForSelector('[data-testid="bookDetails"]', { timeout: 900 }).then(() => true).catch(() => false),
              page.waitForSelector('dt:has-text("Published") + dd', { timeout: 900 }).then(() => true).catch(() => false),
              page.waitForSelector('dt:has-text("Original title") + dd', { timeout: 900 }).then(() => true).catch(() => false),
            ]);
            if (opened) return true;
          } catch {}
        }
        return false;
      })();

      // ----- Extract core fields (allow more time for these) -----
      const getText = async (locator, ms=5000) =>
        await locator.first().textContent({ timeout: ms }).then(clean).catch(() => null);

      const [
        title, author, ratingValue, ratingsCountText, descriptionRaw, genres,
        formatText, language, seriesText, ogCover, ldjsonScripts,
        sub1, sub2, sub3, sub4
      ] = await Promise.all([
        getText(page.locator('h1[data-testid="bookTitle"]'), 6000),
        getText(page.locator('.ContributorLink__name'), 6000),
        getText(page.locator('.RatingStatistics__rating'), 5000),
        getText(page.locator('[data-testid="ratingsCount"]'), 5000),
        getText(page.locator('[data-testid="description"] [data-testid="contentContainer"]'), 6000),
        page.locator('[data-testid="genresList"] .Button__labelItem').allTextContents().catch(() => []),
        getText(page.locator('dt:has-text("Format") + dd'), 5000),
        getText(page.locator('dt:has-text("Language") + dd'), 5000),
        getText(page.locator('dt:has-text("Series") + dd a'), 5000),
        page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null),
        page.locator('script[type="application/ld+json"]').allTextContents().catch(() => []),
        getText(page.locator('[data-testid="bookSubtitle"]'), 3500),
        getText(page.locator('.BookPageTitleSection__subtitle'), 3500),
        getText(page.locator('.BookPageTitleSection__title h3').first(), 3500),
        getText(page.locator('[data-testid="bookPageTitleSection"] h3').first(), 3500),
      ]);

      let subtitle = sub1 || sub2 || sub3 || sub4 || null;

      // JSON-LD → publishedfull
      let publishedfull = null;
      try {
        const blobs = (ldjsonScripts || []).map(t => { try { return JSON.parse(t); } catch { return null; } }).filter(Boolean);
        const flat = [];
        const flatten = (o) => { if (Array.isArray(o)) return o.forEach(flatten); if (o && typeof o === 'object') { flat.push(o); for (const v of Object.values(o)) flatten(v); } };
        blobs.forEach(flatten);
        const isBookType = (t) => typeof t === 'string' && /\bBook\b/i.test(t);
        const bookObj = flat.find(o => o && (isBookType(o['@type']) || (Array.isArray(o['@type']) && o['@type'].some(isBookType))));
        if (bookObj) {
          const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
          const fmtISO = (iso) => {
            const m = String(iso||'').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
            if (!m) return null; const [,y,mm,dd]=m;
            if (y && mm && dd) return `${monthNames[+mm-1]} ${+dd}, ${y}`;
            if (y && mm) return `${monthNames[+mm-1]} ${y}`;
            return y || null;
          };
          const dateText = fmtISO(clean(bookObj.datePublished));
          let publisherName = null;
          const pub = bookObj.publisher;
          if (typeof pub === 'string') publisherName = clean(pub);
          else if (pub && typeof pub === 'object') {
            publisherName = Array.isArray(pub)
              ? clean(pub.find(p => p && (p.name || typeof p === 'string'))?.name || pub.find(p => typeof p === 'string'))
              : clean(pub.name);
          }
          if (dateText && publisherName) publishedfull = `${dateText} by ${publisherName}`;
          else if (dateText) publishedfull = dateText;
        }
      } catch {}

      // Ensure details had a chance to open
      await Promise.race([openDetails, delay(700)]);

      const [originaltitleRaw, publishedCandidates] = await Promise.all([
        getText(page.locator('dt:has-text("Original title") + dd [data-testid="contentContainer"]'), 4000)
          .then(v => v ?? getText(page.locator('dt:has-text("Original title") + dd'), 3500)),
        publishedfull ? Promise.resolve([]) : page.locator('dt:has-text("Published") + dd').allTextContents().catch(() => []),
      ]);

      if (!publishedfull && publishedCandidates?.length) {
        const cleaned = publishedCandidates.map(t => clean(t)).filter(Boolean).filter(t => !/^First published/i.test(t));
        const withBy = cleaned.find(t => /\sby\s/i.test(t));
        publishedfull = withBy || cleaned[cleaned.length - 1] || null;
      }

      if (!publishedfull) {
        try {
          const txt = await page.locator('body').innerText();
          const hit = (txt || '').split('\n').map(s => s.trim()).find(l => /[A-Za-z]+\s+\d{1,2},\s*\d{4}\s+by\s+.+/i.test(l));
          if (hit) {
            const m = hit.match(/([A-Za-z]+\s+\d{1,2},\s*\d{4}\s+by\s+.+)$/i);
            if (m && m[1]) publishedfull = m[1].replace(/[•·]\s*.*$/, '').trim();
          }
        } catch {}
      }

      const details = {
        isbn,
        title: title || null,
        subtitle,
        originaltitle: originaltitleRaw || null,
        author: author || null,
        cover: clean(ogCover) || null,
        avgRating: (() => { const n = parseFloat(ratingValue); return Number.isNaN(n) ? undefined : n; })(),
        ratingCount: (() => { const rc = parseInt((ratingsCountText||'').replace(/\D/g,''), 10); return Number.isNaN(rc) ? undefined : rc; })(),
        description: descriptionRaw?.replace(/\s*\.{3}\s*more\s*$/i, '').trim() || null,
        category: (() => {
          const cleanedGenres = (genres||[]).map(g => clean(g)).filter(Boolean).filter(g => !/^\.\.\.more$/i.test(g));
          return cleanedGenres.length ? cleanedGenres.join(', ') : undefined;
        })(),
        language: language || null,
        series: seriesText ? seriesText.replace(/\s*\(#\d+\.?\d*\)$/, '').trim() : undefined,
        publishedfull: publishedfull || null,
      };

      await ctx.close();
      return details;
    } catch (err) {
      try { if (ctx) await ctx.close(); } catch {}
      if (attempt === 2) throw err;
      // Reset and retry once
      try { if (browserRef) await browserRef.close(); } catch {}
      browserRef = null;
      await delay(400);
    }
  }
}
