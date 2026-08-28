const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error('ERROR: Missing LINE credentials!');
  process.exit(1);
}

const app = express();
const client = new line.Client(config);

app.get('/', (req, res) => res.send('LINE translator bot is running'));

app.post('/webhook', line.middleware(config), (req, res) => {
  res.status(200).end();
  if (req.body.events) {
    req.body.events.forEach(event => {
      handleEvent(event).catch(err => console.error('Event error:', err));
    });
  }
});

async function handleEvent(event) {
  try {
    if (event.type !== 'message' || event.message.type !== 'text') return;

    const text = event.message.text.trim();
    if (!text) return;

    console.log('Processing:', text);

    const detected = detectLanguage(text);
    console.log('Detected language:', detected);

    const targets = ['en', 'zh-TW', 'id'].filter(code => code !== detected);

    const translations = await Promise.all(
      targets.map(target => translateWithRetry(text, detected, target))
    );

    const messages = translations
      .filter(Boolean)
      .map(t => {
        const textStr = typeof t === 'string' ? t : String(t);
        return { type: 'text', text: textStr };
      });

    if (messages.length === 0) {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '⚠️ Translation service temporarily unavailable. Please try again in a few minutes.'
      });
      return;
    }

    await client.replyMessage(event.replyToken, messages);
    console.log('Reply sent successfully!');

  } catch (error) {
    console.error('Error:', error);
    try {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ Sorry, I encountered an error. Please try again.'
      });
    } catch (replyError) {
      console.error('Failed to send error message:', replyError);
    }
  }
}

function detectLanguage(text) {
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-TW';

  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const indonesianWords = new Set([
    'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'tidak', 'ini', 'itu',
    'saya', 'kamu', 'anda', 'adalah', 'akan', 'juga', 'ada', 'apa', 'kalau',
    'kalo', 'gimana', 'bagaimana', 'sudah', 'udah', 'belum', 'mau', 'bisa',
    'kenapa', 'karena', 'tapi', 'atau', 'jadi', 'sama', 'lagi', 'nanti',
    'sekarang', 'kita', 'kami', 'mereka', 'dia', 'aku', 'terima', 'kasih',
    'selamat', 'pagi', 'siang', 'malam', 'baik', 'tolong', 'maaf',
  ]);

  const hits = words.filter(w => indonesianWords.has(w)).length;
  return hits > 0 ? 'id' : 'en';
}

// Try multiple translation services with retry.
// DeepL goes FIRST — real official API with a genuine free quota, not a
// scraped mirror. The others are only used if DeepL itself fails.
async function translateWithRetry(text, source, target, attempt = 1) {
  console.log(`Attempt ${attempt} - Translating [${source}->${target}]`);

  const services = [
    () => translateDeepL(text, source, target),
    () => translateMyMemory(text, source, target),
    () => translateLingva(text, source, target),
    () => translateGoogle(text, source, target),
  ];

  for (let i = 0; i < services.length; i++) {
    try {
      const result = await services[i]();
      if (result && typeof result === 'string' && result.length > 0) {
        console.log(`✅ Translation successful using service ${i + 1}`);
        return result;
      }
    } catch (err) {
      console.log(`Service ${i + 1} failed:`, err.message);
    }
  }

  // Reduced from 3 attempts to 2, with a longer gap between them — the old
  // 3x-full-waterfall retry could fire ~30+ requests for a single message,
  // which risked triggering rate limits on its own.
  if (attempt < 2) {
    console.log(`Retrying translation (attempt ${attempt + 1})...`);
    await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
    return translateWithRetry(text, source, target, attempt + 1);
  }

  console.log('❌ All translation services failed');
  return null;
}

