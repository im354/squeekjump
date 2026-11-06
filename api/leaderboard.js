// Squeek Jump — leaderboard API (Vercel serverless function, zero dependencies).
//
// Storage: Upstash Redis via its REST API.
//   Global board:  ZSET "squeekjump:leaderboard" + HASH "squeekjump:players"
//   Room board:    ZSET "squeekjump:lb:<CODE>"    + HASH "squeekjump:players:<CODE>"
//   In every board the ZSET member is the wallet address (lowercase) and the
//   score is that player's BEST score — one entry per player; a new run only
//   replaces the entry when it beats the player's previous best. The HASH
//   maps address -> JSON {"u": username, "t": timestamp of the best run}.
//   Rooms themselves live in api/rooms.js (HASH "squeekjump:rooms").
//
// Required env vars (Vercel project settings):
//   UPSTASH_REDIS_REST_URL    e.g. https://eu1-xxxx.upstash.io
//   UPSTASH_REDIS_REST_TOKEN  the REST token for that database
//
// GET  /api/leaderboard[?room=CODE][&limit=100]
//      -> { ok, entries: [{username, address, score}] } (limit default 20, max 100)
// POST /api/leaderboard           body {username, address, score, room?}
//      -> { ok, rank, improved, best }

const TOP_DEFAULT = 20;
const TOP_MAX = 100;

const USERNAME_RE = /^[A-Za-z0-9_]{2,16}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ROOM_RE = /^[A-Z0-9]{6}$/;

async function redis(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null; // not configured
  const res = await fetch(url + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error('upstash ' + res.status);
  return res.json();
}

function keysFor(room) {
  return room
    ? { z: 'squeekjump:lb:' + room, h: 'squeekjump:players:' + room }
    : { z: 'squeekjump:leaderboard', h: 'squeekjump:players' };
}

async function roomExists(room) {
  const out = await redis([['HEXISTS', 'squeekjump:rooms', room]]);
  return !!(out && out[0] && out[0].result === 1);
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

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET') {
      const roomParam = (url.searchParams.get('room') || '').toUpperCase();
      const room = roomParam || null;
      if (room && !ROOM_RE.test(room)) return send(res, 422, { ok: false, error: 'bad_room' });
      let limit = parseInt(url.searchParams.get('limit') || String(TOP_DEFAULT), 10);
      if (!Number.isFinite(limit) || limit < 1) limit = TOP_DEFAULT;
      if (limit > TOP_MAX) limit = TOP_MAX;

      if (room && !(await roomExists(room))) return send(res, 404, { ok: false, error: 'room_not_found' });
      const { z, h } = keysFor(room);
      const out = await redis([['ZREVRANGE', z, '0', String(limit - 1), 'WITHSCORES']]);
      if (!out) return send(res, 501, { ok: false, error: 'leaderboard_not_configured' });
      const flat = (out[0] && out[0].result) || [];
      const addresses = [];
      const scores = [];
      for (let i = 0; i < flat.length; i += 2) { addresses.push(flat[i]); scores.push(Number(flat[i + 1])); }
      if (!addresses.length) return send(res, 200, { ok: true, entries: [] });
      const names = await redis([['HMGET', h].concat(addresses)]);
      const nameResults = (names && names[0] && names[0].result) || [];
      const entries = addresses.map((address, i) => {
        let username = '';
        try { username = JSON.parse(nameResults[i] || '{}').u || ''; } catch (e) { /* keep blank */ }
        return { username, address, score: scores[i] };
      });
      return send(res, 200, { ok: true, entries });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const username = String(body.username || '');
      const address = String(body.address || '').toLowerCase();
      const score = Math.floor(Number(body.score));
      const room = body.room ? String(body.room).toUpperCase() : null;
      if (!USERNAME_RE.test(username)) return send(res, 422, { ok: false, error: 'bad_username' });
      if (!ADDRESS_RE.test(address)) return send(res, 422, { ok: false, error: 'bad_address' });
      if (!Number.isFinite(score) || score < 0 || score > 1000000000) return send(res, 422, { ok: false, error: 'bad_score' });
      if (room && !ROOM_RE.test(room)) return send(res, 422, { ok: false, error: 'bad_room' });
      if (room && !(await roomExists(room))) return send(res, 404, { ok: false, error: 'room_not_found' });

      const { z, h } = keysFor(room);
      const cur = await redis([['ZSCORE', z, address]]);
      if (!cur) return send(res, 501, { ok: false, error: 'leaderboard_not_configured' });
      const currentBest = cur[0] && cur[0].result != null ? Number(cur[0].result) : null;
      const improved = currentBest === null || score > currentBest;

      const commands = [];
      if (improved) {
        commands.push(['ZADD', z, String(score), address]);
        commands.push(['HSET', h, address, JSON.stringify({ u: username, t: Date.now() })]);
      }
      commands.push(['ZREVRANK', z, address]);
      const out = await redis(commands);
      const rankResult = out[out.length - 1];
      const rank = rankResult && typeof rankResult.result === 'number' ? rankResult.result : null;
      return send(res, 200, { ok: true, rank, improved, best: improved ? score : currentBest });
    }

    return send(res, 405, { ok: false, error: 'method_not_allowed' });
  } catch (e) {
    return send(res, 500, { ok: false, error: 'server_error' });
  }
};
