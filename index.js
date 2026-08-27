// LINE Group Auto-Translator Bot
// Translates between Traditional Chinese (zh-TW), English (en), and Indonesian (id).
// Whichever language a message is written in, the bot replies with the other two.
//
// Free stack:
//  - LINE Messaging API (free for this use case)
//  - MyMemory Translation API (free, no signup, no API key)
//  - franc-min (offline language guesser, used only to tell English apart from Indonesian)

const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
const { franc } = require("franc-min");

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// ---- Language detection -----------------------------------------------

// Returns one of "zh-TW", "en", "id"
function detectLanguage(text) {
  // 1) If it contains any CJK ideograph, treat it as Chinese.
  const hasChinese = /[\u4e00-\u9fff]/.test(text);
  if (hasChinese) return "zh-TW";

  // 2) Otherwise decide between English and Indonesian.
  //    franc, restricted to just these two candidates, is quite reliable.
  const guess = franc(text, { only: ["eng", "ind"] });
  if (guess === "ind") return "id";
  return "en"; // default / fallback, including "und" (undetermined) on short text
}

// ---- Translation --------------------------------------------------------

// MyMemory language codes: zh-TW, en, id
async function translate(text, sourceLang, targetLang) {
  const params = {
    q: text,
    langpair: `${sourceLang}|${targetLang}`,
  };
  // Optional: set MYMEMORY_EMAIL in your environment variables to raise
  // MyMemory's free daily limit from ~5,000 to ~50,000 words/day. Any email works.
  if (process.env.MYMEMORY_EMAIL) params.de = process.env.MYMEMORY_EMAIL;

  const res = await axios.get("https://api.mymemory.translated.net/get", {
    params,
    timeout: 8000,
  });
  return res.data?.responseData?.translatedText || "(translation failed)";
}

const LANG_LABEL = {
  "zh-TW": "🇹🇼 中文",
  en: "🇬🇧 English",
  id: "🇮🇩 Indonesia",
};

async function buildTranslationReply(text) {
  const source = detectLanguage(text);
  const targets = ["zh-TW", "en", "id"].filter((l) => l !== source);

  const translations = await Promise.all(
    targets.map((t) => translate(text, source, t))
  );

  return targets
    .map((lang, i) => `${LANG_LABEL[lang]}: ${translations[i]}`)
    .join("\n");
}

// ---- Webhook --------------------------------------------------------------

app.post("/webhook", line.middleware(config), async (req, res) => {
  res.status(200).end(); // ack LINE immediately

  const events = req.body.events || [];
  for (const event of events) {
    try {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const text = event.message.text.trim();
      if (!text) continue;

      const replyText = await buildTranslationReply(text);

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: replyText }],
      });
    } catch (err) {
      console.error("Error handling event:", err?.response?.data || err.message);
    }
  }
});

// Simple health check so you can confirm the server is alive (e.g. on Render)
app.get("/", (req, res) => res.send("LINE translator bot is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
