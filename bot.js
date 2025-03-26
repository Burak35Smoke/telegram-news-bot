const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai'); // Safety settings için eklemeler
const cron = require('node-cron');
require('dotenv').config();

// --- Ayarlar ---
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;
const targetChatId = process.env.TARGET_CHAT_ID;
const cronSchedule = process.env.CRON_SCHEDULE || '*/15 * * * *';
const newsCount = parseInt(process.env.NEWS_COUNT || '3', 10); // Varsayılan 3 haber
const geminiModelName = "gemini-2.5-pro-experimental-03-25"; // Veya uygun güncel model
const timezone = "Europe/Istanbul";

// --- Kontroller ---
if (!telegramToken || !geminiApiKey || !targetChatId) {
    console.error('Hata: Lütfen .env dosyasında TELEGRAM_BOT_TOKEN, GEMINI_API_KEY ve TARGET_CHAT_ID değişkenlerini tanımlayın.');
    process.exit(1);
}
if (!cron.validate(cronSchedule)) { /* ... */ process.exit(1); }
if (!targetChatId.match(/^-?\d+$/)) { /* ... */ process.exit(1); }
if (newsCount <= 0) { console.error('Hata: NEWS_COUNT pozitif bir sayı olmalıdır.'); process.exit(1); }


// --- Kütüphane Başlatmaları ---
console.log("Telegram Bot başlatılıyor...");
const bot = new TelegramBot(telegramToken);

console.log("Google AI İstemcisi başlatılıyor...");
const genAI = new GoogleGenerativeAI(geminiApiKey);
// Güvenlik ayarlarını biraz daha esnek yapabiliriz (isteğe bağlı, riskleri değerlendirin)
// Bazı haber içerikleri hassas olabileceğinden filtrelemeyi tamamen kapatmak önerilmez.
// Düşük ayarlar deneyebilirsiniz:
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];
const model = genAI.getGenerativeModel({
    model: geminiModelName,
    safetySettings // Güvenlik ayarlarını modele ilet
});
console.log(`Google AI Modeli (${geminiModelName}) kullanıma hazır.`);
console.log(`Hedef Sohbet ID: ${targetChatId}`);
console.log(`Zamanlama: ${cronSchedule} (${timezone})`);
console.log(`İstenen Haber Sayısı: ${newsCount}`);

// --- Fonksiyonlar ---

/**
 * Gemini API kullanarak belirtilen sayıda güncel haberin başlığını ve TAM içeriğini alır.
 * Yanıtı JSON formatında bekler.
 * @returns {Promise<Array<{title: string, content: string}>|{error: string, type: string}|null>} Haber listesi, hata nesnesi veya null.
 */
