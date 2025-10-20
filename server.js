import express from "express";
import { chromium } from "playwright";
import { setTimeout as delay } from "timers/promises";

const app = express();

// ✅ Allow your website to call this server (CORS fix)
const corsMiddleware = (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
};
app.use(corsMiddleware);

// --- Warmup route ---
app.get("/warmup", async (req, res) => {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    res.json({ success: true, message: "Chromium launched successfully (warm)" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Scraper route ---
app.get("/scrape", async (req, res) => {
  const isbn = req.query.isbn;
  if (!isbn) return res.status(400).json({ error: "Missing ISBN parameter" });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const data = { isbn };

  try {
    console.log("Processing page for ISBN:", isbn);
    await page.goto(`https://www.goodreads.com/search?q=${isbn}`, { timeout: 60000 });
    await page.waitForSelector(".bookTitle", { timeout: 20000 });

    await page.click(".bookTitle");
    await page.waitForTimeout(4000);

    data.title = await page.textContent("h1.Text__title1");
    data.subtitle = await page.textContent("h2.Text__title2, .BookPageTitleSection__title");
    data.originaltitle = await page.textContent("div[data-testid='bookTitle']");
    data.author = await page.textContent(".ContributorLink__name");
    data.cover = await page.getAttribute("img[data-testid='coverImage']", "src");
    data.avgRating = parseFloat(await page.textContent("div[data-testid='rating']")) || null;
    data.ratingCount = parseInt(await page.textContent("div[data-testid='ratingsCount']")?.replace(/\D/g, "")) || null;
    data.description = await page.textContent("div[data-testid='description']") || null;
    data.category = (await page.textContent("a.BookPageMetadataSection__genreButton")) || null;
    data.language = await page.textContent("div[data-testid='bookDetails'] span:has-text('Language') + span") || "English";
    data.series = await page.textContent("h3.Text__title3, a[data-testid='seriesLink']") || null;
    data.format = await page.textContent("span[data-testid='format']") || "Paperback";
    data.pageCount = parseInt(await page.textContent("span[data-testid='pagesFormat']")?.replace(/\D/g, "")) || null;
    data.publishedfull = await page.textContent("p[data-testid='publicationInfo']");

    console.log("--- Final Data ---", data);
    res.json(data);
  } catch (error) {
    console.error("Error during scrape:", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    await browser.close();
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`server listening on http://0.0.0.0:${PORT}`));
