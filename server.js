'use strict';

const express   = require('express');
const PORT      = process.env.PORT || 3000;
const IS_RENDER = process.env.RENDER === 'true' || process.platform === 'linux';

const app = express();

// ─── Ortama göre Puppeteer seç ───────────────────────────────────────────────
// Windows (lokal test): normal puppeteer (kendi Chromium'unu indirir)
// Linux/Render.com    : puppeteer-core + @sparticuz/chromium (hafif, bulut uyumlu)
let puppeteer, chromium;
if (IS_RENDER) {
    puppeteer = require('puppeteer-core');
    chromium  = require('@sparticuz/chromium');
} else {
    puppeteer = require('puppeteer');
    chromium  = null;
}

app.use(express.json({ limit: '2mb' }));

// ─── Secret key — PHP servisten gönderilmeli ────────────────────────────────
const SECRET_KEY = process.env.SCRAPER_SECRET || 'ozonmatrix-secret-2024';

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'ozon-scraper', version: '1.0.0', platform: process.platform });
});

// ─── Ana scrape endpoint ──────────────────────────────────────────────────────
// POST /scrape
// Body: {
//   secret: string,
//   product_id: string,        // Ozon public product ID (e.g. "1492350830")
//   ozon_cookie: string,       // Ozon session cookie string
//   proxy_url?: string         // "http://user:pass@host:port" (opsiyonel)
// }
app.post('/scrape', async (req, res) => {
    const { secret, product_id, ozon_cookie, proxy_url } = req.body;

    // Auth kontrolü
    if (secret !== SECRET_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!product_id) {
        return res.status(400).json({ error: 'product_id required' });
    }

    const startTime = Date.now();
    let browser = null;

    try {
        // ─── Puppeteer launch ──────────────────────────────────────────────
        const baseArgs = IS_RENDER ? [...chromium.args] : [];
        const launchArgs = [
            ...baseArgs,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--lang=ru-RU,ru',
            '--disable-blink-features=AutomationControlled',
        ];

        // Linux/Render: ek optimize argümanlar
        if (IS_RENDER) {
            launchArgs.push('--no-zygote', '--single-process');
        }

        // Proxy varsa ekle
        if (proxy_url) {
            try {
                const u = new URL(proxy_url);
                launchArgs.push(`--proxy-server=${u.hostname}:${u.port}`);
            } catch (e) {
                console.warn('Invalid proxy_url, skipping proxy:', e.message);
            }
        }

        const launchOptions = IS_RENDER
            ? {
                args:            launchArgs,
                executablePath:  await chromium.executablePath(),
                headless:        chromium.headless,
                defaultViewport: { width: 1280, height: 900 },
            }
            : {
                args:            launchArgs,
                headless:        true,   // Windows'ta headless
                defaultViewport: { width: 1280, height: 900 },
            };

        browser = await puppeteer.launch(launchOptions);


        const page = await browser.newPage();

        // ─── Anti-bot: gerçek tarayıcı gibi görün ─────────────────────────
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        });

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        );

        // Otomasyon tespitini engelle
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
        });

        // ─── Proxy auth (varsa) ────────────────────────────────────────────
        if (proxy_url) {
            try {
                const u = new URL(proxy_url);
                if (u.username && u.password) {
                    await page.authenticate({
                        username: decodeURIComponent(u.username),
                        password: decodeURIComponent(u.password),
                    });
                }
            } catch (e) { /* ignore */ }
        }

        // ─── Ozon cookie'yi set et ─────────────────────────────────────────
        if (ozon_cookie) {
            const cookiePairs = ozon_cookie.split(';').map(s => s.trim()).filter(Boolean);
            const cookieObjs  = [];
            for (const pair of cookiePairs) {
                const idx  = pair.indexOf('=');
                if (idx < 0) continue;
                const name  = pair.substring(0, idx).trim();
                const value = pair.substring(idx + 1).trim();
                cookieObjs.push({
                    name,
                    value,
                    domain: '.ozon.ru',
                    path: '/',
                    httpOnly: name.startsWith('__Secure-'),
                    secure:   name.startsWith('__Secure-'),
                });
            }
            await page.setCookie(...cookieObjs);
        }

        // ─── Sayfayı aç — önce ürün sayfası, sonra modal ─────────────────
        const productUrl = `https://www.ozon.ru/product/${product_id}/`;
        const modalUrl   = `https://www.ozon.ru/modal/otherOffersFromSellers?product_id=${product_id}&sort=price`;

        console.log(`[${product_id}] Opening: ${modalUrl}`);

        // Önce ürün sayfasına git (cookie'leri yerleştirir, ETC challenge çözülür)
        await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

        // Kısa bekle (challenge çözülsün)
        await new Promise(r => setTimeout(r, 1500));

        // Şimdi modal sayfasına git
        await page.goto(modalUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // Render için bekle
        await new Promise(r => setTimeout(r, 2000));

        // ─── Veriyi çek — JS ile parse et (bookmarklet mantığı) ───────────
        // Debug: mevcut URL ve sayfa özeti al
        const currentUrl  = page.url();
        const pageSnippet = await page.evaluate(() => (document.body.innerText || '').substring(0, 500));
        console.log(`[${product_id}] Current URL: ${currentUrl}`);
        console.log(`[${product_id}] Page snippet: ${pageSnippet.substring(0, 200)}`);

        const sellers = await page.evaluate(() => {

            const sellers = [];
            const seen    = {};

            const lines = (document.body.innerText || '')
                .split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 0);

            const skipWords = [
                'перейти', 'доставим', 'доставка', 'доставить',
                'ниже цена', 'быстрее', 'в корзину', 'купить',
                'отзыв', 'оценк', 'рейтинг', 'подробнее',
                'javascript', 'function', 'const ', 'let ', 'var ',
            ];

            function shouldSkip(s) {
                const sl = s.toLowerCase();
                for (const kw of skipWords) {
                    if (sl.includes(kw)) return true;
                }
                return false;
            }

            function cleanNum(s) {
                return (s || '').replace(/[\s\u00A0\u200f\u202f]/g, '');
            }

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                // USD fiyat
                const mUsd = line.match(/([\d\s\u00A0\u202f]+[,.]\d{2})\s*\$/)
                          || line.match(/([\d\s\u00A0\u202f]{1,8})\s*\$/);

                // RUB fiyat
                const mRub = line.match(/([\d\s\u00A0\u202f]{2,10})\s*(?:[₽]|руб|р\.)/ui);

                let priceUsd = 0, priceRub = 0;

                if (mUsd) {
                    const raw = cleanNum(mUsd[1]).replace(',', '.');
                    priceUsd  = parseFloat(raw);
                    if (!priceUsd || priceUsd < 1 || priceUsd > 50000) continue;
                    priceRub  = Math.round(priceUsd * 90);
                } else if (mRub) {
                    const raw = cleanNum(mRub[1]);
                    priceRub  = parseInt(raw, 10);
                    if (!priceRub || priceRub < 500 || priceRub > 5000000) continue;
                    priceUsd  = Math.round(priceRub * 0.011 * 100) / 100;
                } else {
                    continue;
                }

                // Satıcı adını fiyatın ÜSTÜNDEN bul
                let sellerName = null;
                for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
                    const c = lines[j];
                    if (!c || c.length < 2) continue;
                    if (/^[\d\s.,]+$/.test(c)) continue;
                    if (/[\d\s\u00A0\u202f]+\s*\$/.test(c)) continue;
                    if (/[\d\s\u00A0\u202f]+\s*(?:[₽]|руб|р\.)/i.test(c)) continue;
                    if (shouldSkip(c)) continue;
                    if (/^[\d\s★☆.()\-+%@#]+$/.test(c)) continue;
                    if (c.length > 80) continue;
                    sellerName = c;
                    break;
                }
                if (!sellerName) continue;

                // Teslimat bilgisi
                let deliveryDays = 0, deliveryText = '', deliveryType = 'plane';
                for (let k = i + 1; k < Math.min(lines.length, i + 8); k++) {
                    const dLine  = lines[k];
                    const dMatch = dLine.match(/доставим\s+([\d]{1,2}\s+[а-яА-Яa-zA-Z]+)/i)
                                || dLine.match(/доставк[аи]\s+([\d]{1,2}\s+[а-яА-Яa-zA-Z]+)/i);
                    if (dMatch) {
                        const months = {
                            'января': 'Ocak', 'февраля': 'Şubat', 'марта': 'Mart',
                            'апреля': 'Nisan', 'мая': 'Mayıs', 'июня': 'Haziran',
                            'июля': 'Temmuz', 'августа': 'Ağustos', 'сентября': 'Eylül',
                            'октября': 'Ekim', 'ноября': 'Kasım', 'декабря': 'Aralık',
                        };
                        let dt = dMatch[1].trim();
                        for (const [ru, tr] of Object.entries(months)) {
                            if (dt.toLowerCase().includes(ru)) {
                                dt = dt.replace(new RegExp(ru, 'gi'), tr);
                                break;
                            }
                        }
                        deliveryText = dt;
                        const dd  = parseInt(dMatch[1], 10);
                        const now = new Date().getDate();
                        deliveryDays = dd >= now ? dd - now : dd + 30 - now;
                        if (deliveryDays < 1) deliveryDays = 1;
                        const rawLower = dMatch[1].toLowerCase();
                        if (rawLower.includes('сентября') || deliveryDays > 15) {
                            deliveryType = 'truck';
                        }
                        break;
                    }
                }

                const key = sellerName.trim() + '_' + priceUsd;
                if (seen[key]) continue;
                seen[key] = 1;

                sellers.push({
                    seller_name:   sellerName.trim(),
                    seller_id:     '',
                    price_rub:     priceRub,
                    price_usd:     priceUsd,
                    delivery_days: deliveryDays,
                    delivery_text: deliveryText,
                    delivery_type: deliveryType,
                    seller_url:    location.href,
                    is_buybox:     sellers.length === 0,
                });
            }

            return sellers;
        });

        // Sıralama
        sellers.sort((a, b) => a.price_usd - b.price_usd);
        if (sellers.length > 0) sellers[0].is_buybox = true;

        const elapsed = Date.now() - startTime;
        console.log(`[${product_id}] Found ${sellers.length} sellers in ${elapsed}ms`);

        res.json({
            success:    true,
            product_id,
            sellers,
            count:      sellers.length,
            elapsed_ms: elapsed,
        });

    } catch (err) {
        console.error(`[${product_id}] Error:`, err.message);
        res.status(500).json({
            success:    false,
            product_id,
            error:      err.message,
            sellers:    [],
        });
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
});

