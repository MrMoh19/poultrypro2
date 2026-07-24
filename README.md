# Speechify Personal

Your own text-to-speech reader, powered by **ElevenLabs** neural voices. Paste
text, drop a `.txt`, or import a **PDF**, then listen with word-by-word
highlighting — like Speechify, but private and yours.

- **Neural voices** from your ElevenLabs account (any voice you own).
- **Word-level highlighting** synced to the audio.
- **Credit-frugal by design:** audio for each passage is generated once, cached
  in your browser, and replayed for free. Speed changes never re-generate audio.
- **Reads only what you listen to** — synthesis happens sentence-by-sentence, so
  a long PDF only spends credits on the parts you actually play.
- **Installable PWA**, works from your phone home screen, remembers your place.
- **Your API key stays server-side** on Netlify — it never reaches the browser.

## How credits work

ElevenLabs bills per *character synthesized*, not per document opened. Opening
or re-reading a document costs nothing. Pressing play on a *new* passage spends
credits (about **0.5 credits/character** on the Turbo/Flash models, **1×** on
Multilingual v2). Because every generated clip is cached locally, you only ever
pay once per unique passage + voice. The badge in the top bar shows how many
characters you have left this cycle.

---

## Deploy (one-time, ~5 minutes)

### 1. Put this code in a repo
Create an **empty private** GitHub repo (e.g. `speechify-personal`) and push
these files to it.

### 2. Connect it to Netlify
1. Go to [app.netlify.com](https://app.netlify.com) → **Add new site → Import an
   existing project** → pick your repo.
2. Build settings: leave **build command empty**, **publish directory** = `.`
   (the included `netlify.toml` already sets this and the functions directory).
3. Deploy.

### 3. Add your ElevenLabs key (the important step)
In Netlify: **Site configuration → Environment variables → Add a variable**

| Key | Value |
| --- | --- |
| `ELEVENLABS_API_KEY` | *your ElevenLabs API key* |

Get the key from [elevenlabs.io](https://elevenlabs.io) → your profile →
**API Keys**. Then **redeploy** (Deploys → Trigger deploy) so the functions pick
it up.

### 4. Open it
Visit your Netlify URL. Pick a voice, paste some text, press play. On a phone,
use **Share → Add to Home Screen** to install it as an app.

---

## Local development

```bash
npm install -g netlify-cli
netlify env:set ELEVENLABS_API_KEY sk-your-key   # or use a .env file
netlify dev
```

`netlify dev` serves the static site and the functions together at
`http://localhost:8888`.

Create a local `.env` (git-ignored) if you prefer:

```
ELEVENLABS_API_KEY=sk-your-key
```

---

## How it's built

```
index.html          UI shell
styles.css          calm reading theme (dark/light)
app.js              library, import, playback engine, caching, highlighting
manifest.json       PWA manifest
sw.js               service worker (caches app shell; never the API)
netlify.toml        publish dir + /api/* -> function redirects
netlify/functions/
  tts.js            text -> speech + character timestamps (holds the key)
  voices.js         lists your ElevenLabs voices
  subscription.js   character quota for the "credits left" badge
```

Documents and generated audio are stored in the browser via **IndexedDB**. The
serverless functions are the only place the API key lives.

### Settings you can tune
- **Voice model** — Flash (cheapest) · Turbo (recommended) · Multilingual (best,
  2× credits).
- **Voice** — any voice on your ElevenLabs account.
- **Speed** — 0.75×–3× (applied via playback rate; costs no credits).
- **Stability / Similarity** — ElevenLabs voice settings.
- **Text size** and **light/dark theme**.

## Privacy
Everything you add stays on your device. The only network calls are to your own
Netlify functions, which relay text to ElevenLabs and return audio. Nothing is
sent anywhere else.
