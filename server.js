'use strict';

const express   = require('express');
const PORT      = process.env.PORT || 3000;
const IS_RENDER = process.env.RENDER === 'true' || process.platform === 'linux';

const app = express();

// ─── Puppeteer seçimi (Stealth plugin ile) ────────────────────────────────────
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

let chromium;
if (IS_RENDER) {
    chromium = require('@sparticuz/chromium');
    // Render'da puppeteer-core kullan
    const puppeteerCore = require('puppeteer-core');
    puppeteerExtra.use(StealthPlugin());
    // puppeteer-extra'ya puppeteer-core'u bağla
    puppeteerExtra.connect = puppeteerCore.connect;
}

app.use(express.json({ limit: '2mb' }));

const SECRET_KEY = process.env.SCRAPER_SECRET || 'ozonmatrix-secret-2024';

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'ozon-scraper', version: '3.0.0-stealth', platform: process.platform });
});

// ─── Browser launch (Stealth) ─────────────────────────────────────────────────
async function launchBrowser(proxyUrl) {
    const baseArgs = IS_RENDER ? [...chromium.args] : [];
    const launchArgs = [
        ...baseArgs,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--lang=ru-RU,ru',
        // NOT eklemiyoruz --disable-blink-features=AutomationControlled — stealth halleder
    ];

    if (IS_RENDER) {
        launchArgs.push('--no-zygote', '--single-process');
    }

    if (proxyUrl) {
        try {
            const u = new URL(proxyUrl);
            launchArgs.push(`--proxy-server=${u.hostname}:${u.port}`);
        } catch (e) {
            console.warn('Invalid proxy_url:', e.message);
        }
    }

    const launchOptions = IS_RENDER
        ? {
            args:            launchArgs,
            executablePath:  await chromium.executablePath(),
            headless:        chromium.headless,
            defaultViewport: { width: 1366, height: 768 },
            ignoreHTTPSErrors: true,
          }
        : {
            args:            launchArgs,
            headless:        true,
            defaultViewport: { width: 1366, height: 768 },
            ignoreHTTPSErrors: true,
          };

    // Render'da puppeteer-core'un executable path'ini kullanmak için
    if (IS_RENDER) {
        launchOptions.executablePath = await chromium.executablePath();
    }

    return puppeteerExtra.launch(launchOptions);
}

// ─── Seller extraction from JSON ──────────────────────────────────────────────
function extractSellersFromJson(data) {
    const sellers = [];
    if (!data || typeof data !== 'object') return sellers;

    const sellerKeys = ['sellers', 'items', 'offers', 'otherSellers', 'sellerList', 'merchantList'];

    function parseItem(item, idx) {
        if (!item || typeof item !== 'object') return null;
        const name = item.name || item.sellerName || item.title ||
                     (item.seller && item.seller.name) || item.merchantName || null;
        const priceRaw = parseFloat(
            item.price || item.currentPrice || item.finalPrice ||
            item.priceRub || (item.cellTrackingInfo && item.cellTrackingInfo.price) || 0
        );
        if (!name || priceRaw <= 0) return null;

        let priceRub, priceUsd;
        if (priceRaw < 500) {
            priceUsd = Math.round(priceRaw * 100) / 100;
            priceRub = Math.round(priceUsd / 0.011);
        } else {
            priceRub = Math.round(priceRaw);
            priceUsd = Math.round(priceRub * 0.011 * 100) / 100;
        }
        return {
            seller_name:   String(name).trim(),
            seller_id:     String(item.id || item.sellerId || (item.seller && item.seller.id) || ''),
            price_rub:     priceRub,
            price_usd:     priceUsd,
            delivery_days: parseInt(item.deliveryDays || item.delivery_days || 0),
            delivery_text: item.deliveryText || item.delivery_text || '',
            delivery_type: 'plane',
            seller_url:    item.link || item.url || item.sellerUrl || '',
            is_buybox:     idx === 0,
        };
    }

    function recurse(obj, depth = 0) {
        if (depth > 8 || sellers.length > 50) return;
        if (Array.isArray(obj)) {
            obj.forEach(item => {
                const s = parseItem(item, sellers.length);
                if (s) sellers.push(s);
                else recurse(item, depth + 1);
            });
            return;
        }
        if (typeof obj !== 'object' || obj === null) return;
        for (const key of sellerKeys) {
            if (Array.isArray(obj[key]) && obj[key].length > 0) {
                obj[key].forEach(item => {
                    const s = parseItem(item, sellers.length);
                    if (s) sellers.push(s);
                });
                if (sellers.length > 0) return;
            }
        }
        for (const val of Object.values(obj)) {
            if (typeof val === 'object' && val !== null) {
                recurse(val, depth + 1);
                if (sellers.length > 0) return;
            }
        }
    }

    recurse(data);
    return sellers;
}

