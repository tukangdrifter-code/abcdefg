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
    
    // Get translations with retry logic
    const translations = await Promise.all(
      targets.map(target => translateWithRetry(text, detected, target))
    );

    const messages = translations
      .filter(Boolean)
      .map(t => ({ type: 'text', text: t }));

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

// Try multiple translation services with retry
async function translateWithRetry(text, source, target, attempt = 1) {
  console.log(`Attempt ${attempt} - Translating [${source}->${target}]`);
  
  // Try different services in order
  const services = [
    () => translateGoogle(text, source, target),
    () => translateLibreTranslate(text, source, target),
    () => translateMyMemory(text, source, target),
  ];
  
  // Try each service
  for (let i = 0; i < services.length; i++) {
    try {
      const result = await services[i]();
      if (result && result.length > 0) {
        console.log(`✅ Translation successful using service ${i + 1}`);
        return result;
      }
    } catch (err) {
      console.log(`Service ${i + 1} failed:`, err.message);
    }
  }
  
  // If all services fail, try one more time with a delay
  if (attempt < 3) {
    console.log(`Retrying translation (attempt ${attempt + 1})...`);
    await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    return translateWithRetry(text, source, target, attempt + 1);
  }
  
  console.log('❌ All translation services failed');
  return null;
}

// Service 1: Google Translate (Unofficial, most reliable)
async function translateGoogle(text, source, target) {
  const langMap = {
    'en': 'en',
    'zh-TW': 'zh-CN',
    'id': 'id'
  };
  
  const sourceLang = langMap[source] || source;
  const targetLang = langMap[target] || target;
  
  if (sourceLang === targetLang) return null;
  
  // For Chinese translations, use a different approach to get full text
  const url = 'https://translate.googleapis.com/translate_a/single';
  const params = new URLSearchParams({
    client: 'gtx',
    sl: sourceLang,
    tl: targetLang,
    dt: 't',
    dt: 'at',  // Added for better translation quality
    dj: '1',   // JSON format
    q: text
  });

  try {
    console.log(`Google Translate [${sourceLang}->${targetLang}]`);
    const response = await fetch(`${url}?${params}`, {
      signal: AbortSignal.timeout(10000) // Increased timeout for longer texts
    });
    
    if (!response.ok) {
      console.log('Google Translate HTTP error:', response.status);
      return null;
    }
    
    const data = await response.json();
    
    // Handle different response formats
    let translated = null;
    
    // Try format 1: Array format
    if (Array.isArray(data) && data[0] && data[0][0] && data[0][0][0]) {
      translated = data[0][0][0];
    } 
    // Try format 2: Object format with sentences
    else if (data.sentences && Array.isArray(data.sentences)) {
      translated = data.sentences.map(s => s.trans || s).join('');
    }
    // Try format 3: Direct text
    else if (data.text) {
      translated = data.text;
    }
    
    if (translated && translated.length > 0 && translated.toLowerCase() !== text.toLowerCase()) {
      console.log(`Google Translate: "${translated}"`);
      return translated;
    }
    
    // If translation failed with the first method, try a simpler URL
    if (translated === null || translated.length === 0) {
      console.log('Google Translate first method failed, trying alternative...');
      const simpleParams = new URLSearchParams({
        client: 'gtx',
        sl: sourceLang,
        tl: targetLang,
        dt: 't',
        q: text
      });
      
      const simpleResponse = await fetch(`${url}?${simpleParams}`, {
        signal: AbortSignal.timeout(10000)
      });
      
      if (simpleResponse.ok) {
        const simpleData = await simpleResponse.json();
        if (Array.isArray(simpleData) && simpleData[0] && simpleData[0][0] && simpleData[0][0][0]) {
          translated = simpleData[0][0][0];
          if (translated && translated.length > 0) {
            console.log(`Google Translate (alt): "${translated}"`);
            return translated;
          }
        }
      }
    }
    
    return null;
  } catch (err) {
    console.log('Google Translate error:', err.message);
    return null;
  }
}

// Service 2: LibreTranslate
async function translateLibreTranslate(text, source, target) {
  const langMap = {
    'en': 'en',
    'zh-TW': 'zh',
    'id': 'id'
  };
  
  const sourceLang = langMap[source] || source;
  const targetLang = langMap[target] || target;
  
  if (sourceLang === targetLang) return null;
  
  // Try multiple LibreTranslate instances
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
      if (data.translatedText && data.translatedText.length > 0 && 
          data.translatedText.toLowerCase() !== text.toLowerCase()) {
        console.log(`LibreTranslate: "${data.translatedText}"`);
        return data.translatedText;
      }
    } catch (err) {
      console.log(`LibreTranslate instance failed:`, err.message);
    }
  }
  
  return null;
}

// Service 3: MyMemory
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
        data.responseData.translatedText.length > 0 &&
        data.responseData.translatedText.toLowerCase() !== text.toLowerCase()) {
      console.log(`MyMemory: "${data.responseData.translatedText}"`);
      return data.responseData.translatedText;
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
  console.log('🔄 Using multiple translation services:');
  console.log('  1. Google Translate (unofficial)');
  console.log('  2. LibreTranslate');
  console.log('  3. MyMemory');
  console.log('📝 Enhanced Chinese translation support');
  console.log('=============================');
});