async function getNewsFromAI() {
    try {
        console.log(`[${new Date().toLocaleString(undefined, { timeZone: timezone })}] Gemini API'den ${newsCount} adet haberin tam içeriği isteniyor...`);

        // Gemini'ye verilecek Prompt (JSON formatında yanıt isteme)
        const prompt = `
            Türkiye ve dünya gündemindeki en önemli ${newsCount} adet güncel haberi bul.
            Her haber için başlığını (title) ve haberin TAM METNİNİ (content) içeren bir JSON dizisi oluştur.
            JSON formatı şu şekilde olmalı:
            [
              {
                "title": "İlk Haberin Başlığı",
                "content": "İlk haberin tüm içeriği buraya gelecek..."
              },
              {
                "title": "İkinci Haberin Başlığı",
                "content": "İkinci haberin tüm içeriği buraya gelecek..."
              }
              // ... diğer haberler
            ]
            Sadece ve sadece bu JSON dizisini yanıt olarak ver, başka hiçbir açıklama, giriş veya sonuç metni ekleme.
            İçeriklerin mümkün olduğunca eksiksiz olduğundan emin ol.
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;

         // Güvenlik filtresi kontrolü (generateContent sonrası daha güvenilir)
         if (response?.promptFeedback?.blockReason || response?.candidates?.[0]?.finishReason === 'SAFETY') {
             const reason = response?.promptFeedback?.blockReason || 'SAFETY';
             console.warn(`Gemini isteği güvenlik nedeniyle engellendi: ${reason}`);
             const safetyRatings = response?.candidates?.[0]?.safetyRatings;
             if(safetyRatings) console.warn("Algılanan Kategoriler:", JSON.stringify(safetyRatings));
             return { error: `AI isteği güvenlik filtrelerine takıldı (${reason}).`, type: 'safety' };
        }

        const rawText = response.text().trim();
        console.log(`[${new Date().toLocaleString(undefined, { timeZone: timezone })}] Gemini API'den ham yanıt alındı (ilk 200 karakter): "${rawText.substring(0, 200)}..."`);

        // Yanıtın JSON olup olmadığını kontrol et ve parse et
        let newsData = null;
        try {
             // Gemini bazen JSON'u ```json ... ``` içine alabilir, bunu temizleyelim
            const cleanedText = rawText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
            newsData = JSON.parse(cleanedText);

            // Gelen verinin beklenen formatta (dizi ve içinde nesneler) olup olmadığını kontrol et
            if (!Array.isArray(newsData) || newsData.length === 0 || typeof newsData[0] !== 'object' || !newsData[0].title || !newsData[0].content) {
                console.warn("Gemini'den gelen JSON verisi beklenen formatta değil:", newsData);
                return { error: 'AI yanıtı geçerli haber formatında JSON içermiyor.', type: 'format' };
            }
             console.log(`Gemini yanıtı başarıyla JSON olarak parse edildi, ${newsData.length} haber bulundu.`);
             // İstenenden fazla haber geldiyse sadece istenen kadarını al
             if (newsData.length > newsCount) {
                 console.log(`İstenenden fazla (${newsData.length}) haber geldi, ${newsCount} adedi alınıyor.`);
                 newsData = newsData.slice(0, newsCount);
             }
            return newsData; // Haber dizisini döndür

        } catch (parseError) {
            console.error("Gemini yanıtı JSON olarak parse edilemedi:", parseError.message);
            console.error("Alınan Ham Metin:", rawText); // Hatalı metni logla
            return { error: 'AI yanıtı geçerli JSON formatında değil.', type: 'parse' };
        }

    } catch (error) {
        console.error(`[${new Date().toLocaleString(undefined, { timeZone: timezone })}] Google AI API Hatası (Haber içeriği alırken):`, error);
         // Hata tiplerini ayırt etme (önceki koddan alınabilir)
         if (error.message.includes('API key not valid')) return { error: 'Google AI API anahtarınız geçersiz.', type: 'auth' };
         if (error.message.includes('quota')) return { error: 'Google AI API kotanız dolmuş olabilir.', type: 'quota' };
         if (error.message.includes('fetch') && error.cause) return { error: 'AI servisine bağlanırken ağ hatası oluştu.', type: 'network'};
         if (error.message.includes('timed out') || error.message.includes('deadline exceeded')) return { error: 'AI servisinden yanıt alınırken zaman aşımı oluştu.', type: 'timeout'};
        return { error: 'AI ile iletişimde veya içerik işlemede beklenmedik bir sorun oluştu.', type: 'unknown' };
    }
}


/**
 * Haberleri formatlayıp Telegram'a TEKER TEKER gönderen ana işlev (Zamanlanmış görev).
 */
