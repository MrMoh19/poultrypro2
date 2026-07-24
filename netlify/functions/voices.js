// Netlify serverless function: list the ElevenLabs voices available on the
// account. Cached briefly at the CDN to avoid hammering the API.

const ELEVEN_BASE = 'https://api.elevenlabs.io/v1';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'Server not configured', detail: 'ELEVENLABS_API_KEY is not set.' });
  }

  let resp;
  try {
    resp = await fetch(`${ELEVEN_BASE}/voices`, {
      headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
    });
  } catch (err) {
    return json(502, { error: 'Upstream request failed', detail: String(err) });
  }

  const raw = await resp.text();
  if (!resp.ok) {
    let detail = raw;
    try { detail = JSON.parse(raw); } catch {}
    return json(resp.status, { error: 'ElevenLabs error', detail });
  }

  let data;
  try { data = JSON.parse(raw); } catch { return json(502, { error: 'Unexpected upstream response' }); }

  // Trim to the fields the UI actually renders.
  const voices = (data.voices || []).map((v) => ({
    voice_id: v.voice_id,
    name: v.name,
    category: v.category,
    labels: v.labels || {},
    preview_url: v.preview_url || null,
  }));

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      ...cors(),
    },
    body: JSON.stringify({ voices }),
  };
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(obj) };
}