// ─── Batch endpoint — birden fazla ürün ──────────────────────────────────────
// POST /scrape-batch
// Body: { secret, product_ids: ["id1","id2",...], ozon_cookie, proxy_url }
app.post('/scrape-batch', async (req, res) => {
    const { secret, product_ids, ozon_cookie, proxy_url } = req.body;

    if (secret !== SECRET_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!Array.isArray(product_ids) || product_ids.length === 0) {
        return res.status(400).json({ error: 'product_ids array required' });
    }

    // En fazla 10 ürün aynı anda
    const ids     = product_ids.slice(0, 10);
    const results = {};

    for (const pid of ids) {
        try {
            // Her ürün için tek tek çek (aynı tarayıcıyı paylaşmak yerine yeni açmak daha güvenli)
            const response = await fetch(`http://localhost:${PORT}/scrape`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ secret, product_id: pid, ozon_cookie, proxy_url }),
            });
            results[pid] = await response.json();
        } catch (e) {
            results[pid] = { success: false, error: e.message, sellers: [] };
        }
        // Rate limit: ürünler arası 2sn bekle
        await new Promise(r => setTimeout(r, 2000));
    }

    res.json({ success: true, results });
});

app.listen(PORT, () => {
    console.log(`Ozon Scraper Service running on port ${PORT}`);
});
