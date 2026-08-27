const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001'; // fast + cheap, plenty for translation

const app = express();
const client = new line.Client(config);

// Health check so Render doesn't think the service is down
app.get('/', (req, res) => res.send('LINE translator bot is running'));

app.post('/webhook', line.middleware(config), (req, res) => {
  // Respond to LINE immediately, then do the work
  res.status(200).end();
  Promise.all((req.body.events || []).map(handleEvent)).catch((err) =>
    console.error('handleEvent error:', err)
  );
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text.trim();
  if (!text) return;

  const messages = await translate(text);
  if (!messages || messages.length === 0) return;

  // replyMessage sends both bubbles back-to-back near-instantly, and is free
  // (doesn't use your monthly push-message quota).
  await client.replyMessage(event.replyToken, messages);
}

async function translate(text) {
  const prompt = `Detect the language of this message. It will be one of: Traditional Chinese (zh-Hant), English (en), or Indonesian (id).

Message: ${JSON.stringify(text)}

Then translate it into the OTHER TWO languages from that list (not the detected one).

Respond with ONLY raw JSON (no markdown fences, no commentary), in this exact shape:
{"detected":"zh-Hant" or "en" or "id","en":"...translation or omitted if detected","zh-Hant":"...translation or omitted if detected","id":"...translation or omitted if detected"}

Only include the two keys that are NOT the detected language.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    console.error('Anthropic API error:', resp.status, await resp.text());
    return null;
  }

  const data = await resp.json();
  const raw = (data.content || []).map((c) => c.text || '').join('');
  const clean = raw.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    console.error('Failed to parse translation JSON:', clean);
    return null;
  }

  // Fixed output order: English first (unless English was the input),
  // then whichever of zh-Hant / id remains.
  const order = ['en', 'zh-Hant', 'id'].filter((code) => code !== parsed.detected);

  return order
    .filter((code) => parsed[code])
    .map((code) => ({ type: 'text', text: parsed[code] }));
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on port ${port}`));
