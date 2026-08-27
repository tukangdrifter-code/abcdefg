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
  
  // Try different services in order
  const services = [
    () => translateGoogle2(text, source, target),
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
    await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
    return translateWithRetry(text, source, target, attempt + 1);
  }
  
  console.log('❌ All translation services failed');
  return null;
}

// Service 1: Google Translate with different endpoint (more reliable)
async function translateGoogle2(text, source, target) {
  const langMap = {
    'en': 'en',
    'zh-TW': 'zh-CN',
    'id': 'id'
  };
  
  const sourceLang = langMap[source] || source;
  const targetLang = langMap[target] || target;
  
  if (sourceLang === targetLang) return null;
  
  // Use a different Google Translate endpoint
  const url = 'https://translate.googleapis.com/translate_a/single';
  const params = new URLSearchParams({
    client: 'webapp',
    sl: sourceLang,
    tl: targetLang,
    hl: 'zh-CN',
    dt: 't',
    dt: 'bd',
    dt: 'ex',
    dt: 'ld',
    dt: 'md',
    dt: 'qca',
    dt: 'rw',
    dt: 'rm',
    dt: 'ss',
    dt: 'sos',
    dt: 'gt',
    q: text
  });

  try {
    console.log(`Google Translate v2 [${sourceLang}->${targetLang}]`);
    const response = await fetch(`${url}?${params}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000)
    });
    
    if (!response.ok) {
      console.log('Google Translate v2 HTTP error:', response.status);
      return null;
    }
    
    const data = await response.json();
    
    // Parse the response
    let translated = '';
    if (Array.isArray(data) && data[0]) {
      for (const part of data[0]) {
        if (Array.isArray(part) && part[0]) {
          translated += part[0];
        }
      }
    }
    
    if (translated && translated.length > 0) {
      translated = translated.replace(/\[object Object\]/g, '').trim();
      if (translated.length > 0 && translated.toLowerCase() !== text.toLowerCase()) {
        console.log(`Google Translate v2: "${translated}"`);
        return translated;
      }
    }
    
    return null;
  } catch (err) {
    console.log('Google Translate v2 error:', err.message);
    return null;
  }
}

// Service 2: Google Translate (original)
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
  ];
  
  for (const url of instances) {
    try {
      console.log(`LibreTranslate [${sourceLang}->${targetLang}] via ${url}`);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        },
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
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langpair)}&de=demo@example.com`;

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
  console.log('🔄 Using translation services:');
  console.log('  1. Google Translate v2 (Webapp endpoint)');
  console.log('  2. Google Translate (GTX endpoint)');
  console.log('  3. LibreTranslate');
  console.log('  4. MyMemory');
  console.log('=============================');
});
