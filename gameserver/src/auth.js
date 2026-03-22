import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const MAX_SEATS = 5;
const HMAC_WINDOW_SECONDS = 30;

// ---------------------------------------------------------------------------
// HMAC-SHA256 request signing
// The NVGT game computes: HMAC-SHA256(game_id + ":" + timestamp, api_secret)
// and sends { game_id, timestamp, signature } to /api/v1/auth
// ---------------------------------------------------------------------------

export function computeHmac(gameId, timestamp, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${gameId}:${timestamp}`)
    .digest('hex');
}

export function verifyHmac(gameId, timestamp, signature, secret) {
  const now = Math.floor(Date.now() / 1000);

  if (Math.abs(now - timestamp) > HMAC_WINDOW_SECONDS) {
    return false; // Replay attack window exceeded
  }

  const expected = computeHmac(gameId, timestamp, secret);

  // timing-safe comparison prevents timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex')
    );
  } catch {
    return false; // Buffer lengths differ = invalid signature
  }
}

// ---------------------------------------------------------------------------
// JWT tokens
// ---------------------------------------------------------------------------

export function signJwt(gameId) {
  return jwt.sign(
    { game_id: gameId },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

export function verifyJwt(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

// ---------------------------------------------------------------------------
// License key generation
// Format: XXXX-XXXX-XXXX-XXXX (hex, uppercase)
// ---------------------------------------------------------------------------

export function generateLicenseKey() {
  const seg = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${seg()}-${seg()}-${seg()}-${seg()}`;
}

// ---------------------------------------------------------------------------
// Rolling 5-seat activation
// Returns { success, message, seats_used }
// ---------------------------------------------------------------------------

export function activateMachine(db, keyRow, machineId) {
  const existing = db
    .prepare('SELECT * FROM activations WHERE key_id = ? AND machine_id = ?')
    .get(keyRow.id, machineId);

  if (existing) {
    const seats = db
      .prepare('SELECT COUNT(*) as c FROM activations WHERE key_id = ?')
      .get(keyRow.id).c;
    return { success: true, message: 'Already activated on this machine', seats_used: seats };
  }

  const seats = db
    .prepare('SELECT * FROM activations WHERE key_id = ? ORDER BY activated_at ASC')
    .all(keyRow.id);

  if (seats.length >= MAX_SEATS) {
    // Evict the oldest seat to make room
    const oldest = seats[0];
    db.prepare('DELETE FROM activations WHERE id = ?').run(oldest.id);
  }

  db.prepare('INSERT INTO activations (key_id, machine_id) VALUES (?, ?)').run(keyRow.id, machineId);

  const seatsUsed = db
    .prepare('SELECT COUNT(*) as c FROM activations WHERE key_id = ?')
    .get(keyRow.id).c;

  return { success: true, message: 'Activated', seats_used: seatsUsed };
}
