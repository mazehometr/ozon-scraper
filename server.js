'use strict';

const express   = require('express');
const PORT      = process.env.PORT || 3000;
const IS_RENDER = process.env.RENDER === 'true' || process.platform === 'linux';
const app       = express();

// ─── Puppeteer + Stealth ──────────────────────────────────────────────────────
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

let chromium;
if (IS_RENDER) chromium = require('@sparticuz/chromium');

app.use(express.json({ limit: '2mb' }));

const SECRET_KEY = process.env.SCRAPER_SECRET || 'ozonmatrix-secret-2024';

app.get('/', (req, res) =>
    res.json({ status: 'ok', service: 'ozon-scraper', version: '4.0.0-fetch', platform: process.platform })
);

// ─── Browser launch ────────────────────────────────────────────────────────────
async function launchBrowser(proxyUrl) {
    const baseArgs = IS_RENDER ? [...chromium.args] : [];
    const args = [
        ...baseArgs,
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--no-first-run', '--lang=ru-RU,ru',
    ];
    if (IS_RENDER) args.push('--no-zygote', '--single-process');
    if (proxyUrl) {
        try { const u = new URL(proxyUrl); args.push(`--proxy-server=${u.hostname}:${u.port}`); } catch (e) {}
    }

    const opts = {
        args,
        headless:        IS_RENDER ? chromium.headless : true,
        defaultViewport: { width: 1366, height: 768 },
        ignoreHTTPSErrors: true,
    };
    if (IS_RENDER) opts.executablePath = await chromium.executablePath();

    return puppeteerExtra.launch(opts);
}

// ─── Seller parser ─────────────────────────────────────────────────────────────
function parseSellers(data) {
    const sellers = [];
    if (!data || typeof data !== 'object') return sellers;
    const keys = ['sellers','items','offers','otherSellers','sellerList','merchantList'];

    function parseItem(item, idx) {
        if (!item || typeof item !== 'object') return null;
        const name = item.name || item.sellerName || item.title ||
                     (item.seller && item.seller.name) || item.merchantName;
        const raw  = parseFloat(item.price || item.currentPrice || item.finalPrice ||
                     item.priceRub || (item.cellTrackingInfo && item.cellTrackingInfo.price) || 0);
        if (!name || raw <= 0) return null;
        const priceRub = raw < 500 ? Math.round(raw / 0.011) : Math.round(raw);
        const priceUsd = Math.round(priceRub * 0.011 * 100) / 100;
        return {
            seller_name: String(name).trim(),
            seller_id:   String(item.id || item.sellerId || (item.seller && item.seller.id) || ''),
            price_rub:   priceRub, price_usd: priceUsd,
            delivery_days: parseInt(item.deliveryDays || item.delivery_days || 0),
            delivery_text: item.deliveryText || '', delivery_type: 'plane',
            seller_url:    item.link || item.url || item.sellerUrl || '',
            is_buybox:     idx === 0,
        };
    }

    function recurse(obj, depth = 0) {
        if (depth > 8 || sellers.length > 50) return;
        if (Array.isArray(obj)) {
            obj.forEach(item => { const s = parseItem(item, sellers.length); if (s) sellers.push(s); else recurse(item, depth+1); });
            return;
        }
        if (typeof obj !== 'object' || obj === null) return;
        for (const key of keys) {
            if (Array.isArray(obj[key]) && obj[key].length > 0) {
                obj[key].forEach(item => { const s = parseItem(item, sellers.length); if (s) sellers.push(s); });
                if (sellers.length > 0) return;
            }
        }
        for (const val of Object.values(obj)) {
            if (typeof val === 'object' && val !== null) { recurse(val, depth+1); if (sellers.length > 0) return; }
        }
    }

    recurse(data);
    return sellers;
}

