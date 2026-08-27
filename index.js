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

async function translateWithRetry(text, source, target, attempt = 1) {
  console.log(`Attempt ${attempt} - Translating [${source}->${target}]`);
  
  const services = [
    () => translateDeepL(text, source, target),
    () => translateGoogle(text, source, target),
    () => translateLibreTranslate(text, source, target),
    () => translateMyMemory(text, source, target),
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
  
  if (attempt < 3) {
    console.log(`Retrying translation (attempt ${attempt + 1})...`);
    await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    return translateWithRetry(text, source, target, attempt + 1);
  }
  
  console.log('❌ All translation services failed');
  return null;
}

// Service 1: DeepL (Most accurate, free tier available)
async function translateDeepL(text, source, target) {
  // DeepL language codes
  const langMap = {
    'en': 'EN',
    'zh-TW': 'ZH',  // DeepL uses ZH for Chinese
    'id': 'ID'
  };
  
  const sourceLang = langMap[source] || source.toUpperCase();
  const targetLang = langMap[target] || target.toUpperCase();
  
  if (sourceLang === targetLang) return null;
  
  // Using DeepL's free API (no API key required for basic usage)
  // But we'll try multiple free endpoints
  const endpoints = [
    'https://api-free.deepl.com/v2/translate',
    'https://api.deepl.com/v2/translate',
  ];
  
  for (const url of endpoints) {
    try {
      console.log(`DeepL [${sourceLang}->${targetLang}] via ${url}`);
      
      const params = new URLSearchParams({
        text: text,
        source_lang: sourceLang,
        target_lang: targetLang,
        tag_handling: 'html',
        split_sentences: '1',
      });
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        signal: AbortSignal.timeout(10000)
      });

      if (response.status === 456) {
        console.log('DeepL quota exceeded, trying next service');
        return null;
      }
      
      if (!response.ok) {
        console.log(`DeepL HTTP error: ${response.status}`);
        continue;
      }
      
      const data = await response.json();
      
      if (data.translations && data.translations.length > 0) {
        const translated = data.translations[0].text;
        if (translated && translated.length > 0 && translated.toLowerCase() !== text.toLowerCase()) {
          console.log(`DeepL: "${translated}"`);
          return translated;
        }
      }
    } catch (err) {
      console.log(`DeepL instance failed:`, err.message);
    }
  }
  
  return null;
}

// Service 2: Google Translate (Unofficial, good for Chinese)
async function translateGoogle(text, source, target) {
  const langMap = {
    'en': 'en',
    'zh-TW': 'zh-CN',
    'id': 'id'
  };
  
  const sourceLang = langMap[source] || source;
  const targetLang = langMap[target] || target;
  
  if (sourceLang === targetLang) return null;
  
  const url = 'https://translate.googleapis.com/translate_a/single';
  const params = new URLSearchParams({
    client: 'gtx',
    sl: sourceLang,
    tl: targetLang,
    dt: 't',
    q: text
  });

  try {
    console.log(`Google Translate [${sourceLang}->${targetLang}]`);
    const response = await fetch(`${url}?${params}`, {
      signal: AbortSignal.timeout(10000)
    });
    
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

// Service 3: LibreTranslate
async function translateLibreTranslate(text, source, target) {
  const langMap = {
    'en': 'en',
    'zh-TW': 'zh',
    'id': 'id'
  };
  
  const sourceLang = langMap[source] || source;
  const targetLang = langMap[target] || target;
  
  if (sourceLang === targetLang) return null;
  
  const instances = [
    'https://libretranslate.com/translate',
    'https://translate.mentality.rip/translate',
  ];
  
  for (const url of instances) {
    try {
      console.log(`LibreTranslate [${sourceLang}->${targetLang}] via ${url}`);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: text,
          source: sourceLang,
          target: targetLang,
          format: 'text'
        }),
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        console.log(`LibreTranslate HTTP error: ${response.status}`);
        continue;
      }
      
      const data = await response.json();
      if (data.translatedText && typeof data.translatedText === 'string' && 
          data.translatedText.length > 0 && 
          data.translatedText.toLowerCase() !== text.toLowerCase()) {
        console.log(`LibreTranslate: "${data.translatedText}"`);
        return data.translatedText.replace(/\[object Object\]/g, '').trim();
      }
    } catch (err) {
      console.log(`LibreTranslate instance failed:`, err.message);
    }
  }
  
  return null;
}

// Service 4: MyMemory
async function translateMyMemory(text, source, target) {
  const langpair = `${source}|${target}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langpair)}`;

  try {
    console.log(`MyMemory [${source}->${target}]`);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000)
    });
    
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('=== LINE TRANSLATOR BOT ===');
  console.log(`✅ Server running on port ${port}`);
  console.log('🔄 Using translation services (ordered by accuracy):');
  console.log('  1. DeepL (Most accurate) ⭐');
  console.log('  2. Google Translate (Unofficial)');
  console.log('  3. LibreTranslate');
  console.log('  4. MyMemory');
  console.log('=============================');
});
