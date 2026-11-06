# Squeek Jump — Hamster Runner 🐹

A Chrome-dino-style endless runner, fully rethemed for Squeekchain.
Squeektoshi the hamster sprints through his habitat — jump the seed piles,
water bottles, cardboard boxes, rolling exercise balls and the occasional
sleeping cat. Before playing, each runner enters a username and a wallet
address; finished runs post to a global leaderboard (username + score).

Squeek Jump is a community project for the Squeekchain Buildooooor badge.

<!-- GENESIS REPOSITORY LINE: when you start verification on squeekchain.com/genesis, paste the repository line they give you right below this comment. -->
<!-- genesis-repo-line: REPLACE-ME -->

## The Squeekchain twist — Wheel Boost

The game is coupled to Squeektoshi's **real** wheel. Every 8 seconds it
polls `GET https://api.squeekchain.com/v1/status` (public, no auth):

- **Wheel Boost multiplier** = `1 + min(rpm, 120) / 120` — 1.0× while he
  naps, up to 2.0× at 120 RPM. It multiplies game speed *and* score rate.
- The big exercise wheel in the background spins at his real RPM.
- Running state is read from `rpmMilli` and rising `cumulativeWorkUnits`,
  never from `coreStatus` (the API reports IDLE even while the wheel
  spins). If the API is unreachable the boost shows "offline" at 1.0× —
  live data is never faked.

The game is strictly read-only: the wallet address is typed into a form as
a leaderboard identity — no wallet connection, no signing, no transactions.

## Screens & flow

1. **Entry** — username (2–16 chars) + wallet address (`0x…`, validated),
   remembered in the browser; live hamster status chip; top-5 board.
2. **Game** — canvas runner. Space / ↑ / W / click / tap to jump; hold for
   a higher jump. Speed ramps with distance and Wheel Boost.
3. **Game over** — one hit kills the run (classic dino rules). Your score
   auto-submits to the leaderboard; run again or change player.
4. **Leaderboard** — global top 100, paged as sideways slides (20 per
   slide): rank, username, shortened address, score. One entry per
   player: only your **best** score is kept — a weaker run never lowers
   your board entry. Points are earned by clearing obstacles.
5. **Rooms** — anyone can create a room (name → short shareable code) for
   a whitelist / airdrop competition. A room has its own best-score
   leaderboard; players join with the code and their runs count there.
6. **Download** — both the main leaderboard and every room leaderboard
   have a **Download CSV** button exporting the top 100 with columns
   `rank, username, address, score` — full wallet addresses, ready for
   whitelist / airdrop snapshots.

## Run it

Static frontend + one serverless function for the leaderboard:

```sh
# frontend only (leaderboard falls back to a local board):
python3 -m http.server 8000        # open http://localhost:8000

# full version on Vercel: see DEPLOY.md
```

## Files

- `index.html` — page + game (contains a marked placeholder for the
  Genesis verification page tag)
- `style.css` — styling
- `app.js` — game engine, live wheel coupling, leaderboard client
- `api/leaderboard.js` — Vercel serverless leaderboard API, global and
  per-room (Upstash Redis sorted sets; env: `UPSTASH_REDIS_REST_URL`,
  `UPSTASH_REDIS_REST_TOKEN`)
- `api/rooms.js` — Vercel serverless rooms API (create room → code,
  room lookup + player count)
- `DEPLOY.md` — GitHub → Vercel → domain → Genesis verification steps

## Data sources (public, no auth)

- `GET https://api.squeekchain.com/v1/status` — live wheel sensor
  (`measurement.rpmMilli`, `measurement.cumulativeWorkUnits`,
  `measurement.freshness`).

## Genesis verification checklist (for the owner)

Direct route on https://squeekchain.com/genesis/code:

1. Add the DNS record Squeekchain gives you to your domain.
2. Paste their page tag into `index.html` (marked placeholder in `<head>`).
3. Paste their repository line into this README (marked placeholder at
   the top) and keep this repository public.
4. Press **Verify**, then wait for the Squeekchain team's review.

## License / notes

Testnet project (Sepolia), no real value. An original game built for the
Squeekchain community.
