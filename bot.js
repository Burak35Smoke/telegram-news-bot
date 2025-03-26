const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // Gemini'ı geri ekle
const Parser = require('rss-parser');
const cron = require('node-cron');
require('dotenv').config();

// --- Ayarlar ---
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY; // Gemini anahtarını al
const targetChatId = process.env.TARGET_CHAT_ID;
const cronSchedule = process.env.CRON_SCHEDULE || '*/15 * * * *';
const newsCount = parseInt(process.env.NEWS_COUNT || '5', 10);
const geminiModelName = "gemini-1.5-pro-latest"; // Veya uygun güncel model
const timezone = "Europe/Istanbul";

// --- Kontroller ---
if (!telegramToken || !geminiApiKey || !targetChatId) {
    console.error('Hata: Lütfen .env dosyasında TELEGRAM_BOT_TOKEN, GEMINI_API_KEY ve TARGET_CHAT_ID değişkenlerini tanımlayın.');
    process.exit(1);
}
if (!cron.validate(cronSchedule)) {
    console.error(`Hata: Geçersiz CRON deseni: "${cronSchedule}".`);
    process.exit(1);
}
if (!targetChatId.match(/^-?\d+$/)) {
     console.error(`Hata: Geçersiz TARGET_CHAT_ID: "${targetChatId}". Bir sayı veya negatif sayı olmalıdır.`);
     process.exit(1);
 }

// --- Kütüphane Başlatmaları ---
console.log("Telegram Bot başlatılıyor...");
const bot = new TelegramBot(telegramToken); // Polling'e gerek yok

console.log("Google AI İstemcisi başlatılıyor...");
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ model: geminiModelName });
console.log(`Google AI Modeli (${geminiModelName}) kullanıma hazır.`);

const rssParser = new Parser({
    timeout: 15000, // RSS çekme zaman aşımı (ms)
    headers: {'User-Agent': 'TelegramNewsBot/1.0'},
});
console.log("RSS Parser hazır.");
console.log(`Hedef Sohbet ID: ${targetChatId}`);
console.log(`Zamanlama: ${cronSchedule} (${timezone})`);
console.log(`Haber Sayısı: ${newsCount}`);
console.warn(`UYARI: Her "${cronSchedule}" çalıştığında Gemini API'den RSS URL'si istenecektir. Bu, API kullanımını/maliyetini artırabilir.`);

// --- Fonksiyonlar ---

/**
 * Gemini API kullanarak güncel haberler için bir RSS feed URL'si bulur.
 * @returns {Promise<string|{error: string, type: string}|null>} RSS feed URL'si, hata nesnesi veya null.
 */
