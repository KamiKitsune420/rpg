import crypto from 'crypto';
import { generateLicenseKey } from '../auth.js';

export default async function adminRoutes(fastify) {
  // All admin routes require the X-Admin-Key header
  const preValidation = [fastify.authenticateAdmin];

  // -------------------------------------------------------------------------
  // GET /api/v1/admin/games
  // List all registered games
  // -------------------------------------------------------------------------
  fastify.get('/games', { preValidation }, async () => {
    return fastify.db.prepare('SELECT id, name, display_name, created_at FROM games').all();
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/admin/games
  // Register a new game. Server generates the api_secret.
  //
  // Body: { name, display_name }
  //
  // Returns: { name, display_name, api_secret }
  // Store the api_secret — it is only shown once and is what you embed in the game binary.
  // -------------------------------------------------------------------------
  fastify.post('/games', { preValidation }, async (request, reply) => {
    const { name, display_name } = request.body ?? {};
    if (!name || !display_name) {
      return reply.code(400).send({ error: 'name and display_name are required' });
    }

    const api_secret = crypto.randomBytes(32).toString('hex');

    try {
      fastify.db
        .prepare('INSERT INTO games (name, display_name, api_secret) VALUES (?, ?, ?)')
        .run(name, display_name, api_secret);
    } catch (e) {
      if (e.message.includes('UNIQUE')) {
        return reply.code(409).send({ error: 'A game with that name already exists' });
      }
      throw e;
    }

    return {
      name,
      display_name,
      api_secret,
      note: 'Save this api_secret — it will not be shown again. Embed it in your game binary.'
    };
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/admin/games/:game/versions
  // Add a new version for a game
  //
  // Body: { version, download_url?, release_notes? }
  // -------------------------------------------------------------------------
  fastify.post('/games/:game/versions', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    const { version, download_url, release_notes } = request.body ?? {};
    if (!version) return reply.code(400).send({ error: 'version is required' });

    const gameRow = fastify.db.prepare('SELECT * FROM games WHERE name = ?').get(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    fastify.db
      .prepare('INSERT INTO versions (game_id, version, download_url, release_notes) VALUES (?, ?, ?, ?)')
      .run(gameRow.id, version, download_url ?? null, release_notes ?? null);

    return { success: true, version };
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/admin/games/:game/versions
  // List all versions for a game
  // -------------------------------------------------------------------------
  fastify.get('/games/:game/versions', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    const gameRow = fastify.db.prepare('SELECT * FROM games WHERE name = ?').get(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    return fastify.db
      .prepare('SELECT * FROM versions WHERE game_id = ? ORDER BY created_at DESC')
      .all(gameRow.id);
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/admin/games/:game/keys
  // Generate license keys for a game
  //
  // Body: { count, note? }   (count defaults to 1, max 100 per request)
  // -------------------------------------------------------------------------
  fastify.post('/games/:game/keys', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    const { count = 1, note } = request.body ?? {};

    if (count < 1 || count > 100) {
      return reply.code(400).send({ error: 'count must be between 1 and 100' });
    }

    const gameRow = fastify.db.prepare('SELECT * FROM games WHERE name = ?').get(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    const insert = fastify.db.prepare(
      'INSERT INTO license_keys (game_id, key, note) VALUES (?, ?, ?)'
    );

    const keys = [];
    const insertMany = fastify.db.transaction(() => {
      for (let i = 0; i < count; i++) {
        let key;
        // Retry on the extremely unlikely chance of a collision
        do { key = generateLicenseKey(); }
        while (fastify.db.prepare('SELECT 1 FROM license_keys WHERE key = ?').get(key));

        insert.run(gameRow.id, key, note ?? null);
        keys.push(key);
      }
    });

    insertMany();
    return { keys };
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/admin/games/:game/keys
  // List all keys and their activation status
  // -------------------------------------------------------------------------
  fastify.get('/games/:game/keys', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    const gameRow = fastify.db.prepare('SELECT * FROM games WHERE name = ?').get(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    const keys = fastify.db
      .prepare(`
        SELECT lk.key, lk.note, lk.created_at,
               COUNT(a.id) as seats_used
        FROM license_keys lk
        LEFT JOIN activations a ON a.key_id = lk.id
        WHERE lk.game_id = ?
        GROUP BY lk.id
        ORDER BY lk.created_at DESC
      `)
      .all(gameRow.id);

    return keys;
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/admin/games/:game/keys/:key
  // Revoke a license key (deletes all activations too via CASCADE)
  // -------------------------------------------------------------------------
  fastify.delete('/games/:game/keys/:key', { preValidation }, async (request, reply) => {
    const { game, key } = request.params;
    const gameRow = fastify.db.prepare('SELECT * FROM games WHERE name = ?').get(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    const result = fastify.db
      .prepare('DELETE FROM license_keys WHERE key = ? AND game_id = ?')
      .run(key, gameRow.id);

    if (result.changes === 0) return reply.code(404).send({ error: 'Key not found' });
    return { success: true, revoked: key };
  });

  // -------------------------------------------------------------------------
  // PUT /api/v1/admin/games/:game/motd
  // Set the active MOTD for a game (deactivates any previous ones)
  //
  // Body (text):  { type: "text", content: "Hello players!" }
  // Body (audio): { type: "audio", content: "Hello players!", audio_url: "http://..." }
  // -------------------------------------------------------------------------
  fastify.put('/games/:game/motd', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    const { type, content, audio_url } = request.body ?? {};

    if (!type || !content) {
      return reply.code(400).send({ error: 'type and content are required' });
    }
    if (!['text', 'audio'].includes(type)) {
      return reply.code(400).send({ error: 'type must be "text" or "audio"' });
    }
    if (type === 'audio' && !audio_url) {
      return reply.code(400).send({ error: 'audio_url is required when type is "audio"' });
    }

    const gameRow = fastify.db.prepare('SELECT * FROM games WHERE name = ?').get(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    const update = fastify.db.transaction(() => {
      // Deactivate all existing MOTDs for this game
      fastify.db
        .prepare('UPDATE motd SET active = 0 WHERE game_id = ?')
        .run(gameRow.id);

      // Insert the new active MOTD
      fastify.db
        .prepare('INSERT INTO motd (game_id, type, content, audio_url, active) VALUES (?, ?, ?, ?, 1)')
        .run(gameRow.id, type, content, audio_url ?? null);
    });

    update();
    return { success: true };
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/admin/games/:game/gifts
  // Create a promotional gift for a game
  //
  // Body: { code, description, reward_data, max_claims?, expires_at? }
  //   reward_data — any JSON object describing the reward (you define the shape)
  //   max_claims  — 0 = unlimited
  //   expires_at  — ISO 8601 datetime string, or omit for no expiry
  // -------------------------------------------------------------------------
  fastify.post('/games/:game/gifts', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    const { code, description, reward_data, max_claims = 0, expires_at } = request.body ?? {};

    if (!code || !description || !reward_data) {
      return reply.code(400).send({ error: 'code, description, and reward_data are required' });
    }

    const gameRow = fastify.db.prepare('SELECT * FROM games WHERE name = ?').get(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    try {
      fastify.db
        .prepare(`INSERT INTO gifts (game_id, code, description, reward_data, max_claims, expires_at)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          gameRow.id,
          code.toUpperCase(),
          description,
          JSON.stringify(reward_data),
          max_claims,
          expires_at ?? null
        );
    } catch (e) {
      if (e.message.includes('UNIQUE')) {
        return reply.code(409).send({ error: 'A gift with that code already exists' });
      }
      throw e;
    }

    return { success: true, code: code.toUpperCase() };
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/admin/games/:game/gifts
  // List all gifts for a game (including expired and fully claimed ones)
  // -------------------------------------------------------------------------
  fastify.get('/games/:game/gifts', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    const gameRow = fastify.db.prepare('SELECT * FROM games WHERE name = ?').get(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    return fastify.db
      .prepare(`
        SELECT g.code, g.description, g.reward_data, g.max_claims,
               g.expires_at, g.created_at,
               COUNT(gc.id) as claim_count
        FROM gifts g
        LEFT JOIN gift_claims gc ON gc.gift_id = g.id
        WHERE g.game_id = ?
        GROUP BY g.id
        ORDER BY g.created_at DESC
      `)
      .all(gameRow.id)
      .map(g => ({ ...g, reward_data: JSON.parse(g.reward_data) }));
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/admin/games/:game/gifts/:code
  // Delete a gift (and all its claims)
  // -------------------------------------------------------------------------
  fastify.delete('/games/:game/gifts/:code', { preValidation }, async (request, reply) => {
    const { game, code } = request.params;
    const gameRow = fastify.db.prepare('SELECT * FROM games WHERE name = ?').get(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    const result = fastify.db
      .prepare('DELETE FROM gifts WHERE code = ? AND game_id = ?')
      .run(code.toUpperCase(), gameRow.id);

    if (result.changes === 0) return reply.code(404).send({ error: 'Gift not found' });
    return { success: true };
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/admin/games/:game/scores
  // Full score list for a game (admin view, includes machine_id)
  // -------------------------------------------------------------------------
  fastify.get('/games/:game/scores', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    const gameRow = fastify.db.prepare('SELECT * FROM games WHERE name = ?').get(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    return fastify.db
      .prepare('SELECT player_name, machine_id, score, submitted_at FROM scores WHERE game_id = ? ORDER BY score DESC')
      .all(gameRow.id);
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/admin/games/:game/scores
  // Wipe all scores for a game (e.g. start of a new season)
  // -------------------------------------------------------------------------
  fastify.delete('/games/:game/scores', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    const gameRow = fastify.db.prepare('SELECT * FROM games WHERE name = ?').get(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    const result = fastify.db
      .prepare('DELETE FROM scores WHERE game_id = ?')
      .run(gameRow.id);

    return { success: true, deleted: result.changes };
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/admin/games/:game/scores/:machine_id
  // Remove a single player's score (e.g. to handle cheating)
  // -------------------------------------------------------------------------
  fastify.delete('/games/:game/scores/:machine_id', { preValidation }, async (request, reply) => {
    const { game, machine_id } = request.params;
    const gameRow = fastify.db.prepare('SELECT * FROM games WHERE name = ?').get(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    const result = fastify.db
      .prepare('DELETE FROM scores WHERE game_id = ? AND machine_id = ?')
      .run(gameRow.id, machine_id);

    if (result.changes === 0) return reply.code(404).send({ error: 'Score not found' });
    return { success: true };
  });
}
