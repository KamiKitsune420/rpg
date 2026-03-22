# Game Server

A central HTTP API server for NVGT-based games. Handles update checking, product activation, message of the day, promotional gifts, and scoreboards — all from one place.

---

## Table of Contents

1. [Stack](#stack)
2. [Project Structure](#project-structure)
3. [Setup — Local](#setup--local)
4. [Setup — VPS](#setup--vps)
5. [Environment Variables](#environment-variables)
6. [Authentication Flow](#authentication-flow)
7. [Endpoints — Game](#endpoints--game)
   - [Auth](#post-apiv1auth)
   - [Version](#get-apiv1gameversion)
   - [Activate](#post-apiv1gameactivate)
   - [Validate](#post-apiv1gamevalidate)
   - [MOTD](#get-apiv1gamegetmotd)
   - [Gifts](#get-apiv1gamegifts)
   - [Claim Gift](#post-apiv1gameclaim_gift)
   - [Submit Score](#post-apiv1gamescores)
   - [Get Leaderboard](#get-apiv1gamescores)
   - [Get Rank](#get-apiv1gamescoresrank)
8. [Endpoints — Admin](#endpoints--admin)
9. [Database Schema](#database-schema)
10. [Switching to a Domain](#switching-to-a-domain)
11. [Hosting MOTD Audio Files](#hosting-motd-audio-files)

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Fastify 5 |
| Database | SQLite (better-sqlite3) |
| Auth tokens | JWT (1 hour expiry) |
| Request signing | HMAC-SHA256 |
| Reverse proxy / TLS | Caddy |
| Admin client | Postman (or any HTTP client) |

---

## Project Structure

```
gameserver/
├── src/
│   ├── app.js                  # Entry point — Fastify setup, route registration
│   ├── db.js                   # SQLite connection and schema
│   ├── auth.js                 # HMAC, JWT, key generation, seat activation logic
│   ├── plugins/
│   │   └── authenticate.js     # JWT and admin key middleware decorators
│   └── routes/
│       ├── auth.js             # POST /api/v1/auth
│       ├── game.js             # version, activate, validate, getmotd, gifts, claim_gift
│       ├── scores.js           # scoreboard endpoints
│       └── admin.js            # all /api/v1/admin/* routes
├── data/                       # SQLite database file (auto-created, git-ignored)
├── uploads/
│   └── motd/                   # Drop audio MOTD files here (auto-created, git-ignored)
├── Caddyfile                   # Reverse proxy config
├── start.bat                   # Windows one-click start script
├── package.json
├── .env.example                # Copy to .env and fill in values
└── .gitignore
```

---

## Setup — Local

Requirements: Node.js 18 or higher.

**Windows:** double-click `start.bat`. It handles everything automatically.

**Manual:**

```bash
# 1. Install dependencies
npm install

# 2. Create environment file
copy .env.example .env
# Open .env and fill in the values (see Environment Variables section)

# 3. Start the server
npm start

# For development with auto-restart on file changes:
npm run dev
```

The server listens on `http://localhost:3000`. No Caddy required for local use.

---

## Setup — VPS

```bash
# 1. Install Node.js (https://nodejs.org) and Caddy (https://caddyserver.com/docs/install)

# 2. Clone or upload the project to the server

# 3. Install dependencies
npm install

# 4. Create and fill in environment file
cp .env.example .env
nano .env

# 5. Start the game server (consider using pm2 or systemd to keep it running)
npm start

# 6. In a separate terminal, start Caddy
caddy run --config Caddyfile
```

The server will be accessible on port 80 of your VPS IP address.

To keep the server running after you disconnect, use a process manager:

```bash
# Using pm2
npm install -g pm2
pm2 start npm --name gameserver -- start
pm2 save
pm2 startup
```

---

## Environment Variables

Defined in `.env`. Copy `.env.example` to get started.

| Variable | Required | Description |
|---|---|---|
| `PORT` | Yes | Internal port Fastify listens on. Default `3000`. |
| `HOST` | Yes | Bind address. Use `127.0.0.1` so only Caddy can reach it. |
| `JWT_SECRET` | Yes | Long random string used to sign JWTs. Keep private. |
| `ADMIN_KEY` | Yes | Secret header value for all admin routes. Keep private. |
| `BASE_URL` | Yes | Public base URL. Used when building audio MOTD URLs. Example: `http://1.2.3.4` or `https://yourdomain.com` |

Generate strong secrets with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Authentication Flow

All game-facing endpoints (except `/auth`) require a JWT in the `Authorization` header.

**Step 1 — Obtain a token**

The game authenticates by signing a message with its `api_secret`. The raw secret is never sent over the network.

```
message   = game_id + ":" + unix_timestamp_seconds
signature = HMAC-SHA256(message, api_secret)   [hex encoded]
```

POST this to `/api/v1/auth`. The server recomputes the HMAC and validates the timestamp (must be within 30 seconds to prevent replay attacks). On success it returns a JWT.

**Step 2 — Use the token**

Include the JWT in every subsequent request:
```
Authorization: Bearer <token>
```

The JWT is valid for 1 hour. When it expires, the game must re-authenticate.

**NVGT pseudocode:**
```nvgt
string game_id   = "mygame";
string api_secret = "your_api_secret_here"; // embedded at compile time

int64 ts = get_unix_timestamp(); // current time in seconds
string msg = game_id + ":" + ts;
string sig = hmac_sha256_hex(msg, api_secret);

http h;
h.post("http://SERVER/api/v1/auth", '{"game_id":"'+game_id+'","timestamp":'+ts+',"signature":"'+sig+'"}', "application/json");
h.wait();
// parse h.response_body to get the token
```

---

## Endpoints — Game

All game endpoints require `Authorization: Bearer <token>` obtained from `/auth`.
The `game` in the URL must match the `game_id` in the JWT.

---

### POST /api/v1/auth

Authenticate and receive a JWT.

**Request body:**
```json
{
  "game_id":   "mygame",
  "timestamp": 1714000000,
  "signature": "a3f9...hex64chars"
}
```

**Response `200`:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9..."
}
```

**Response `401`:** Invalid credentials or timestamp outside 30-second window.

---

### GET /api/v1/:game/version

Get the latest version info for a game.

**Response `200`:**
```json
{
  "version":       "1.2.3",
  "download_url":  "https://example.com/mygame-1.2.3.exe",
  "release_notes": "Fixed crash on startup.",
  "released_at":   "2026-03-01 12:00:00"
}
```

**Response `404`:** No version has been added yet.

---

### POST /api/v1/:game/activate

Activate a license key on a machine. Supports up to 5 machines per key using a rolling model — when a 6th machine activates, the oldest machine is evicted automatically.

**Request body:**
```json
{
  "key":        "AB12-CD34-EF56-GH78",
  "machine_id": "unique-hardware-fingerprint"
}
```

**Response `200` — success:**
```json
{
  "success":    true,
  "message":    "Activated",
  "seats_used": 2
}
```

**Response `200` — already activated on this machine:**
```json
{
  "success":    true,
  "message":    "Already activated on this machine",
  "seats_used": 2
}
```

**Response `404`:** Key does not exist or does not belong to this game.

---

### POST /api/v1/:game/validate

Check whether a key exists and whether this machine has activated it.

**Request body:**
```json
{
  "key":        "AB12-CD34-EF56-GH78",
  "machine_id": "unique-hardware-fingerprint"
}
```

**Response `200`:**
```json
{
  "valid":        true,
  "activated":    true,
  "seats_used":   2,
  "max_seats":    5,
  "activated_at": "2026-03-15 10:30:00"
}
```

If the key does not exist:
```json
{
  "valid":     false,
  "activated": false,
  "reason":    "Key does not exist"
}
```

---

### GET /api/v1/:game/getmotd

Get the active message of the day for a game.

**Response `200` — text:**
```json
{
  "type":    "text",
  "content": "Welcome! Version 2.0 is now live."
}
```

**Response `200` — audio:**
```json
{
  "type":      "audio",
  "content":   "Welcome! Version 2.0 is now live.",
  "audio_url": "http://YOUR_VPS_IP/uploads/motd/mygame_motd.ogg"
}
```
`content` always contains the fallback text even for audio MOTDs.

**Response `404`:** No active MOTD set.

---

### GET /api/v1/:game/gifts

Get all available, non-expired, non-exhausted gifts for a game.

**Response `200`:**
```json
[
  {
    "code":        "SPRING2026",
    "description": "Free spring hat",
    "expires_at":  "2026-04-30 23:59:59"
  }
]
```

Returns an empty array if no gifts are available.

---

### POST /api/v1/:game/claim_gift

Claim a gift code. Each machine can only claim each code once.

**Request body:**
```json
{
  "code":       "SPRING2026",
  "machine_id": "unique-hardware-fingerprint"
}
```

**Response `200`:**
```json
{
  "success": true,
  "reward":  { "item": "spring_hat", "color": "green" }
}
```

The shape of `reward` is whatever you defined in `reward_data` when creating the gift.

**Response `404`:** Gift not found or expired.
**Response `409`:** Already claimed on this machine.
**Response `410`:** Gift is fully claimed (max_claims reached).

---

### POST /api/v1/:game/scores

Submit or update a score. If this machine already has a score for this game it is replaced.

**Request body:**
```json
{
  "player_name": "Sam",
  "score":       15420,
  "machine_id":  "unique-hardware-fingerprint"
}
```

`score` is a decimal number. For time-attack games, pass the time in seconds (e.g. `12.345`).

**Response `200`:**
```json
{
  "success": true,
  "rank":    3
}
```

---

### GET /api/v1/:game/scores

Get the leaderboard.

**Query parameters:**

| Parameter | Default | Description |
|---|---|---|
| `limit` | `10` | Number of entries (max 100) |
| `offset` | `0` | Pagination offset |
| `order` | `desc` | `desc` = highest score first. `asc` = lowest first (for time-attack games) |

**Response `200`:**
```json
{
  "total":  42,
  "limit":  10,
  "offset": 0,
  "scores": [
    { "rank": 1, "player_name": "Sam",   "score": 99999, "submitted_at": "2026-03-20 14:00:00" },
    { "rank": 2, "player_name": "Alex",  "score": 87500, "submitted_at": "2026-03-19 09:15:00" },
    { "rank": 3, "player_name": "Jordan","score": 72100, "submitted_at": "2026-03-18 22:40:00" }
  ]
}
```

---

### GET /api/v1/:game/scores/rank

Get a specific machine's score and rank.

**Query parameters:**

| Parameter | Required | Description |
|---|---|---|
| `machine_id` | Yes | The machine to look up |
| `order` | No | `desc` (default) or `asc` |

**Response `200`:**
```json
{
  "player_name":  "Sam",
  "score":        15420,
  "rank":         3,
  "total":        42,
  "submitted_at": "2026-03-20 14:00:00"
}
```

**Response `404`:** No score on record for this machine.

---

## Endpoints — Admin

All admin endpoints require:
```
X-Admin-Key: your_admin_key
```

### Games

| Method | Path | Body | Description |
|---|---|---|---|
| GET | `/api/v1/admin/games` | — | List all games |
| POST | `/api/v1/admin/games` | `{ name, display_name }` | Register a game. Returns `api_secret` — save it, shown once. |

### Versions

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/api/v1/admin/games/:game/versions` | `{ version, download_url?, release_notes? }` | Add a new version |
| GET | `/api/v1/admin/games/:game/versions` | — | List all versions |

### License Keys

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/api/v1/admin/games/:game/keys` | `{ count?, note? }` | Generate keys (max 100 per request) |
| GET | `/api/v1/admin/games/:game/keys` | — | List all keys with seat usage |
| DELETE | `/api/v1/admin/games/:game/keys/:key` | — | Revoke a key and all its activations |

### MOTD

| Method | Path | Body | Description |
|---|---|---|---|
| PUT | `/api/v1/admin/games/:game/motd` | `{ type, content, audio_url? }` | Set active MOTD. Deactivates the previous one. |

`type` must be `"text"` or `"audio"`. `audio_url` is required when `type` is `"audio"`.

### Gifts

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/api/v1/admin/games/:game/gifts` | `{ code, description, reward_data, max_claims?, expires_at? }` | Create a gift |
| GET | `/api/v1/admin/games/:game/gifts` | — | List all gifts including claim counts |
| DELETE | `/api/v1/admin/games/:game/gifts/:code` | — | Delete a gift and all its claims |

`reward_data` is any JSON object. `max_claims: 0` means unlimited. `expires_at` is an ISO 8601 datetime string.

### Scores

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/admin/games/:game/scores` | Full score list including machine IDs |
| DELETE | `/api/v1/admin/games/:game/scores` | Wipe all scores (e.g. new season) |
| DELETE | `/api/v1/admin/games/:game/scores/:machine_id` | Remove one player's score |

---

## Database Schema

Located at `data/gameserver.db`.

```
games         — id, name, display_name, api_secret, created_at
versions      — id, game_id, version, download_url, release_notes, created_at
license_keys  — id, game_id, key, note, created_at
activations   — id, key_id, machine_id, activated_at         [max 5 per key, rolling]
motd          — id, game_id, type, content, audio_url, active, created_at
gifts         — id, game_id, code, description, reward_data, max_claims, expires_at, created_at
gift_claims   — id, gift_id, machine_id, claimed_at
scores        — id, game_id, machine_id, player_name, score, submitted_at
```

All cross-table relationships use `ON DELETE CASCADE` — deleting a game removes all its data.

---

## Switching to a Domain

1. Point your domain's DNS **A record** to the VPS IP address.
2. Open `Caddyfile` and replace `:80` with your domain:

```
# Before
:80 {
    reverse_proxy localhost:3000
}

# After
yourdomain.com {
    reverse_proxy localhost:3000
}
```

3. Update `BASE_URL` in `.env`:
```
BASE_URL=https://yourdomain.com
```

4. Restart Caddy. It will automatically obtain and renew a Let's Encrypt TLS certificate.

---

## Hosting MOTD Audio Files

To use an audio MOTD:

1. Copy the audio file (`.ogg`, `.mp3`, etc.) to `uploads/motd/` on the server.
2. Set the MOTD via the admin API with the file's public URL:

```json
PUT /api/v1/admin/games/mygame/motd
{
  "type":      "audio",
  "content":   "Welcome to the game! Version 2.0 is now live.",
  "audio_url": "http://YOUR_VPS_IP/uploads/motd/welcome.ogg"
}
```

The file will be served by the game server itself at `/uploads/motd/filename`.
