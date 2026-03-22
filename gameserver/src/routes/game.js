import { existsSync } from 'fs';
import path from 'path';
import { activateMachine } from '../auth.js';

export default async function gameRoutes(fastify) {
  // All routes here require a valid JWT. The JWT payload contains game_id,
  // which must match the :game URL param to prevent cross-game access.

  const preValidation = [fastify.authenticate];

  // Helper: look up game by name, return 404 if not found
  function getGame(name) {
    return fastify.db.prepare('SELECT * FROM games WHERE name = ?').get(name);
  }

  // Helper: verify the JWT game_id matches the :game param
  function guardGame(request, reply, gameName) {
    if (request.game.game_id !== gameName) {
      reply.code(403).send({ error: 'Token does not match requested game' });
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/:game/version
  // Returns the latest version info for a game
  // -------------------------------------------------------------------------
  fastify.get('/:game/version', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    if (!guardGame(request, reply, game)) return;

    const row = fastify.db
      .prepare(`SELECT * FROM versions WHERE game_id = (SELECT id FROM games WHERE name = ?)
                ORDER BY created_at DESC LIMIT 1`)
      .get(game);

    if (!row) return reply.code(404).send({ error: 'No version on record' });

    // Resolve download URL — use the stored one if set, otherwise fall back to
    // uploads/games/<game>.exe or uploads/games/<game>.zip (checks for whichever exists)
    let download_url = row.download_url ?? null;
    if (!download_url) {
      const gamesDir = path.join(fastify.uploadsDir, 'games');
      const base     = process.env.BASE_URL ?? '';

      for (const ext of ['.exe', '.zip']) {
        if (existsSync(path.join(gamesDir, `${game}${ext}`))) {
          download_url = `${base}/uploads/games/${game}${ext}`;
          break;
        }
      }
    }

    return {
      version:       row.version,
      download_url,
      release_notes: row.release_notes,
      released_at:   row.created_at
    };
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/:game/activate
  // Activates a license key for a machine (rolling 5-seat model)
  //
  // Body: { key, machine_id }
  // -------------------------------------------------------------------------
  fastify.post('/:game/activate', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    if (!guardGame(request, reply, game)) return;

    const { key, machine_id } = request.body ?? {};
    if (!key || !machine_id) {
      return reply.code(400).send({ error: 'key and machine_id are required' });
    }

    const gameRow = getGame(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    const keyRow = fastify.db
      .prepare('SELECT * FROM license_keys WHERE key = ? AND game_id = ?')
      .get(key, gameRow.id);

    if (!keyRow) return reply.code(404).send({ error: 'Invalid key' });

    const result = activateMachine(fastify.db, keyRow, machine_id);
    return result;
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/:game/validate
  // Checks whether a key is valid and if this machine is activated on it
  //
  // Body: { key, machine_id }
  // -------------------------------------------------------------------------
  fastify.post('/:game/validate', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    if (!guardGame(request, reply, game)) return;

    const { key, machine_id } = request.body ?? {};
    if (!key || !machine_id) {
      return reply.code(400).send({ error: 'key and machine_id are required' });
    }

    const gameRow = getGame(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    const keyRow = fastify.db
      .prepare('SELECT * FROM license_keys WHERE key = ? AND game_id = ?')
      .get(key, gameRow.id);

    if (!keyRow) return { valid: false, activated: false, reason: 'Key does not exist' };

    const activation = fastify.db
      .prepare('SELECT * FROM activations WHERE key_id = ? AND machine_id = ?')
      .get(keyRow.id, machine_id);

    const seats_used = fastify.db
      .prepare('SELECT COUNT(*) as c FROM activations WHERE key_id = ?')
      .get(keyRow.id).c;

    return {
      valid:       true,
      activated:   !!activation,
      seats_used,
      max_seats:   5,
      activated_at: activation?.activated_at ?? null
    };
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/:game/getmotd
  // Returns the active message of the day (text or audio)
  // -------------------------------------------------------------------------
  fastify.get('/:game/getmotd', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    if (!guardGame(request, reply, game)) return;

    const gameRow = getGame(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    const row = fastify.db
      .prepare('SELECT * FROM motd WHERE game_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1')
      .get(gameRow.id);

    if (!row) return reply.code(404).send({ error: 'No active MOTD' });

    if (row.type === 'audio') {
      return {
        type:          'audio',
        content:       row.content,   // fallback text
        audio_url:     row.audio_url
      };
    }

    return {
      type:    'text',
      content: row.content
    };
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/:game/gifts
  // Returns all active, non-expired gifts available for this game
  // -------------------------------------------------------------------------
  fastify.get('/:game/gifts', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    if (!guardGame(request, reply, game)) return;

    const gameRow = getGame(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    const gifts = fastify.db
      .prepare(`
        SELECT g.code, g.description, g.max_claims, g.expires_at,
               COUNT(gc.id) as claim_count
        FROM gifts g
        LEFT JOIN gift_claims gc ON gc.gift_id = g.id
        WHERE g.game_id = ?
          AND (g.expires_at IS NULL OR g.expires_at > datetime('now'))
        GROUP BY g.id
        HAVING g.max_claims = 0 OR claim_count < g.max_claims
        ORDER BY g.created_at DESC
      `)
      .all(gameRow.id);

    return gifts.map(g => ({
      code:        g.code,
      description: g.description,
      expires_at:  g.expires_at
    }));
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/:game/claim_gift
  // Claim a gift code on behalf of a machine
  //
  // Body: { code, machine_id }
  // -------------------------------------------------------------------------
  fastify.post('/:game/claim_gift', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    if (!guardGame(request, reply, game)) return;

    const { code, machine_id } = request.body ?? {};
    if (!code || !machine_id) {
      return reply.code(400).send({ error: 'code and machine_id are required' });
    }

    const gameRow = getGame(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    const gift = fastify.db
      .prepare(`SELECT * FROM gifts WHERE code = ? AND game_id = ?
                AND (expires_at IS NULL OR expires_at > datetime('now'))`)
      .get(code, gameRow.id);

    if (!gift) return reply.code(404).send({ error: 'Gift not found or expired' });

    // Check if this machine already claimed it
    const alreadyClaimed = fastify.db
      .prepare('SELECT * FROM gift_claims WHERE gift_id = ? AND machine_id = ?')
      .get(gift.id, machine_id);

    if (alreadyClaimed) {
      return reply.code(409).send({ error: 'Already claimed on this machine' });
    }

    // Check claim limit
    if (gift.max_claims > 0) {
      const claimCount = fastify.db
        .prepare('SELECT COUNT(*) as c FROM gift_claims WHERE gift_id = ?')
        .get(gift.id).c;

      if (claimCount >= gift.max_claims) {
        return reply.code(410).send({ error: 'Gift is fully claimed' });
      }
    }

    fastify.db
      .prepare('INSERT INTO gift_claims (gift_id, machine_id) VALUES (?, ?)')
      .run(gift.id, machine_id);

    return {
      success: true,
      reward:  JSON.parse(gift.reward_data)
    };
  });
}
