// Netlify serverless function: text-to-speech proxy.
// Keeps ELEVENLABS_API_KEY server-side and returns audio + character-level
// timestamps so the client can highlight words in sync with playback.

const ELEVEN_BASE = 'https://api.elevenlabs.io/v1';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return json(500, {
      error: 'Server not configured',
      detail: 'ELEVENLABS_API_KEY environment variable is not set on the deploy.',
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const text = (payload.text || '').toString();
  if (!text.trim()) return json(400, { error: 'No text provided' });
  if (text.length > 5000) {
    return json(400, { error: 'Chunk too long', detail: 'Keep each request under 5000 characters.' });
  }

  const voiceId = (payload.voiceId || '').toString().trim();
  if (!voiceId) return json(400, { error: 'No voiceId provided' });

  // Turbo is the credit-frugal default (~half the cost of multilingual v2)
  // while still sounding natural. Client can override.
  const modelId = (payload.modelId || 'eleven_turbo_v2_5').toString();

  const voiceSettings = payload.voiceSettings && typeof payload.voiceSettings === 'object'
    ? payload.voiceSettings
    : { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true };

  // mp3_44100_128 is broadly supported by <audio> and keeps payload small.
  const url = `${ELEVEN_BASE}/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: voiceSettings,
      }),
    });
  } catch (err) {
    return json(502, { error: 'Upstream request failed', detail: String(err) });
  }

  const raw = await resp.text();
  if (!resp.ok) {
    // Surface ElevenLabs' error so the UI can show quota/voice problems clearly.
    let detail = raw;
    try { detail = JSON.parse(raw); } catch {}
    return json(resp.status, { error: 'ElevenLabs error', detail });
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json(502, { error: 'Unexpected upstream response' });
  }

  // Pass through only what the client needs. Prefer `alignment` (maps to the
  // ORIGINAL characters we sent) so the client can highlight the exact text on
  // screen; fall back to normalized_alignment if that's all we got.
  return json(200, {
    audio_base64: data.audio_base64,
    alignment: data.alignment || data.normalized_alignment || null,
  });
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...cors() },
    body: JSON.stringify(obj),
  };
}
