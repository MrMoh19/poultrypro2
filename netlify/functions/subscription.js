// Netlify serverless function: report the account's character quota so the UI
// can show "credits remaining this month".

const ELEVEN_BASE = 'https://api.elevenlabs.io/v1';

exports.handler = async () => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'Server not configured', detail: 'ELEVENLABS_API_KEY is not set.' });
  }

  let resp;
  try {
    resp = await fetch(`${ELEVEN_BASE}/user/subscription`, {
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

  const used = data.character_count || 0;
  const limit = data.character_limit || 0;
  return json(200, {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    tier: data.tier || null,
    next_reset_unix: data.next_character_count_reset_unix || null,
  });
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(obj),
  };
}
