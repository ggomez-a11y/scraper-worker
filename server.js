import express from 'express';
import { chromium } from 'playwright';

const app = express();

// health check
app.get('/', (_req, res) => res.send('OK - scraper server running'));

// GET /scrape?isbn=9781847399960
app.get('/scrape', async (req, res) => {
  const isbn = String(req.query.isbn || '').trim();
  if (!isbn) return res.status(400).json({ error: 'Missing ?isbn=' });

  try {
    const data = await runScrape(isbn);
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`server listening on port ${PORT}`));

// ------------ scraper ------------
async function runScrape(isbn) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const clean = (s) => (s ? String(s).replace(/\s+/g, ' ').trim() : null);
  const month = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const fmtISO = (iso) => {
    const m = String(iso||'').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
    if (!m) return null; const [,y,mm,dd]=m;
    if (y && mm && dd) return `${month[+mm-1]} ${+dd}, ${y}`;
    if (y && mm) return `${month[+mm-1]} ${y}`;
    return y || null;
  };

  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (/\.(css|jpg|jpeg|png|svg|gif|woff2?)($|\?)/i.test(url)) route.abort();
    else route.continue();
  });

  try {
    await page.goto(`https://www.goodreads.com/search?q=${encodeURIComponent(isbn)}`, { timeout: 15000, waitUntil: 'domcontentloaded' });
    try { await page.locator('[class*="Overlay__close"], button[aria-label="Close"]').first().click({ timeout: 3500 }); } catch {}

    if (!page.url().includes('/book/show/')) {
      const first = page.locator('a[href*="/book/show/"]:not([href*="/reviews"])').first();
      await first.waitFor({ state: 'visible', timeout: 7000 });
      await first.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 9000 });
    }

    // open details in background
    const openDetails = (async () => {
      const vis = await page.locator('dt:has-text("Original title") + dd, dt:has-text("Published") + dd, [data-testid="bookDetails"]').first().isVisible().catch(() => false);
      if (vis) return true;
      const labels = [/book details & editions/i,/book details and editions/i,/book details/i,/details/i,/editions/i];
      for (const rx of labels) {
        const btn = page.locator('button', { hasText: rx }).first();
        try {
          await btn.waitFor({ state: 'visible', timeout: 700 });
          await btn.click({ timeout: 500 });
          await page.waitForTimeout(300);
          const opened = await Promise.race([
            page.waitForSelector('[data-testid="bookDetails"]', { timeout: 600 }).then(() => true).catch(() => false),
            page.waitForSelector('dt:has-text("Published") + dd', { timeout: 600 }).then(() => true).catch(() => false),
            page.waitForSelector('dt:has-text("Original title") + dd', { timeout: 600 }).then(() => true).catch(() => false),
          ]);
          if (opened) return true;
        } catch {}
      }
      return false;
    })();

    const [
      title, author, ratingValue, ratingsCountText, descriptionRaw, genres,
      formatText, language, seriesText, ogCover, ldjsonScripts,
      sub1, sub2, sub3, sub4
    ] = await Promise.all([
      page.locator('h1[data-testid="bookTitle"]').textContent({ timeout: 900 }).catch(() => null),
      page.locator('.ContributorLink__name').first().textContent({ timeout: 900 }).catch(() => null),
      page.locator('.RatingStatistics__rating').first().textContent({ timeout: 800 }).catch(() => null),
      page.locator('[data-testid="ratingsCount"]').first().textContent({ timeout: 800 }).catch(() => null),
      page.locator('[data-testid="description"] [data-testid="contentContainer"]').first().textContent({ timeout: 900 }).catch(() => null),
      page.locator('[data-testid="genresList"] .Button__labelItem').allTextContents().catch(() => []),
      page.locator('dt:has-text("Format") + dd').textContent({ timeout: 700 }).catch(() => null),
      page.locator('dt:has-text("Language") + dd').textContent({ timeout: 700 }).catch(() => null),
      page.locator('dt:has-text("Series") + dd a').textContent({ timeout: 700 }).catch(() => null),
      page.locator('meta[property="og:image"]').getAttribute('content').catch(() => null),
      page.locator('script[type="application/ld+json"]').allTextContents().catch(() => []),
      page.locator('[data-testid="bookSubtitle"]').textContent({ timeout: 600 }).catch(() => null),
      page.locator('.BookPageTitleSection__subtitle').textContent({ timeout: 600 }).catch(() => null),
      page.locator('.BookPageTitleSection__title h3').first().textContent({ timeout: 600 }).catch(() => null),
      page.locator('[data-testid="bookPageTitleSection"] h3').first().textContent({ timeout: 600 }).catch(() => null),
    ]);

    let subtitle = (s => s && s.trim())(sub1) || (s => s && s.trim())(sub2) || (s => s && s.trim())(sub3) || (s => s && s.trim())(sub4);

    // JSON-LD → publishedfull
    let publishedfull = null;
    try {
      const blobs = (ldjsonScripts || []).map(t => { try { return JSON.parse(t); } catch { return null; } }).filter(Boolean);
      const flat = []; const flatten = (o) => { if (Array.isArray(o)) return o.forEach(flatten); if (o && typeof o === 'object') { flat.push(o); for (const v of Object.values(o)) flatten(v); } };
      blobs.forEach(flatten);
      const isBookType = (t) => typeof t === 'string' && /\bBook\b/i.test(t);
      const bookObj = flat.find(o => o && (isBookType(o['@type']) || (Array.isArray(o['@type']) && o['@type'].some(isBookType))));
      if (bookObj) {
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

    await Promise.race([openDetails, new Promise(r => setTimeout(r, 1000))]);

    const [originaltitleRaw, publishedCandidates] = await Promise.all([
      page.locator('dt:has-text("Original title") + dd [data-testid="contentContainer"]').textContent({ timeout: 800 })
        .catch(() => page.locator('dt:has-text("Original title") + dd').textContent({ timeout: 700 }).catch(() => null)),
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
      title: clean(title),
      subtitle: subtitle || null,
      originaltitle: clean(originaltitleRaw) || null,
      author: clean(author),
      cover: clean(ogCover) || null,
      avgRating: (() => { const n = parseFloat(ratingValue); return Number.isNaN(n) ? undefined : n; })(),
      ratingCount: (() => { const rc = parseInt((ratingsCountText||'').replace(/\D/g,''), 10); return Number.isNaN(rc) ? undefined : rc; })(),
      description: clean(descriptionRaw)?.replace(/\s*\.{3}\s*more\s*$/i, '').trim() || null,
      category: (() => {
        const cleanedGenres = (genres||[]).map(g => clean(g)).filter(Boolean).filter(g => !/^\.\.\.more$/i.test(g));
        return cleanedGenres.length ? cleanedGenres.join(', ') : undefined;
      })(),
      language: clean(language),
      series: seriesText ? seriesText.replace(/\s*\(#\d+\.?\d*\)$/, '').trim() : undefined,
      publishedfull: clean(publishedfull),
    };

    await browser.close();
    return details;
  } catch (err) {
    try { await browser.close(); } catch {}
    throw err;
  }
}