async function sendNewsUpdate() {
    const startTime = Date.now();
    console.log(`\n[${new Date().toLocaleString(undefined, { timeZone: timezone })}] Zamanlanmış görev başlıyor: Haberler AI'dan alınıyor...`);

    // --- Helper function for delay ---
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    try {
        // 1. Adım: AI'dan haber başlıklarını ve içeriklerini al (JSON formatında)
        const newsResult = await getNewsFromAI();

        // AI'dan hata geldiyse veya veri yoksa
        if (newsResult === null || (typeof newsResult === 'object' && newsResult.error)) {
            const errorMsg = newsResult ? newsResult.error : 'Bilinmeyen AI hatası';
            const errorType = newsResult ? newsResult.type : 'unknown';
            console.error(`AI'dan haber içeriği alınamadı: ${errorMsg} (Type: ${errorType})`);
            // İsteğe bağlı: Hata durumunu hedefe bildirme
            // await bot.sendMessage(targetChatId, `⚠️ Bu periyotta AI'dan (${geminiModelName}) haber içeriği alınamadı. Sebep: ${errorMsg}`);
            return; // Bu seferlik işlemi bitir
        }

         // Gelen dizi boşsa (AI haber bulamamışsa)
         if (!Array.isArray(newsResult) || newsResult.length === 0) {
              console.log("AI bu periyot için gönderilecek haber bulamadı veya boş dizi döndürdü.");
              return;
         }

         const newsItems = newsResult; // Artık haberlerimiz var

        // 2. Adım: Haberleri istenen formatta TEKER TEKER gönder
        console.log(`[${new Date().toLocaleString(undefined, { timeZone: timezone })}] ${newsItems.length} adet haber gönderilecek...`);

        for (let i = 0; i < newsItems.length; i++) {
            const item = newsItems[i];
            const title = item.title ? item.title.trim() : 'Başlık Yok';
            let content = item.content ? item.content.trim() : 'İçerik bulunamadı.';

            // Telegram MarkdownV2 için özel karakterleri escape etme fonksiyonu
            const escapeMarkdownV2 = (text) => {
                if(!text) return '';
                // Escape edilecek karakterler listesi: _ * [ ] ( ) ~ ` > # + - = | { } . !
                return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
            };

            const escapedTitle = escapeMarkdownV2(title);
            // İçerik çok uzun olabileceğinden, escape işlemi zaman alabilir.
            // Alternatif olarak, sadece potansiyel sorunlu kısımları escape edebiliriz ama tamamını yapmak daha güvenli.
            const escapedContent = escapeMarkdownV2(content);

            // Mesaj formatı: Kalın Başlık + 3 Satır Boşluk + İçerik
            let messageText = `*${escapedTitle}*\n\n\n${escapedContent}`;

            // Telegram mesaj limiti kontrolü (4096 karakter)
            if (messageText.length > 4096) {
                console.warn(` -> Haber ${i + 1} (${title.substring(0,30)}...) içeriği çok uzun (${messageText.length} karakter). Kırpılıyor...`);
                // Başlık + boşluklar + ... (4096 - başlık uzunluğu - 4 boşluk - 3 nokta)
                const maxContentLength = 4096 - escapedTitle.length - 4 - 3;
                messageText = `*${escapedTitle}*\n\n\n${escapedContent.substring(0, maxContentLength)}...`;
            }

            // Her haber için ayrı mesaj gönder
            try {
                await bot.sendMessage(targetChatId, messageText, {
                    parse_mode: 'MarkdownV2',
                    // Link önizlemesi genellikle içerikteki ilk link için çalışır, açık bırakılabilir.
                    disable_web_page_preview: false
                });
                console.log(` -> Haber ${i + 1}/${newsItems.length} gönderildi: ${title.substring(0, 50)}...`);

                // RATE LIMITING ÖNLEMİ: Mesajlar arasına gecikme ekle
                await sleep(1000); // 1 saniye bekle (daha güvenli)

            } catch (sendError) {
                console.error(` -> Haber ${i + 1} gönderilemedi: ${title.substring(0, 50)}... Hata:`, sendError.message);
                 // Rate Limit ve diğer kritik hataları işle (önceki koddan)
                 if (sendError.response && sendError.response.body) {
                     // ... (Rate limit bekleme, chat not found/forbidden için return veya loglama) ...
                       try {
                           const errorBody = JSON.parse(sendError.response.body);
                           if (errorBody.error_code === 429) {
                               const retryAfter = errorBody.parameters?.retry_after || 5;
                               console.warn(`   Rate limit aşıldı. ${retryAfter} saniye bekleniyor...`);
                               await sleep(retryAfter * 1000 + 500);
                               i--; // Aynı haberi tekrar denemek için sayacı geri al (dikkatli kullan!)
                               console.log(`   Haber ${i + 2} tekrar denenecek.`);
                           } else if (errorBody.error_code === 400 && errorBody.description.includes("chat not found")) {
                              console.error("   KRİTİK HATA: Hedef sohbet bulunamadı. Gönderim durduruluyor."); return;
                           } else if (errorBody.error_code === 403) {
                              console.error("   KRİTİK HATA: Bot engellenmiş/atılmış. Gönderim durduruluyor."); return;
                           } else if (errorBody.description?.includes("can't parse entities")) {
                                console.error("   Markdown PARSE HATASI: Gönderilen metinde Telegram'ın işleyemediği karakterler var. Escape işlemi kontrol edilmeli.");
                                console.error("   Sorunlu olabilecek başlık:", title); // Başlığı logla
                                // Bu haberi atlayıp devam etmeyi seçebiliriz: continue;
                           }
                       } catch (parseErr) {}
                 }
            }
        } // for döngüsü sonu

        const duration = (Date.now() - startTime) / 1000;
        console.log(`[${new Date().toLocaleString(undefined, { timeZone: timezone })}] ${newsItems.length} adet haberin gönderimi tamamlandı. Toplam süre: ${duration.toFixed(2)} sn.`);

    } catch (error) { // Genel try bloğunun catch'i
        const duration = (Date.now() - startTime) / 1000;
        console.error(`[${new Date().toLocaleString(undefined, { timeZone: timezone })}] Zamanlanmış görev sırasında beklenmedik genel bir hata oluştu. Süre: ${duration.toFixed(2)} sn. Hata:`, error);
    }
} // sendNewsUpdate fonksiyonu sonu

// --- Zamanlanmış Görev Tanımı ve diğer kısımlar aynı kalır ---
console.log(`Haber içeriği alma ve gönderme görevi "${cronSchedule}" deseniyle zamanlanıyor (${timezone})...`);
const cronTask = cron.schedule(cronSchedule, sendNewsUpdate, { scheduled: true, timezone: timezone });

console.log(`Bot çalışıyor. Haberler ${targetChatId} ID'li hedefe "${cronSchedule}" zamanlamasıyla gönderilecek.`);
console.log('Çıkmak için CTRL+C tuşlarına basın.');
// gracefulShutdown(...) ve process.on(...) kısımları önceki kodla aynı kalabilir.
// ... (Graceful shutdown kodu buraya gelecek) ...
function gracefulShutdown(signal) {
    console.log(`\n${signal} sinyali alındı. Bot durduruluyor...`);
    if (cronTask) {
        cronTask.stop();
        console.log("Zamanlanmış görev durduruldu.");
    }
    process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
