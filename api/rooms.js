// Squeek Jump — rooms API (Vercel serverless function, zero dependencies).
//
// Anyone can create a room for a whitelist / airdrop competition: the room
// gets a short code, its own best-score leaderboard (see leaderboard.js),
// and a CSV-downloadable board. Creating a room is free and accountless.
//
// Storage: Upstash Redis HASH "squeekjump:rooms"
//   field = room code (6 chars), value = JSON
//   {"name": room name, "by": {"u": creator username, "a": creator address},
//    "t": createdAt}
//
// Required env vars: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//
// POST /api/rooms        body {name, username?, address?} -> { ok, room: {code, name} }
// GET  /api/rooms?code=ABC123                              -> { ok, room: {code, name, players} }

const HKEY = 'squeekjump:rooms';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L lookalikes
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

async function redis(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const res = await fetch(url + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error('upstash ' + res.status);
  return res.json();
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function makeCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  try {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 30);
      const username = String(body.username || '').slice(0, 16);
      const address = String(body.address || '').toLowerCase();
      if (name.length < 2) return send(res, 422, { ok: false, error: 'bad_name' });
      if (address && !ADDRESS_RE.test(address)) return send(res, 422, { ok: false, error: 'bad_address' });

      // Claim a unique code (HSETNX fails if the field already exists).
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = makeCode();
        const value = JSON.stringify({ name, by: { u: username, a: address }, t: Date.now() });
        const out = await redis([['HSETNX', HKEY, code, value]]);
        if (!out) return send(res, 501, { ok: false, error: 'rooms_not_configured' });
        if (out[0] && out[0].result === 1) return send(res, 200, { ok: true, room: { code, name } });
      }
      return send(res, 503, { ok: false, error: 'code_collision_retry' });
    }

    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const code = (url.searchParams.get('code') || '').toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) return send(res, 422, { ok: false, error: 'bad_code' });
      const out = await redis([
        ['HGET', HKEY, code],
        ['ZCARD', 'squeekjump:lb:' + code]
      ]);
      if (!out) return send(res, 501, { ok: false, error: 'rooms_not_configured' });
      const raw = out[0] && out[0].result;
      if (!raw) return send(res, 404, { ok: false, error: 'room_not_found' });
      let room;
      try { room = JSON.parse(raw); } catch (e) { return send(res, 500, { ok: false, error: 'server_error' }); }
      const players = out[1] && typeof out[1].result === 'number' ? out[1].result : 0;
      return send(res, 200, { ok: true, room: { code, name: room.name, players } });
    }

    return send(res, 405, { ok: false, error: 'method_not_allowed' });
  } catch (e) {
    return send(res, 500, { ok: false, error: 'server_error' });
  }
};