// ─── CORE: Ürün sayfasını aç, içinden fetch() ile modal verisini çek ───────────
async function scrapeProduct(product_id, ozon_cookie, proxy_url) {
    const t0 = Date.now();
    let browser = null;

    try {
        browser = await launchBrowser(proxy_url);
        const page = await browser.newPage();

        await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        );

        // Proxy auth
        if (proxy_url) {
            try {
                const u = new URL(proxy_url);
                if (u.username) await page.authenticate({
                    username: decodeURIComponent(u.username),
                    password: decodeURIComponent(u.password),
                });
            } catch (e) {}
        }

        // Cookie set
        if (ozon_cookie) {
            const objs = [];
            for (const pair of ozon_cookie.split(';').map(s => s.trim()).filter(Boolean)) {
                const i = pair.indexOf('=');
                if (i < 0) continue;
                const name = pair.substring(0, i).trim(), value = pair.substring(i+1).trim();
                objs.push({ name, value, domain: '.ozon.ru', path: '/',
                    httpOnly: name.startsWith('__Secure-'), secure: name.startsWith('__Secure-') });
            }
            if (objs.length) await page.setCookie(...objs);
            console.log(`[${product_id}] ${objs.length} cookies loaded`);
        }

        // ── Step 1: Ürün sayfasını aç (challenge bypass) ──────────────────────
        const productUrl = `https://www.ozon.ru/product/${product_id}/`;
        console.log(`[${product_id}] Loading product page...`);
        await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await new Promise(r => setTimeout(r, 3000));

        const step1 = await page.evaluate(() => (document.body?.innerText || '').substring(0, 300));
        const step1Url = page.url();
        console.log(`[${product_id}] Step1 URL: ${step1Url}`);
        console.log(`[${product_id}] Step1 snippet: ${step1.substring(0, 200)}`);

        const isBlocked = step1.toLowerCase().includes('нет соединения') ||
                          step1.toLowerCase().includes('пазл') ||
                          step1.toLowerCase().includes('captcha');

        if (isBlocked) {
            console.log(`[${product_id}] Product page blocked! Trying direct fetch from Ozon homepage...`);
            // Önce ozon ana sayfasını aç, daha az şüpheli
            await page.goto('https://www.ozon.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 4000));
        }

        // ── Step 2: Browser içinden fetch() ile modal API çağrısı ─────────────
        // Bu sayfanın JavaScript context'inden yapıldığı için cookie ve session
        // otomatik gönderilir, challenge tetiklenmez
        console.log(`[${product_id}] Fetching modal API from browser context...`);
        const modalPath = `/modal/otherOffersFromSellers?product_id=${product_id}&sort=price`;
        const apiPath   = `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(modalPath)}`;

        const apiResult = await page.evaluate(async (path) => {
            try {
                const resp = await fetch(path, {
                    method: 'GET',
                    credentials: 'include',
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Accept-Language': 'ru-RU,ru;q=0.9',
                        'x-o3-app-name': 'ozon-front',
                        'x-o3-app-version': '3.241.0',
                        'x-o3-device-type': 'desktop',
                    },
                });
                return {
                    status: resp.status,
                    ok:     resp.ok,
                    body:   await resp.text(),
                };
            } catch (e) {
                return { error: e.message };
            }
        }, apiPath);

        console.log(`[${product_id}] Fetch status: ${apiResult.status || 'error'}, body size: ${(apiResult.body || '').length}`);
        if (apiResult.error) console.log(`[${product_id}] Fetch error: ${apiResult.error}`);

        let sellers = [];

        if (apiResult.ok && apiResult.body) {
            try {
                const json = JSON.parse(apiResult.body);
                // widgetStates'den çek
                const ws = json.widgetStates || {};
                for (const val of Object.values(ws)) {
                    try {
                        const d = typeof val === 'string' ? JSON.parse(val) : val;
                        parseSellers(d).forEach(s => sellers.push(s));
                    } catch (e) {}
                }
                if (sellers.length === 0) {
                    parseSellers(json).forEach(s => sellers.push(s));
                }
                console.log(`[${product_id}] API sellers: ${sellers.length}`);
            } catch (e) {
                console.log(`[${product_id}] JSON parse error: ${e.message}`);
                console.log(`[${product_id}] Body snippet: ${(apiResult.body || '').substring(0, 300)}`);
            }
        }

        // ── Step 3: Modal sayfasına navigate et (fallback) ────────────────────
        if (sellers.length === 0) {
            console.log(`[${product_id}] API empty, navigating to modal page...`);
            const captured = [];
            page.on('response', async (response) => {
                if (!response.url().includes('ozon.ru') || response.status() !== 200) return;
                const ct = response.headers()['content-type'] || '';
                if (!ct.includes('json')) return;
                try {
                    const json = await response.json().catch(() => null);
                    if (!json) return;
                    const ws = json.widgetStates || {};
                    for (const val of Object.values(ws)) {
                        try { parseSellers(typeof val === 'string' ? JSON.parse(val) : val).forEach(s => captured.push(s)); } catch (e) {}
                    }
                    parseSellers(json).forEach(s => captured.push(s));
                } catch (e) {}
            });

            await page.goto(`https://www.ozon.ru${modalPath}`, { waitUntil: 'networkidle2', timeout: 40000 });
            await new Promise(r => setTimeout(r, 3000));

            const finalSnippet = await page.evaluate(() => (document.body?.innerText || '').substring(0, 300));
            console.log(`[${product_id}] Modal snippet: ${finalSnippet.substring(0, 200)}`);
            captured.forEach(s => sellers.push(s));
            console.log(`[${product_id}] XHR sellers: ${captured.length}`);
        }

        // Deduplicate & sort
        const seen = {};
        const unique = sellers.filter(s => {
            const k = s.seller_name + '_' + s.price_rub;
            if (seen[k]) return false;
            seen[k] = true;
            return true;
        });
        unique.sort((a, b) => a.price_usd - b.price_usd);
        if (unique.length > 0) unique[0].is_buybox = true;

        const elapsed = Date.now() - t0;
        console.log(`[${product_id}] Final: ${unique.length} sellers in ${elapsed}ms`);
        return { success: true, product_id, sellers: unique, count: unique.length, elapsed_ms: elapsed,
                 debug: { step1_snippet: step1.substring(0, 200), api_status: apiResult.status } };

    } catch (err) {
        console.error(`[${product_id}] Error:`, err.message);
        return { success: false, product_id, error: err.message, sellers: [], count: 0, elapsed_ms: Date.now() - t0 };
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
    if (!Array.isArray(product_ids) || !product_ids.length) return res.status(400).json({ error: 'product_ids array required' });
    const results = {};
    for (const pid of product_ids.slice(0, 10)) {
        results[pid] = await scrapeProduct(pid, ozon_cookie || '', proxy_url || '');
        await new Promise(r => setTimeout(r, 2000));
    }
    res.json({ success: true, results });
});

app.listen(PORT, () => console.log(`Ozon Scraper v4-fetch on port ${PORT}`));