async function getNewsRssFeedUrlFromAI() {
    try {
        console.log(`[${new Date().toLocaleString(undefined, { timeZone: timezone })}] Gemini API'den RSS feed URL'si isteniyor...`);
        const prompt = `
            Türkiye ve dünya gündemiyle ilgili güncel haberleri içeren, güvenilir bir haber kaynağına ait **yalnızca bir adet** aktif ve çalışan RSS veya Atom feed URL'si bul.
            Sadece URL'yi ver, başka hiçbir açıklama, başlık veya metin ekleme. URL http:// veya https:// ile başlamalıdır.
            Örnek: https://www.trthaber.com/xml_mobile.php?tur=xml_genel&kategori=gundem&adet=10
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text().trim();

        // Güvenlik filtresi kontrolü
        const safetyFeedback = response?.promptFeedback || response?.candidates?.[0]?.safetyRatings;
        if (safetyFeedback?.blockReason || response?.candidates?.[0]?.finishReason === 'SAFETY') {
             const reason = safetyFeedback?.blockReason || 'SAFETY';
             console.warn(`Gemini isteği güvenlik nedeniyle engellendi: ${reason}`);
             return { error: `AI isteği güvenlik filtrelerine takıldı (${reason}).`, type: 'safety' };
        }

        console.log(`[${new Date().toLocaleString(undefined, { timeZone: timezone })}] Gemini API'den yanıt alındı: "${text}"`);

        // Yanıtın geçerli bir URL olup olmadığını kontrol et (daha sağlam regex)
        const urlRegex = /^(https?:\/\/[^\s$.?#].[^\s]*)$/i;
        if (text && urlRegex.test(text)) {
             console.log(`Geçerli RSS URL'si bulundu: ${text}`);
            return text; // URL'yi döndür
        } else {
            console.warn("Gemini geçerli bir URL döndürmedi:", text);
            return { error: 'AI tarafından geçerli bir RSS URL\'si bulunamadı.', type: 'format' };
        }

    } catch (error) {
        console.error(`[${new Date().toLocaleString(undefined, { timeZone: timezone })}] Google AI API Hatası (RSS URL alırken):`, error);
         if (error.message.includes('API key not valid')) {
             return { error: 'Google AI API anahtarınız geçersiz.', type: 'auth' };
        } else if (error.message.includes('quota')) {
            return { error: 'Google AI API kotanız dolmuş olabilir.', type: 'quota' };
        } else if (error.message.includes('fetch') && error.cause) { // Ağ hatası
             console.error('Ağ Hatası Detayı:', error.cause);
             return { error: 'AI servisine bağlanırken ağ hatası oluştu.', type: 'network'};
        } else if (error.message.includes('timed out')) {
             return { error: 'AI servisinden yanıt alınırken zaman aşımı oluştu.', type: 'timeout'};
        }
        return { error: 'AI ile iletişimde beklenmedik bir sorun oluştu.', type: 'unknown' };
    }
}

/**
 * Verilen URL'den RSS feed'ini çeker ve ayrıştırır.
 * @param {string} feedUrl Çekilecek RSS feed URL'si.
 * @returns {Promise<{items: object[], title: string}|null>} Başarılıysa haber öğeleri ve başlık, hata durumunda null.
 */
async function fetchAndParseRss(feedUrl) {
    try {
        console.log(`[${new Date().toLocaleString(undefined, { timeZone: timezone })}] RSS feed çekiliyor: ${feedUrl}`);
        const feed = await rssParser.parseURL(feedUrl);
        const itemCount = feed.items?.length || 0;
        console.log(`[${new Date().toLocaleString(undefined, { timeZone: timezone })}] RSS feed başarıyla çekildi: "${feed.title || 'Başlıksız Feed'}" (${itemCount} öğe bulundu)`);

        if (!feed.items || itemCount === 0) {
            console.warn("RSS feed boş veya 'items' içermiyor.");
            return { items: [], title: feed.title || 'Başlıksız Feed' }; // Boş dizi ve başlıkla dön
        }
        // Sadece istenen sayıda haberi al ve başlıkla birlikte döndür
        return { items: feed.items.slice(0, newsCount), title: feed.title || 'Başlıksız Feed' };
    } catch (error) {
        console.error(`[${new Date().toLocaleString(undefined, { timeZone: timezone })}] RSS feed alınırken/ayrıştırılırken hata (${feedUrl}):`, error.message);
        // Hata detayını logla (örn: timeout, 404 Not Found, geçersiz XML)
        if (error.message.includes('timed out')) {
            console.error("Detay: RSS kaynağına bağlanırken zaman aşımı.");
        } else if (error.message.includes('status code 404')) {
            console.error("Detay: RSS kaynağı bulunamadı (404). URL geçersiz veya kaldırılmış olabilir.");
        } else if (error.message.includes('Invalid XML')) {
             console.error("Detay: RSS kaynağı geçerli bir XML formatında değil.");
        }
        return null; // Hata durumunu belirt
    }
}

/**
 * Haberleri formatlayıp Telegram'a gönderen ana işlev (Zamanlanmış görev).
 */
async function sendNewsUpdate() {
    const startTime = Date.now();
    console.log(`\n[${new Date().toLocaleString(undefined, { timeZone: timezone })}] Zamanlanmış görev başlıyor: Haberler kontrol ediliyor...`);

    let feedUrl = null;
    let rssTitle = 'Bilinmeyen Kaynak'; // Varsayılan başlık

    try {
        // 1. Adım: AI'dan RSS URL'sini al
        const feedUrlResult = await getNewsRssFeedUrlFromAI();

        // AI'dan hata geldiyse veya URL yoksa
        if (typeof feedUrlResult === 'object' && feedUrlResult.error) {
           console.error(`AI'dan RSS URL alınamadı: ${feedUrlResult.error} (Type: ${feedUrlResult.type})`);
           // İsteğe bağlı: Hata durumunu hedefe bildirme
           // await bot.sendMessage(targetChatId, `⚠️ Bu periyotta AI'dan (${geminiModelName}) haber kaynağı URL'si alınamadı. Sebep: ${feedUrlResult.error}`);
           return; // Bu seferlik işlemi bitir
        } else if (!feedUrlResult) { // Beklenmedik null durumu
            console.error('AI\'dan geçerli bir yanıt (URL) alınamadı.');
            // await bot.sendMessage(targetChatId, `⚠️ Bu periyotta AI'dan (${geminiModelName}) haber kaynağı URL'si alınamadı (boş yanıt).`);
            return;
        }

        feedUrl = feedUrlResult; // Geçerli URL alındı

        // 2. Adım: RSS Feed'ini çek ve ayrıştır
        const rssResult = await fetchAndParseRss(feedUrl);

        // RSS çekme/ayrıştırma hatası
        if (rssResult === null) {
            console.error(`RSS kaynağına (${feedUrl}) erişilemedi veya işlenemedi.`);
            // İsteğe bağlı: Hata durumunu hedefe bildirme
            // await bot.sendMessage(targetChatId, `⚠️ AI tarafından önerilen RSS kaynağına (${feedUrl}) erişirken sorun oluştu.`);
            return; // Bu seferlik işlemi bitir
        }

        const newsItems = rssResult.items;
        rssTitle = rssResult.title || rssTitle; // RSS başlığını al

        // RSS feed boşsa
        if (newsItems.length === 0) {
            console.log(`"${rssTitle}" başlıklı RSS kaynağında (${feedUrl}) yeni haber bulunamadı.`);
            // İsteğe bağlı: Yeni haber yoksa da mesaj gönderilebilir
            // await bot.sendMessage(targetChatId, `ℹ️ "${rssTitle}" kaynağından (${feedUrl}) yeni haber bulunamadı.`);
            return; // Bu seferlik işlemi bitir
        }

        // 3. Adım: Haberleri formatla ve gönder
        let responseText = `📰 **${rssTitle} - Güncel Haberler (${newsItems.length} adet):**\n\n`;
        newsItems.forEach((item, index) => {
            const title = item.title ? item.title.trim() : 'Başlık Yok';
            const link = item.link ? item.link.trim() : null;

            responseText += `${index + 1}. `;
            if (link) {
                // MarkdownV2 için özel karakterleri escape et
                const escapedTitle = title.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
                const escapedLink = link.replace(/[()]/g, '\\$&'); // Linkteki parantezler de escape edilmeli
                responseText += `[${escapedTitle}](${escapedLink})\n`;
            } else {
                // Link yoksa sadece başlık (onu da escape et)
                responseText += `${title.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')}\n`;
            }
        });

        // Mesajı hedef sohbete gönder
        await bot.sendMessage(targetChatId, responseText, {
            parse_mode: 'MarkdownV2',
            disable_web_page_preview: false // Link önizlemeleri açık
        });

        const duration = (Date.now() - startTime) / 1000; // Saniye cinsinden süre
        console.log(`[${new Date().toLocaleString(undefined, { timeZone: timezone })}] Haberler başarıyla ${targetChatId} ID'li hedefe gönderildi. Kaynak: ${feedUrl}. İşlem süresi: ${duration.toFixed(2)} sn.`);

    } catch (error) {
         const duration = (Date.now() - startTime) / 1000;
         console.error(`[${new Date().toLocaleString(undefined, { timeZone: timezone })}] Zamanlanmış görev sırasında beklenmedik bir hata oluştu (Kaynak: ${feedUrl || 'Alınamadı'}). Süre: ${duration.toFixed(2)} sn. Hata:`, error);

          // Telegram gönderme hatası özelinde loglama
         if (error.response && error.response.body) {
            console.error('Telegram API Hatası Detayı:', error.response.body);
            try {
                 const errorBody = JSON.parse(error.response.body);
                 if (errorBody.error_code === 400 && errorBody.description.includes("chat not found")) {
                     console.error(`KRİTİK HATA: Hedef sohbet (ID: ${targetChatId}) bulunamadı veya botun bu sohbete yazma izni yok! Lütfen TARGET_CHAT_ID'yi kontrol edin ve botun sohbete/kanala eklendiğinden emin olun.`);
                     // Bu durumda belki cron görevini durdurmak isteyebilirsiniz.
                     // cronTask.stop(); // Aşağıda tanımlanacak cronTask değişkeni üzerinden
                 } else if (errorBody.error_code === 403) {
                      console.error(`KRİTİK HATA: Bot, hedef sohbet (ID: ${targetChatId}) tarafından engellenmiş veya sohbetten atılmış olabilir.`);
                      // cronTask.stop();
                 } else if (errorBody.error_code === 429) {
                      console.warn(`Telegram API Hızı Aşıldı (Too Many Requests). Bir sonraki deneme bekleniyor.`);
                 }
            } catch (parseErr) { console.error("Telegram hata mesajı parse edilemedi:", parseErr); }
         }
         // Genel hatayı hedefe bildirme (dikkatli olun, döngüye sokabilir)
         // try { await bot.sendMessage(targetChatId, `⚠️ Haberleri gönderirken bir hata oluştu. Detaylar loglarda.`); } catch (e) {}
    }
}

// --- Zamanlanmış Görev Tanımı---
console.log(`Haber gönderme görevi "${cronSchedule}" deseniyle zamanlanıyor (${timezone})...`);
// Görevi bir değişkene ata (örn: durdurmak gerekirse diye)
const cronTask = cron.schedule(cronSchedule, sendNewsUpdate, {
    scheduled: true,
    timezone: timezone
});

// --- Başlangıç ---
console.log(`Bot çalışıyor. Haberler ${targetChatId} ID'li hedefe "${cronSchedule}" zamanlamasıyla gönderilecek.`);
console.log('Çıkmak için CTRL+C tuşlarına basın.');

// İsteğe bağlı: Bot başladığında hemen bir kere çalıştır
// console.log("Bot başlar başlamaz ilk haber kontrolü yapılıyor...");
// sendNewsUpdate();


// --- Kapanma Sinyalleri ---
function gracefulShutdown(signal) {
    console.log(`\n${signal} sinyali alındı. Bot durduruluyor...`);
    if (cronTask) {
        cronTask.stop(); // Zamanlanmış görevi durdur
        console.log("Zamanlanmış görev durduruldu.");
    }
    // Polling kullanmadığımız için bot.stopPolling() gerekmez.
    // Gerekirse diğer temizleme işlemleri burada yapılabilir.
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