// ─── Core scrape ──────────────────────────────────────────────────────────────
async function scrapeProduct(product_id, ozon_cookie, proxy_url) {
    const startTime = Date.now();
    let browser = null;
    const capturedSellers = [];
    let pageSnippet = '';
    let finalUrl = '';

    try {
        browser = await launchBrowser(proxy_url);
        const page = await browser.newPage();

        // Stealth modda ek UA ayarları
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8' });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        );

        // Proxy auth
        if (proxy_url) {
            try {
                const u = new URL(proxy_url);
                if (u.username && u.password) {
                    await page.authenticate({
                        username: decodeURIComponent(u.username),
                        password: decodeURIComponent(u.password),
                    });
                }
            } catch (e) {}
        }

        // ─── XHR/Fetch response yakalay ───────────────────────────────────────
        page.on('response', async (response) => {
            const url = response.url();
            if (!url.includes('ozon.ru')) return;
            if (response.status() !== 200) return;
            const ct = response.headers()['content-type'] || '';
            if (!ct.includes('json')) return;

            try {
                const json = await response.json().catch(() => null);
                if (!json) return;

                // widgetStates
                const ws = json.widgetStates || {};
                for (const val of Object.values(ws)) {
                    try {
                        const data = typeof val === 'string' ? JSON.parse(val) : val;
                        const found = extractSellersFromJson(data);
                        found.forEach(s => {
                            const key = s.seller_name + '_' + s.price_rub;
                            if (!capturedSellers.find(x => x.seller_name + '_' + x.price_rub === key)) {
                                capturedSellers.push(s);
                            }
                        });
                    } catch (e) {}
                }

                // root level
                const rootFound = extractSellersFromJson(json);
                rootFound.forEach(s => {
                    const key = s.seller_name + '_' + s.price_rub;
                    if (!capturedSellers.find(x => x.seller_name + '_' + x.price_rub === key)) {
                        capturedSellers.push(s);
                    }
                });
            } catch (e) {}
        });

        // Cookie set
        if (ozon_cookie) {
            const cookieObjs = [];
            for (const pair of ozon_cookie.split(';').map(s => s.trim()).filter(Boolean)) {
                const idx  = pair.indexOf('=');
                if (idx < 0) continue;
                const name  = pair.substring(0, idx).trim();
                const value = pair.substring(idx + 1).trim();
                cookieObjs.push({
                    name, value, domain: '.ozon.ru', path: '/',
                    httpOnly: name.startsWith('__Secure-'),
                    secure:   name.startsWith('__Secure-'),
                });
            }
            if (cookieObjs.length > 0) await page.setCookie(...cookieObjs);
            console.log(`[${product_id}] ${cookieObjs.length} cookies set`);
        }

        const productUrl = `https://www.ozon.ru/product/${product_id}/`;
        const modalUrl   = `https://www.ozon.ru/modal/otherOffersFromSellers?product_id=${product_id}&sort=price`;

        // Ürün sayfasına git — ETC challenge çözülür
        console.log(`[${product_id}] Step 1: product page...`);
        await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));

        const step1Snippet = await page.evaluate(() => (document.body?.innerText || '').substring(0, 200));
        console.log(`[${product_id}] Step1 snippet: ${step1Snippet}`);

        // Modal sayfasına git
        console.log(`[${product_id}] Step 2: modal page...`);
        await page.goto(modalUrl, { waitUntil: 'networkidle2', timeout: 40000 });
        await new Promise(r => setTimeout(r, 4000));

        finalUrl    = page.url();
        pageSnippet = await page.evaluate(() => (document.body?.innerText || '').substring(0, 500));
        console.log(`[${product_id}] Final URL: ${finalUrl}`);
        console.log(`[${product_id}] Snippet: ${pageSnippet.substring(0, 300)}`);
        console.log(`[${product_id}] XHR sellers: ${capturedSellers.length}`);

        // DOM fallback
        if (capturedSellers.length === 0) {
            console.log(`[${product_id}] Trying DOM fallback...`);
            const domSellers = await page.evaluate(() => {
                const results = [], seen = {};
                const lines = (document.body.innerText || '')
                    .split('\n').map(l => l.trim()).filter(l => l.length > 1);
                const skip = ['перейти','доставим','доставка','в корзину','купить','отзыв','function','const ','let ','var '];
                const shouldSkip = s => skip.some(kw => s.toLowerCase().includes(kw));
                const clean = s => (s||'').replace(/[\s\u00A0\u202f]/g,'');

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const mRub = line.match(/([\d\s\u00A0\u202f]{2,10})\s*[₽]/u);
                    const mUsd = line.match(/([\d\s\u00A0\u202f]+[,.]\d{2})\s*\$/) || line.match(/([\d\s\u00A0\u202f]{1,8})\s*\$/);
                    let priceUsd=0, priceRub=0;
                    if (mRub) {
                        priceRub = parseInt(clean(mRub[1]),10);
                        if (!priceRub||priceRub<500||priceRub>5000000) continue;
                        priceUsd = Math.round(priceRub*0.011*100)/100;
                    } else if (mUsd) {
                        const raw = clean(mUsd[1]).replace(',','.');
                        priceUsd = parseFloat(raw);
                        if (!priceUsd||priceUsd<1||priceUsd>50000) continue;
                        priceRub = Math.round(priceUsd*90);
                    } else continue;

                    let sellerName = null;
                    for (let j=i-1; j>=Math.max(0,i-12); j--) {
                        const c=lines[j];
                        if(!c||c.length<2||c.length>80) continue;
                        if(/^[\d\s.,]+$/.test(c)) continue;
                        if(/[\d\s\u00A0]+\s*[₽$]/u.test(c)) continue;
                        if(shouldSkip(c)) continue;
                        sellerName=c; break;
                    }
                    if (!sellerName) continue;
                    const key = sellerName+'_'+priceUsd;
                    if (seen[key]) continue;
                    seen[key]=1;
                    results.push({ seller_name:sellerName.trim(), seller_id:'', price_rub:priceRub, price_usd:priceUsd, delivery_days:0, delivery_text:'', delivery_type:'plane', seller_url:location.href, is_buybox:results.length===0 });
                }
                return results;
            });
            domSellers.forEach(s => capturedSellers.push(s));
            console.log(`[${product_id}] DOM sellers: ${domSellers.length}`);
        }

        capturedSellers.sort((a,b) => a.price_usd - b.price_usd);
        if (capturedSellers.length > 0) capturedSellers[0].is_buybox = true;

        const elapsed = Date.now() - startTime;
        console.log(`[${product_id}] Done: ${capturedSellers.length} sellers in ${elapsed}ms`);

        return {
            success: true, product_id,
            sellers: capturedSellers, count: capturedSellers.length, elapsed_ms: elapsed,
            debug: { final_url: finalUrl, page_snippet: pageSnippet.substring(0, 300) },
        };

    } catch (err) {
        console.error(`[${product_id}] Error:`, err.message);
        return { success: false, product_id, error: err.message, sellers: [], count: 0, elapsed_ms: Date.now() - startTime };
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
    const { secret, product_id, ozon_cookie, proxy_url } = req.body;
    if (secret !== SECRET_KEY) return res.status(401).json({ error: 'Unauthorized' });
    if (!product_id) return res.status(400).json({ error: 'product_id required' });
    res.json(await scrapeProduct(product_id, ozon_cookie || '', proxy_url || ''));
});

app.post('/scrape-batch', async (req, res) => {
    const { secret, product_ids, ozon_cookie, proxy_url } = req.body;
    if (secret !== SECRET_KEY) return res.status(401).json({ error: 'Unauthorized' });
    if (!Array.isArray(product_ids) || product_ids.length === 0) return res.status(400).json({ error: 'product_ids array required' });
    const results = {};
    for (const pid of product_ids.slice(0, 10)) {
        results[pid] = await scrapeProduct(pid, ozon_cookie || '', proxy_url || '');
        await new Promise(r => setTimeout(r, 2000));
    }
    res.json({ success: true, results });
});

app.listen(PORT, () => console.log(`Ozon Scraper v3-stealth running on port ${PORT}`));
