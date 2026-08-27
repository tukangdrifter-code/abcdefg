const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
const client = new line.Client(config);

// Health check so Render/UptimeRobot has something to ping
app.get('/', (req, res) => res.send('LINE translator bot is running'));

app.post('/webhook', line.middleware(config), (req, res) => {
  res.status(200).end(); // ack LINE immediately
  Promise.all((req.body.events || []).map(handleEvent)).catch((err) =>
    console.error('handleEvent error:', err)
  );
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text.trim();
  if (!text) return;

  const detected = detectLanguage(text);
  // Fixed output order: English first (unless English was the input),
  // then whichever of zh-TW / id remains.
  const targets = ['en', 'zh-TW', 'id'].filter((code) => code !== detected);

  const translations = await Promise.all(
    targets.map((target) => translate(text, detected, target))
  );

  const messages = translations
    .filter(Boolean)
    .map((t) => ({ type: 'text', text: t }));

  if (messages.length === 0) return;
  await client.replyMessage(event.replyToken, messages);
}

// --- Language detection (free, offline, no API call) ---
// Traditional Chinese input always contains CJK characters, so that check
// is fully reliable. Between English and Indonesian we score common
// Indonesian function words; anything not matched defaults to English.
const INDONESIAN_WORDS = new Set([
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'tidak', 'ini', 'itu',
  'saya', 'kamu', 'anda', 'adalah', 'akan', 'juga', 'ada', 'apa', 'kalau',
  'kalo', 'gimana', 'bagaimana', 'sudah', 'udah', 'belum', 'mau', 'bisa',
  'kenapa', 'karena', 'tapi', 'atau', 'jadi', 'sama', 'lagi', 'nanti',
  'sekarang', 'kita', 'kami', 'mereka', 'dia', 'aku', 'terima', 'kasih',
  'selamat', 'pagi', 'siang', 'malam', 'baik', 'tolong', 'maaf',
]);

function detectLanguage(text) {
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-TW';

  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const hits = words.filter((w) => INDONESIAN_WORDS.has(w)).length;
  return hits > 0 ? 'id' : 'en';
}

// --- Translation via MyMemory (free, no API key, ~5000 words/day/IP) ---
async function translate(text, source, target) {
  const langpair = `${source}|${target}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(
    text
  )}&langpair=${encodeURIComponent(langpair)}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error('MyMemory HTTP error:', resp.status);
      return null;
    }
    const data = await resp.json();
    return data?.responseData?.translatedText || null;
  } catch (err) {
    console.error('Translate error:', err);
    return null;
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on port ${port}`));