// Service 0: DeepL — official API, real quota (500,000 chars/month free),
// not a scraped/community mirror. This is the primary translator now;
// everything else only runs if DeepL itself is unavailable.
async function translateDeepL(text, source, target) {
  if (!process.env.DEEPL_API_KEY) return null;
  if (source === target) return null;

  // DeepL source codes are the base language, no variant needed.
  const sourceMap = { 'en': 'EN', 'zh-TW': 'ZH', 'id': 'ID' };
  // DeepL target codes: ZH-HANT for Traditional Chinese specifically,
  // EN-US for English, ID for Indonesian.
  const targetMap = { 'en': 'EN-US', 'zh-TW': 'ZH-HANT', 'id': 'ID' };

  const sourceLang = sourceMap[source];
  const targetLang = targetMap[target];
  if (!sourceLang || !targetLang) return null;

  try {
    console.log(`DeepL [${sourceLang}->${targetLang}]`);
    const response = await fetch('https://api-free.deepl.com/v2/translate', {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: [text],
        source_lang: sourceLang,
        target_lang: targetLang,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.log('DeepL HTTP error:', response.status);
      return null;
    }

    const data = await response.json();
    const translated = data?.translations?.[0]?.text;
    if (translated && typeof translated === 'string' && translated.length > 0) {
      console.log(`DeepL: "${translated}"`);
      return translated.trim();
    }
    return null;
  } catch (err) {
    console.log('DeepL error:', err.message);
    return null;
  }
}

// Service 1: MyMemory (backup — most reliable when MYMEMORY_EMAIL is set)
async function translateMyMemory(text, source, target) {
  const langpair = `${source}|${target}`;
  const params = new URLSearchParams({ q: text, langpair });
  // Optional but recommended: set MYMEMORY_EMAIL env var on Render to raise
  // the free daily quota from ~5,000 to ~50,000 words/day, tied to your
  // email instead of Render's shared IP. Any real email works.
  if (process.env.MYMEMORY_EMAIL) params.set('de', process.env.MYMEMORY_EMAIL);

  const url = `https://api.mymemory.translated.net/get?${params}`;

  try {
    console.log(`MyMemory [${source}->${target}]`);
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

    if (response.status === 429) {
      console.log('MyMemory rate limited');
      return null;
    }
    if (!response.ok) {
      console.log('MyMemory HTTP error:', response.status);
      return null;
    }

    const data = await response.json();
    if (data?.responseData?.translatedText &&
        typeof data.responseData.translatedText === 'string' &&
        data.responseData.translatedText.length > 0 &&
        data.responseData.translatedText.toLowerCase() !== text.toLowerCase()) {
      console.log(`MyMemory: "${data.responseData.translatedText}"`);
      return data.responseData.translatedText.replace(/\[object Object\]/g, '').trim();
    }
    return null;
  } catch (err) {
    console.log('MyMemory error:', err.message);
    return null;
  }
}

// Service 2: Lingva Translate — an open-source, privacy-friendly frontend for
// Google Translate, run by volunteers on several independent mirrors. Since
// any single mirror can go down or start requiring a key (as libretranslate.com
// now does), we try several different ones in order.
async function translateLingva(text, source, target) {
  const langMap = { 'en': 'en', 'zh-TW': 'zh', 'id': 'id' };
  const sourceLang = langMap[source] || source;
  const targetLang = langMap[target] || target;
  if (sourceLang === targetLang) return null;

  const instances = [
    'https://lingva.lunar.icu',
    'https://translate.plausibility.cloud',
    'https://lingva.esmailelbob.xyz',
    'https://translate.datatunnel.xyz',
  ];

  for (const base of instances) {
    const url = `${base}/api/v1/${sourceLang}/${targetLang}/${encodeURIComponent(text)}`;
    try {
      console.log(`Lingva [${sourceLang}->${targetLang}] via ${base}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

      if (!response.ok) {
        console.log(`Lingva HTTP error: ${response.status} (${base})`);
        continue;
      }

      const data = await response.json();
      if (data.translation && typeof data.translation === 'string' &&
          data.translation.length > 0 &&
          data.translation.toLowerCase() !== text.toLowerCase()) {
        console.log(`Lingva: "${data.translation}"`);
        return data.translation.trim();
      }
    } catch (err) {
      console.log(`Lingva instance failed (${base}):`, err.message);
    }
  }

  return null;
}

// Service 3: Google Translate (unofficial endpoint) — last resort, since it's
// the most prone to getting flagged when shared with other Render apps.
async function translateGoogle(text, source, target) {
  const langMap = { 'en': 'en', 'zh-TW': 'zh-CN', 'id': 'id' };
  const sourceLang = langMap[source] || source;
  const targetLang = langMap[target] || target;
  if (sourceLang === targetLang) return null;

  const url = 'https://translate.googleapis.com/translate_a/single';
  const params = new URLSearchParams({ client: 'gtx', sl: sourceLang, tl: targetLang, dt: 't', q: text });

  try {
    console.log(`Google Translate [${sourceLang}->${targetLang}]`);
    const response = await fetch(`${url}?${params}`, { signal: AbortSignal.timeout(10000) });

    if (!response.ok) {
      console.log('Google Translate HTTP error:', response.status);
      return null;
    }

    const data = await response.json();
    let translated = null;

    if (Array.isArray(data)) {
      if (data[0] && Array.isArray(data[0]) && data[0][0] && Array.isArray(data[0][0])) {
        translated = data[0].map(item => item[0]).join('');
      } else if (data[0] && Array.isArray(data[0]) && data[0][0]) {
        if (typeof data[0][0] === 'string') {
          translated = data[0][0];
        } else if (Array.isArray(data[0][0]) && data[0][0][0]) {
          translated = data[0].map(item => item[0]).join('');
        }
      } else if (typeof data[0] === 'string') {
        translated = data.join('');
      }
    } else if (data && typeof data === 'object') {
      if (data.sentences && Array.isArray(data.sentences)) {
        translated = data.sentences.map(s => {
          if (typeof s === 'string') return s;
          if (s.trans) return s.trans;
          if (s.translation) return s.translation;
          return '';
        }).join('');
      } else if (data.text) {
        translated = data.text;
      } else if (data.translatedText) {
        translated = data.translatedText;
      }
    }

    if (translated && typeof translated === 'string' && translated.length > 0) {
      translated = translated.replace(/\[object Object\]/g, '').trim();
      if (translated.length > 0 && translated.toLowerCase() !== text.toLowerCase()) {
        console.log(`Google Translate: "${translated}"`);
        return translated;
      }
    }

    return null;
  } catch (err) {
    console.log('Google Translate error:', err.message);
    return null;
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('=== LINE TRANSLATOR BOT ===');
  console.log(`✅ Server running on port ${port}`);
  console.log('🔄 DeepL primary, MyMemory/Lingva/Google as fallback');
  console.log('=============================');
});
