/* =========================================================================
   Speechify Personal — frontend logic
   - Local library (IndexedDB), ElevenLabs neural voices via Netlify functions
   - Lazy, per-segment synthesis with audio caching (credits spent once)
   - Word-level highlighting from ElevenLabs character timestamps
   - Speed via playbackRate (free — never re-synthesizes)
   ========================================================================= */

'use strict';

/* ---------- Config ---------- */
const API = {
  tts: '/api/tts',
  voices: '/api/voices',
  subscription: '/api/subscription',
};
const MAX_SEG_CHARS = 300;   // target characters per synthesis chunk
const HARD_SPLIT_CHARS = 700; // force-split a single sentence longer than this

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const el = {
  main: $('main'),
  libraryView: $('libraryView'),
  readerView: $('readerView'),
  pasteArea: $('pasteArea'),
  titleInput: $('titleInput'),
  addTextBtn: $('addTextBtn'),
  fileInput: $('fileInput'),
  importHint: $('importHint'),
  libraryList: $('libraryList'),
  libraryEmpty: $('libraryEmpty'),
  libraryCount: $('libraryCount'),
  readerTitle: $('readerTitle'),
  readerBody: $('readerBody'),
  backBtn: $('backBtn'),
  deleteBtn: $('deleteBtn'),
  player: $('player'),
  playBtn: $('playBtn'),
  playIcon: $('playIcon'),
  pauseIcon: $('pauseIcon'),
  prevBtn: $('prevBtn'),
  nextBtn: $('nextBtn'),
  playerStatus: $('playerStatus'),
  progressBar: $('progressBar'),
  progressFill: $('progressFill'),
  voiceSelect: $('voiceSelect'),
  speedSelect: $('speedSelect'),
  modelSelect: $('modelSelect'),
  fontSizeRange: $('fontSizeRange'),
  stabilityRange: $('stabilityRange'),
  similarityRange: $('similarityRange'),
  stabilityVal: $('stabilityVal'),
  similarityVal: $('similarityVal'),
  creditsBadge: $('creditsBadge'),
  creditsText: $('creditsText'),
  themeBtn: $('themeBtn'),
  homeBtn: $('homeBtn'),
  settingsBtn: $('settingsBtn'),
  settingsDrawer: $('settingsDrawer'),
  clearCacheBtn: $('clearCacheBtn'),
  cacheSizeHint: $('cacheSizeHint'),
  toast: $('toast'),
};

/* ---------- App state ---------- */
const state = {
  settings: {
    theme: 'dark',
    voiceId: '',
    modelId: 'eleven_turbo_v2_5',
    speed: 1,
    fontSize: 20,
    stability: 0.5,
    similarity: 0.75,
  },
  voices: [],
  doc: null,          // { id, title, segments:[{text,paraIndex}], ... }
  segEls: [],         // rendered .seg elements per segment
  words: [],          // per-segment computed word arrays (lazy)
  currentIndex: 0,
  isPlaying: false,
  lastWordIdx: -1,
  urlCache: new Map(), // cacheKey -> objectURL (session only)
  synthInFlight: new Map(), // cacheKey -> Promise
};

const audioEl = new Audio();
audioEl.preload = 'auto';

/* =========================================================================
   IndexedDB
   ========================================================================= */
