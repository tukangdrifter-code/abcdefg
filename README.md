# LINE Group Translator Bot (100% Free)

Auto-translates any message sent in a LINE group between **Traditional Chinese, English, and Indonesian** — whichever language you write in, the bot replies with the other two.

- **Cost: $0.** No credit card needed anywhere in this setup.
- Translation → [MyMemory](https://mymemory.translated.net/) free public API, no signup, no API key.
- Hosting → Render.com free web service tier.
- Always-on → UptimeRobot free keep-alive pinger.

---

## Part 1 — Create the LINE bot

1. Go to https://developers.line.biz/console/ and log in.
2. Create a **Provider** (any name).
3. Inside that provider, click **Create a new channel** → choose **Messaging API** specifically.
   ⚠️ Not "LINE Login" — that's a different channel type with no bot/webhook features at all.
4. Fill in the required fields (name, description, category — anything reasonable works).
5. Open the new channel → **Messaging API** tab. You'll see:
   - **Channel secret** — near the top. This is `LINE_CHANNEL_SECRET`.
   - **Channel access token (long-lived)** — further down. Click **Issue**, then copy the long token that appears. This is `LINE_CHANNEL_ACCESS_TOKEN`.
6. On that same tab:
   - **"Allow bot to join group chats"** — click **Edit** and set it to **Enabled**. (Without this, you can never add the bot to your teacher's group.)
   - **Auto-reply messages** and **Greeting messages** — both default to Enabled. Turn both **off** (edit these from the linked LINE Official Account Manager page) so LINE's canned responses don't interfere with the bot's real replies.
7. Note the **QR code** on this page — you'll scan it later to add the bot as a friend and invite it into the group.

Leave **Webhook URL** blank for now — that gets filled in during Part 3, after the bot is deployed.

---

## Part 2 — Deploy the bot for free on Render

1. Put `index.js` and `package.json` (attached) into a GitHub repo.
2. Go to https://render.com → sign up (free, no card) → **New +** → **Web Service** → connect your repo.
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Under **Environment Variables**, add:
   - `LINE_CHANNEL_ACCESS_TOKEN` = (from Part 1)
   - `LINE_CHANNEL_SECRET` = (from Part 1)
5. Click **Create Web Service**. Wait for deploy to finish — you'll get a URL like `https://your-app-name.onrender.com`.

---

## Part 3 — Connect the webhook

1. In the LINE Developers Console → your channel → **Messaging API** tab → **Webhook URL** → **Edit**.
2. Paste: `https://your-app-name.onrender.com/webhook` → **Save**.
3. Click **Verify** — should say Success.
4. Make sure **"Use webhook"** is toggled **on** (there's a separate switch near the Webhook URL field).

---

## Part 4 — Keep it always on (no sleep, no cold start)

Render's free tier sleeps after 15 minutes of no traffic. Since your teacher may message any time, use a free pinger so it never sleeps:

1. Go to https://uptimerobot.com → sign up (free, no card).
2. **Add New Monitor**:
   - **Monitor Type:** HTTP(s)
   - **URL:** `https://your-app-name.onrender.com/` (the root, not `/webhook`)
   - **Monitoring Interval:** 5 minutes (fastest on the free plan — comfortably under Render's 15-minute sleep window)
3. Save.

This keeps the server always warm, uses ~720 of Render's 750 free monthly hours, and stays within UptimeRobot's free personal-use terms.

---

## Part 5 — Add the bot to the group and test

1. Scan the bot's QR code (from Part 1) with your teacher's phone, or whoever's phone will invite it.
2. Add it as a friend, then invite it into your teacher's LINE group.
3. Send a message in Chinese, English, or Indonesian in the group. The bot should reply with translations into the other two languages within a few seconds.

---

## If something breaks

- **No reply at all:** check Render → your service → **Logs** tab for errors. Usually a missing/incorrect environment variable, or the bot was never actually invited into the group.
- **Bot can't be added to the group:** go back to Part 1 step 6 — "Allow bot to join group chats" must be Enabled.
- **Bot replies twice, or with generic LINE messages:** Auto-reply / Greeting messages weren't turned off (Part 1 step 6).
- **Webhook verify fails:** re-copy the access token/secret with no extra spaces or line breaks, and confirm "Use webhook" is on.
- **Wrong language detected:** very short messages ("ok", "hi") are genuinely ambiguous — the bot defaults to English in those cases. Longer sentences detect reliably.
- **Hitting a translation limit:** MyMemory's free tier is generous for a classroom (~5,000 words/day per IP, ~50,000/day if you set `MYMEMORY_EMAIL` as an env var — any email works). If you ever outgrow it, only the `translate()` function in `index.js` needs to change to swap providers.

## Security note

Regenerate (**Reissue**) your Channel access token and Channel secret in the LINE console before going live with the real group, if either value was ever typed, pasted, or shown anywhere outside Render's environment variables.
