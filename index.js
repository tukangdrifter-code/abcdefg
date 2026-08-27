const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// Validate config on startup
if (!config.channelAccessToken || !config.channelSecret) {
  console.error('ERROR: Missing LINE credentials! Check environment variables.');
  process.exit(1);
}

const app = express();
const client = new line.Client(config);

// Health check
app.get('/', (req, res) => res.send('LINE translator bot is running'));

// Webhook endpoint
app.post('/webhook', line.middleware(config), (req, res) => {
  // Always respond immediately to LINE
  res.status(200).end();
  
  if (!req.body.events) {
    console.log('No events in request');
    return;
  }
  
  // Process each event
  req.body.events.forEach(event => {
    handleEvent(event).catch(err => {
      console.error('Event handling error:', err);
    });
  });
});

async function handleEvent(event) {
  try {
    // Skip non-text messages
    if (event.type !== 'message' || event.message.type !== 'text') {
      return;
    }

    const text = event.message.text.trim();
    if (!text) return;

    console.log('Processing text:', text);
    
    // Detect language
    const detected = detectLanguage(text);
    console.log('Detected language:', detected);
    
    // Determine target languages
    const targets = ['en', 'zh-TW', 'id'].filter(code => code !== detected);
    console.log('Target languages:', targets.join(', '));
    
    if (targets.length === 0) {
      console.log('No target languages to translate to');
      return;
    }

    // Get translations
    const translations = await Promise.all(
      targets.map(target => translate(text, detected, target))
    );
    
    console.log('Translations received:', translations.filter(Boolean).length);

    // Build reply messages
    const messages = translations
      .filter(Boolean)
      .map(translatedText => ({ 
        type: 'text', 
        text: translatedText 
      }));

    if (messages.length === 0) {
      console.log('No valid translations to send');
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'Sorry, translation service is temporarily unavailable. Please try again later.'
      });
      return;
    }

    console.log(`Replying with ${messages.length} messages`);
    await client.replyMessage(event.replyToken, messages);
    console.log('Reply sent successfully!');
    
  } catch (error) {
    console.error('Error in handleEvent:', error);
    // Try to send error message to user
    try {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'Sorry, I encountered an error. Please try again later.'
      });
    } catch (replyError) {
      console.error('Failed to send error message:', replyError);
    }
  }
}

function detectLanguage(text) {
  // Check for Traditional Chinese (CJK characters)
  if (/[\u4e00-\u9fff]/.test(text)) {
    return 'zh-TW';
  }

  // Check for Indonesian
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
  console.log(`Indonesian word hits: ${hits}/${words.length}`);
  return hits > 0 ? 'id' : 'en';
}

// --- Translation using LibreTranslate (FREE, no API key needed) ---
async function translate(text, source, target) {
  // Map language codes to LibreTranslate format
  const langMap = {
    'en': 'en',
    'zh-TW': 'zh',  // LibreTranslate uses 'zh' for Chinese (simplified)
    'id': 'id'
  };
  
  const sourceLang = langMap[source] || source;
  const targetLang = langMap[target] || target;
  
  // If source and target are the same after mapping, skip
  if (sourceLang === targetLang) {
    console.log('Source and target are the same, skipping');
    return null;
  }
  
  // Use the public LibreTranslate instance
  const url = 'https://libretranslate.com/translate';
  
  const requestBody = {
    q: text,
    source: sourceLang,
    target: targetLang,
    format: 'text'
  };

  try {
    console.log(`Translating [${sourceLang}->${targetLang}]: "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      console.error(`LibreTranslate HTTP error: ${response.status}`);
      // If LibreTranslate fails, try MyMemory as fallback
      return translateMyMemory(text, source, target);
    }

    const data = await response.json();
    
    if (data.translatedText) {
      const translated = data.translatedText;
      console.log(`Translation result: "${translated.substring(0, 30)}${translated.length > 30 ? '...' : ''}"`);
      return translated;
    } else {
      console.error('No translation in response:', data);
      return null;
    }
  } catch (err) {
    console.error('Translation error:', err);
    // Try MyMemory as fallback
    return translateMyMemory(text, source, target);
  }
}

// --- Fallback: MyMemory (if LibreTranslate fails) ---
async function translateMyMemory(text, source, target) {
  const langpair = `${source}|${target}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langpair)}`;

  try {
    console.log(`Falling back to MyMemory [${source}->${target}]`);
    const resp = await fetch(url);
    
    if (resp.status === 429) {
      console.log('MyMemory rate limit hit');
      return null;
    }
    
    if (!resp.ok) {
      console.error('MyMemory HTTP error:', resp.status);
      return null;
    }
    
    const data = await resp.json();
    
    if (data.responseData && data.responseData.translatedText) {
      const translated = data.responseData.translatedText;
      console.log(`MyMemory translation: "${translated}"`);
      return translated;
    }
    
    return null;
  } catch (err) {
    console.error('MyMemory error:', err);
    return null;
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('=== LINE Translator Bot ===');
  console.log(`Listening on port ${port}`);
  console.log('Using LibreTranslate (free, no API key)');
  console.log('===========================');
});