let dbPromise;
function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('speechify', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function idbGet(store, key) {
  const d = await db();
  return new Promise((res, rej) => {
    const r = d.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(store, val) {
  const d = await db();
  return new Promise((res, rej) => {
    const r = d.transaction(store, 'readwrite').objectStore(store).put(val);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}
async function idbDelete(store, key) {
  const d = await db();
  return new Promise((res, rej) => {
    const r = d.transaction(store, 'readwrite').objectStore(store).delete(key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}
async function idbAll(store) {
  const d = await db();
  return new Promise((res, rej) => {
    const r = d.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}
async function idbClear(store) {
  const d = await db();
  return new Promise((res, rej) => {
    const r = d.transaction(store, 'readwrite').objectStore(store).clear();
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}

/* =========================================================================
   Utilities
   ========================================================================= */
function uid() {
  return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function b64ToBlob(b64, type = 'audio/mpeg') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
let toastTimer;
function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
}
function fmtCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k';
  return String(n);
}

/* =========================================================================
   Settings persistence
   ========================================================================= */
async function loadSettings() {
  const saved = await idbGet('settings', 'app');
  if (saved && saved.v) Object.assign(state.settings, saved.v);
  applySettingsToUI();
}
async function saveSettings() {
  await idbPut('settings', { k: 'app', v: state.settings });
}
function applySettingsToUI() {
  const s = state.settings;
  document.body.dataset.theme = s.theme;
  el.speedSelect.value = String(s.speed);
  el.modelSelect.value = s.modelId;
  el.fontSizeRange.value = s.fontSize;
  el.stabilityRange.value = s.stability;
  el.similarityRange.value = s.similarity;
  el.stabilityVal.textContent = Number(s.stability).toFixed(2);
  el.similarityVal.textContent = Number(s.similarity).toFixed(2);
  document.documentElement.style.setProperty('--read-size', s.fontSize + 'px');
  audioEl.playbackRate = s.speed;
}

/* =========================================================================
   Text -> segments
   ========================================================================= */
function splitSentences(paragraph) {
  const matches = paragraph.match(/[^.!?…]+[.!?…]+(?:["'”’)\]]+)?\s*|[^.!?…]+$/g);
  return (matches || [paragraph]).map((s) => s.trim()).filter(Boolean);
}
function hardSplit(sentence) {
  // Split an over-long sentence on whitespace near HARD_SPLIT_CHARS boundaries.
  const out = [];
  let rest = sentence;
  while (rest.length > HARD_SPLIT_CHARS) {
    let cut = rest.lastIndexOf(' ', HARD_SPLIT_CHARS);
    if (cut < HARD_SPLIT_CHARS * 0.5) cut = HARD_SPLIT_CHARS;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
function buildSegments(text) {
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
  const segments = [];
  paragraphs.forEach((para, paraIndex) => {
    let sentences = splitSentences(para).flatMap((s) => (s.length > HARD_SPLIT_CHARS ? hardSplit(s) : [s]));
    let buf = '';
    const flush = () => { if (buf.trim()) { segments.push({ text: buf.trim(), paraIndex }); buf = ''; } };
    for (const sent of sentences) {
      if (buf && (buf.length + sent.length + 1) > MAX_SEG_CHARS) flush();
      buf += (buf ? ' ' : '') + sent;
      if (buf.length >= MAX_SEG_CHARS) flush();
    }
    flush();
  });
  if (!segments.length && text.trim()) segments.push({ text: text.trim(), paraIndex: 0 });
  return segments;
}

/* =========================================================================
   Library
   ========================================================================= */
async function renderLibrary() {
  const docs = (await idbAll('docs')).sort((a, b) => b.updatedAt - a.updatedAt);
  el.libraryList.innerHTML = '';
  el.libraryCount.textContent = docs.length ? `${docs.length} item${docs.length > 1 ? 's' : ''}` : '';
  el.libraryEmpty.hidden = docs.length > 0;
  for (const doc of docs) {
    const li = document.createElement('li');
    li.className = 'doc-item';
    const total = doc.segments.length;
    const pos = Math.min(doc.progressIndex || 0, total);
    const pct = total ? Math.round((pos / total) * 100) : 0;
    const chars = doc.charCount || 0;
    li.innerHTML = `
      <div class="doc-play" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M8 5v14l11-7L8 5Z"/></svg>
      </div>
      <div class="doc-meta">
        <div class="doc-title"></div>
        <div class="doc-sub">${fmtCount(chars)} chars · ${total} sentences${pct ? ` · ${pct}% listened` : ''}</div>
        <div class="doc-bar"><i style="width:${pct}%"></i></div>
      </div>`;
    li.querySelector('.doc-title').textContent = doc.title || 'Untitled';
    li.addEventListener('click', () => openDoc(doc.id));
    el.libraryList.appendChild(li);
  }
}

async function addDocument(title, text) {
  const clean = text.trim();
  if (!clean) { toast('Nothing to add — the text is empty.'); return; }
  const segments = buildSegments(clean);
  const doc = {
    id: uid(),
    title: (title || '').trim() || deriveTitle(clean),
    segments,
    charCount: clean.length,
    progressIndex: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await idbPut('docs', doc);
  el.pasteArea.value = '';
  el.titleInput.value = '';
  await renderLibrary();
  toast('Added to your library.');
  openDoc(doc.id);
}
function deriveTitle(text) {
  const firstLine = text.split('\n').find((l) => l.trim()) || 'Untitled';
  return firstLine.trim().slice(0, 60) + (firstLine.length > 60 ? '…' : '');
}

/* =========================================================================
   Import: file / PDF
   ========================================================================= */
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}
async function extractPdf(file) {
  el.importHint.textContent = 'Loading PDF reader…';
  if (!window.pdfjsLib) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    el.importHint.textContent = `Extracting page ${p} of ${pdf.numPages}…`;
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim());
  }
  return pages.join('\n\n');
}
async function handleFile(file) {
  if (!file) return;
  try {
    let text = '';
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      text = await extractPdf(file);
    } else {
      text = await file.text();
    }
    el.importHint.textContent = '';
    if (!text.trim()) { toast('Could not read any text from that file.'); return; }
    await addDocument(file.name.replace(/\.[^.]+$/, ''), text);
  } catch (err) {
    el.importHint.textContent = '';
    toast('Import failed: ' + err.message);
  }
}

/* =========================================================================
   Reader rendering
   ========================================================================= */
function renderReader(doc) {
  state.doc = doc;
  state.segEls = [];
  state.words = new Array(doc.segments.length).fill(null);
  state.currentIndex = Math.min(doc.progressIndex || 0, Math.max(0, doc.segments.length - 1));
  state.lastWordIdx = -1;
  el.readerTitle.textContent = doc.title;
  el.readerBody.innerHTML = '';

  // Group segments into <p> by paragraph.
  let curPara = -1, pEl = null;
  doc.segments.forEach((seg, i) => {
    if (seg.paraIndex !== curPara) {
      curPara = seg.paraIndex;
      pEl = document.createElement('p');
      el.readerBody.appendChild(pEl);
    }
    const span = document.createElement('span');
    span.className = 'seg';
    span.dataset.i = i;
    span.textContent = seg.text + ' ';
    span.addEventListener('click', () => { loadSegment(i, true); });
    pEl.appendChild(span);
    state.segEls[i] = span;
  });
  markActiveSegment(state.currentIndex, false);
}

function markActiveSegment(i, scroll = true) {
  state.segEls.forEach((s, k) => s && s.classList.toggle('active', k === i));
  if (scroll && state.segEls[i]) {
    state.segEls[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

/* Build per-word spans + timings from ElevenLabs alignment. */
function buildWords(i, alignment) {
  const segEl = state.segEls[i];
  if (!alignment || !alignment.characters || !segEl) { state.words[i] = []; return; }
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds || [];
  const ends = alignment.character_end_times_seconds || [];
  let html = '', words = [], cur = '', curStart = null, curEnd = null, wi = 0;
  const flush = () => {
    if (cur !== '') {
      html += `<span class="w" data-w="${wi}">${escapeHtml(cur)}</span>`;
      words.push({ start: curStart ?? 0, end: curEnd ?? 0, el: null });
      wi++; cur = ''; curStart = null; curEnd = null;
    }
  };
  for (let c = 0; c < chars.length; c++) {
    const ch = chars[c];
    if (/\s/.test(ch)) { flush(); html += escapeHtml(ch); }
    else { if (cur === '') curStart = starts[c]; curEnd = ends[c]; cur += ch; }
  }
  flush();
  html += ' ';
  segEl.innerHTML = html;
  const nodes = segEl.querySelectorAll('.w');
  words.forEach((w, k) => (w.el = nodes[k]));
  state.words[i] = words;
}

/* =========================================================================
   Synthesis + cache
   ========================================================================= */
async function cacheKeyFor(text) {
  const s = state.settings;
  const h = await sha256(text);
  return `${s.voiceId}|${s.modelId}|s${s.stability}|b${s.similarity}|${h}`;
}

async function ensureAudio(i) {
  // Returns { url, alignment } for segment i, synthesizing + caching if needed.
  const seg = state.doc.segments[i];
  const key = await cacheKeyFor(seg.text);

  if (state.urlCache.has(key)) {
    const rec = await idbGet('audio', key);
    return { url: state.urlCache.get(key), alignment: rec ? rec.alignment : null };
  }
  if (state.synthInFlight.has(key)) return state.synthInFlight.get(key);

  const promise = (async () => {
    let rec = await idbGet('audio', key);
    if (!rec) {
      const s = state.settings;
      const res = await fetch(API.tts, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: seg.text,
          voiceId: s.voiceId,
          modelId: s.modelId,
          voiceSettings: {
            stability: s.stability,
            similarity_boost: s.similarity,
            style: 0,
            use_speaker_boost: true,
          },
        }),
      });
      if (!res.ok) {
        let msg = 'Synthesis failed';
        try { const j = await res.json(); msg = describeError(res.status, j); } catch {}
        throw new Error(msg);
      }
      const data = await res.json();
      const blob = b64ToBlob(data.audio_base64);
      rec = { key, blob, alignment: data.alignment, bytes: blob.size, createdAt: Date.now() };
      await idbPut('audio', rec);
      scheduleCreditsRefresh();
    }
    const url = URL.createObjectURL(rec.blob);
    state.urlCache.set(key, url);
    return { url, alignment: rec.alignment };
  })();

  state.synthInFlight.set(key, promise);
  try { return await promise; }
  finally { state.synthInFlight.delete(key); }
}

function describeError(status, j) {
  const d = j && j.detail;
  if (status === 401) return 'ElevenLabs rejected the API key. Check the ELEVENLABS_API_KEY on Netlify.';
  if (status === 402 || (d && JSON.stringify(d).includes('quota'))) return 'Out of ElevenLabs credits for this month.';
  if (status === 500 && j.error === 'Server not configured') return 'Set ELEVENLABS_API_KEY in Netlify → Site settings → Environment variables.';
  if (d && d.detail && d.detail.message) return d.detail.message;
  if (typeof d === 'string') return d.slice(0, 140);
  return (j && j.error) || ('Error ' + status);
}

/* =========================================================================
   Playback engine
   ========================================================================= */
async function loadSegment(i, autoplay) {
  if (!state.doc) return;
  if (i < 0 || i >= state.doc.segments.length) { stopPlayback(); return; }
  if (!state.settings.voiceId) { toast('Pick a voice first.'); return; }

  clearWordHighlight();
  state.currentIndex = i;
  markActiveSegment(i);
  setStatus('Generating…');
  el.playerStatus.classList.add('busy');

  let out;
  try {
    out = await ensureAudio(i);
  } catch (err) {
    setStatus('');
    setPlaying(false);
    toast(err.message, 4200);
    return;
  }
  // If the user navigated away while we were synthesizing, bail.
  if (state.currentIndex !== i) return;

  if (state.words[i] === null) buildWords(i, out.alignment);
  audioEl.src = out.url;
  audioEl.playbackRate = state.settings.speed;
  setStatus(`Sentence ${i + 1} / ${state.doc.segments.length}`);

  saveProgress(i);
  prefetchNext(i);

  if (autoplay) {
    try { await audioEl.play(); setPlaying(true); }
    catch { setPlaying(false); }
  }
}

async function prefetchNext(i) {
  const n = i + 1;
  if (n >= state.doc.segments.length) return;
  ensureAudio(n).catch(() => {}); // best-effort warm cache
}

function setPlaying(v) {
  state.isPlaying = v;
  el.playIcon.hidden = v;
  el.pauseIcon.hidden = !v;
}
function setStatus(t) { el.playerStatus.textContent = t; if (!t) el.playerStatus.classList.remove('busy'); }

function togglePlay() {
  if (!state.doc) return;
  if (audioEl.src && !audioEl.ended && audioEl.currentTime > 0 && !state.isPlaying) {
    audioEl.play(); setPlaying(true); return;
  }
  if (state.isPlaying) { audioEl.pause(); setPlaying(false); return; }
  loadSegment(state.currentIndex, true);
}
function stopPlayback() {
  audioEl.pause();
  setPlaying(false);
  setStatus('Finished');
  clearWordHighlight();
}

function clearWordHighlight() {
  const words = state.words[state.currentIndex];
  if (Array.isArray(words)) words.forEach((w) => w.el && w.el.classList.remove('active', 'spoken'));
  state.lastWordIdx = -1;
}

/* Highlight the word matching the current audio time. */
function onTimeUpdate() {
  const words = state.words[state.currentIndex];
  if (!Array.isArray(words) || !words.length) { updateProgress(); return; }
  const t = audioEl.currentTime;
  let idx = state.lastWordIdx;
  // advance forward
  while (idx + 1 < words.length && t >= words[idx + 1].start) idx++;
  // rewind if user scrubbed back
  while (idx > 0 && t < words[idx].start) idx--;
  if (idx !== state.lastWordIdx) {
    if (words[state.lastWordIdx] && words[state.lastWordIdx].el) {
      words[state.lastWordIdx].el.classList.remove('active');
      words[state.lastWordIdx].el.classList.add('spoken');
    }
    for (let k = 0; k <= idx; k++) if (words[k].el) words[k].el.classList.add('spoken');
    if (words[idx] && words[idx].el) {
      words[idx].el.classList.remove('spoken');
      words[idx].el.classList.add('active');
    }
    state.lastWordIdx = idx;
  }
  updateProgress();
}

function updateProgress() {
  const total = state.doc ? state.doc.segments.length : 0;
  if (!total) { el.progressFill.style.width = '0%'; return; }
  const frac = audioEl.duration ? (audioEl.currentTime / audioEl.duration) : 0;
  const overall = (state.currentIndex + Math.min(frac, 1)) / total;
  el.progressFill.style.width = (overall * 100).toFixed(2) + '%';
}

function saveProgress(i) {
  if (!state.doc) return;
  state.doc.progressIndex = i;
  state.doc.updatedAt = Date.now();
  idbPut('docs', state.doc).catch(() => {});
}

/* =========================================================================
   Voices + credits
   ========================================================================= */
async function loadVoices() {
  try {
    const res = await fetch(API.voices);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      el.voiceSelect.innerHTML = '<option>Voices unavailable</option>';
      toast(describeError(res.status, j), 5000);
      return;
    }
    const { voices } = await res.json();
    state.voices = voices || [];
    el.voiceSelect.innerHTML = '';
    for (const v of state.voices) {
      const opt = document.createElement('option');
      opt.value = v.voice_id;
      const desc = v.labels && (v.labels.accent || v.labels.description);
      opt.textContent = desc ? `${v.name} · ${desc}` : v.name;
      el.voiceSelect.appendChild(opt);
    }
    if (!state.settings.voiceId && state.voices[0]) state.settings.voiceId = state.voices[0].voice_id;
    if (state.settings.voiceId) el.voiceSelect.value = state.settings.voiceId;
    saveSettings();
  } catch {
    el.voiceSelect.innerHTML = '<option>Offline</option>';
  }
}

let creditsTimer;
function scheduleCreditsRefresh() {
  clearTimeout(creditsTimer);
  creditsTimer = setTimeout(loadCredits, 2500);
}
async function loadCredits() {
  try {
    const res = await fetch(API.subscription);
    if (!res.ok) throw new Error();
    const d = await res.json();
    const badge = el.creditsBadge;
    badge.classList.remove('err');
    el.creditsText.textContent = `${fmtCount(d.remaining)} credits left`;
    badge.classList.toggle('low', d.limit > 0 && d.remaining / d.limit < 0.1);
    badge.title = `${d.used.toLocaleString()} / ${d.limit.toLocaleString()} characters used this cycle`;
  } catch {
    el.creditsBadge.classList.add('err');
    el.creditsText.textContent = 'credits n/a';
  }
}

/* =========================================================================
   Open / delete document
   ========================================================================= */
async function openDoc(id) {
  const doc = await idbGet('docs', id);
  if (!doc) return;
  resetPlayer();
  renderReader(doc);
  el.libraryView.hidden = true;
  el.readerView.hidden = false;
  el.player.hidden = false;
  setStatus(`Sentence ${state.currentIndex + 1} / ${doc.segments.length}`);
  window.scrollTo(0, 0);
}
function closeReader() {
  resetPlayer();
  state.doc = null;
  el.readerView.hidden = true;
  el.player.hidden = true;
  el.libraryView.hidden = false;
  renderLibrary();
}
function resetPlayer() {
  audioEl.pause();
  audioEl.removeAttribute('src');
  audioEl.load();
  setPlaying(false);
  setStatus('');
  el.progressFill.style.width = '0%';
  // free session object URLs
  for (const url of state.urlCache.values()) URL.revokeObjectURL(url);
  state.urlCache.clear();
  state.synthInFlight.clear();
}
async function deleteCurrentDoc() {
  if (!state.doc) return;
  if (!confirm(`Delete "${state.doc.title}"? Cached audio for it stays until you clear the cache.`)) return;
  await idbDelete('docs', state.doc.id);
  toast('Deleted.');
  closeReader();
}

/* =========================================================================
   Cache maintenance
   ========================================================================= */
async function refreshCacheSize() {
  try {
    const all = await idbAll('audio');
    const bytes = all.reduce((sum, r) => sum + (r.bytes || 0), 0);
    el.cacheSizeHint.textContent = all.length
      ? `${all.length} clips cached · ${(bytes / 1048576).toFixed(1)} MB`
      : 'No audio cached yet.';
  } catch { el.cacheSizeHint.textContent = ''; }
}
async function clearCache() {
  await idbClear('audio');
  for (const url of state.urlCache.values()) URL.revokeObjectURL(url);
  state.urlCache.clear();
  toast('Cached audio cleared.');
  refreshCacheSize();
}

/* =========================================================================
   Events
   ========================================================================= */
function wireEvents() {
  el.addTextBtn.addEventListener('click', () => addDocument(el.titleInput.value, el.pasteArea.value));
  el.fileInput.addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });
  el.backBtn.addEventListener('click', closeReader);
  el.homeBtn.addEventListener('click', () => { if (!el.readerView.hidden) closeReader(); });
  el.deleteBtn.addEventListener('click', deleteCurrentDoc);

  el.playBtn.addEventListener('click', togglePlay);
  el.prevBtn.addEventListener('click', () => loadSegment(state.currentIndex - 1, true));
  el.nextBtn.addEventListener('click', () => loadSegment(state.currentIndex + 1, true));

  audioEl.addEventListener('timeupdate', onTimeUpdate);
  audioEl.addEventListener('ended', () => {
    if (state.currentIndex + 1 < state.doc.segments.length) loadSegment(state.currentIndex + 1, true);
    else stopPlayback();
  });
  audioEl.addEventListener('play', () => setPlaying(true));
  audioEl.addEventListener('pause', () => { if (!audioEl.ended) setPlaying(false); });

  el.progressBar.addEventListener('click', (e) => {
    if (!state.doc) return;
    const rect = el.progressBar.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const target = Math.min(state.doc.segments.length - 1, Math.floor(frac * state.doc.segments.length));
    loadSegment(target, true);
  });

  el.speedSelect.addEventListener('change', () => {
    state.settings.speed = parseFloat(el.speedSelect.value);
    audioEl.playbackRate = state.settings.speed;
    saveSettings();
  });
  el.voiceSelect.addEventListener('change', () => {
    state.settings.voiceId = el.voiceSelect.value;
    saveSettings();
    onVoiceOrModelChange();
  });
  el.modelSelect.addEventListener('change', () => {
    state.settings.modelId = el.modelSelect.value;
    saveSettings();
    onVoiceOrModelChange();
  });
  el.fontSizeRange.addEventListener('input', () => {
    state.settings.fontSize = parseInt(el.fontSizeRange.value, 10);
    document.documentElement.style.setProperty('--read-size', state.settings.fontSize + 'px');
    saveSettings();
  });
  el.stabilityRange.addEventListener('input', () => {
    state.settings.stability = parseFloat(el.stabilityRange.value);
    el.stabilityVal.textContent = state.settings.stability.toFixed(2);
    saveSettings();
  });
  el.similarityRange.addEventListener('input', () => {
    state.settings.similarity = parseFloat(el.similarityRange.value);
    el.similarityVal.textContent = state.settings.similarity.toFixed(2);
    saveSettings();
  });

  el.themeBtn.addEventListener('click', () => {
    state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
    document.body.dataset.theme = state.settings.theme;
    saveSettings();
  });

  el.settingsBtn.addEventListener('click', () => { el.settingsDrawer.hidden = false; refreshCacheSize(); });
  el.settingsDrawer.querySelectorAll('[data-close-settings]').forEach((n) =>
    n.addEventListener('click', () => (el.settingsDrawer.hidden = true)));
  el.clearCacheBtn.addEventListener('click', clearCache);

  document.addEventListener('keydown', (e) => {
    const typing = /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement.tagName);
    if (typing || el.readerView.hidden) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); loadSegment(state.currentIndex + 1, true); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); loadSegment(state.currentIndex - 1, true); }
  });
}

function onVoiceOrModelChange() {
  // New voice/model => different cached audio. Re-cue current sentence so the
  // change is audible from where the user is (this will spend credits once).
  if (!state.doc) return;
  const wasPlaying = state.isPlaying;
  audioEl.pause();
  setPlaying(false);
  toast('Voice updated — new audio will be generated for what you play next.');
  loadSegment(state.currentIndex, wasPlaying);
}

/* =========================================================================
   Init
   ========================================================================= */
async function init() {
  await loadSettings();
  wireEvents();
  await renderLibrary();
  loadVoices();
  loadCredits();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}
init();
