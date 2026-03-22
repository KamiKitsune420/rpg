export default async function scoreRoutes(fastify) {
  const preValidation = [fastify.authenticate];

  function getGame(name) {
    return fastify.db.prepare('SELECT * FROM games WHERE name = ?').get(name);
  }

  function guardGame(request, reply, gameName) {
    if (request.game.game_id !== gameName) {
      reply.code(403).send({ error: 'Token does not match requested game' });
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/:game/scores
  // Submit or update a score for this machine.
  // If the machine already has a score, it is replaced.
  //
  // Body: { player_name, score, machine_id }
  // -------------------------------------------------------------------------
  fastify.post('/:game/scores', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    if (!guardGame(request, reply, game)) return;

    const { player_name, score, machine_id } = request.body ?? {};
    if (!player_name || score === undefined || score === null || !machine_id) {
      return reply.code(400).send({ error: 'player_name, score, and machine_id are required' });
    }
    if (typeof score !== 'number') {
      return reply.code(400).send({ error: 'score must be a number' });
    }

    const gameRow = getGame(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    // INSERT OR REPLACE handles the upsert (replaces the old row for this machine)
    fastify.db
      .prepare(`
        INSERT OR REPLACE INTO scores (game_id, machine_id, player_name, score, submitted_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `)
      .run(gameRow.id, machine_id, player_name, score);

    // Return the player's new rank
    const rank = fastify.db
      .prepare(`
        SELECT COUNT(*) + 1 as rank
        FROM scores
        WHERE game_id = ? AND score > (SELECT score FROM scores WHERE game_id = ? AND machine_id = ?)
      `)
      .get(gameRow.id, gameRow.id, machine_id);

    return { success: true, rank: rank.rank };
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/:game/scores
  // Fetch the leaderboard. Sorted by score descending (highest first).
  // For time-attack games where lower is better, pass ?order=asc
  //
  // Query params:
  //   limit  — number of entries to return (default 10, max 100)
  //   offset — for pagination (default 0)
  //   order  — "desc" (default) or "asc"
  // -------------------------------------------------------------------------
  fastify.get('/:game/scores', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    if (!guardGame(request, reply, game)) return;

    let { limit = 10, offset = 0, order = 'desc' } = request.query ?? {};
    limit  = Math.min(Math.max(parseInt(limit), 1), 100);
    offset = Math.max(parseInt(offset), 0);
    const dir = order === 'asc' ? 'ASC' : 'DESC';

    const gameRow = getGame(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    const rows = fastify.db
      .prepare(`
        SELECT
          ROW_NUMBER() OVER (ORDER BY score ${dir}) as rank,
          player_name,
          score,
          submitted_at
        FROM scores
        WHERE game_id = ?
        ORDER BY score ${dir}
        LIMIT ? OFFSET ?
      `)
      .all(gameRow.id, limit, offset);

    const total = fastify.db
      .prepare('SELECT COUNT(*) as c FROM scores WHERE game_id = ?')
      .get(gameRow.id).c;

    return { total, limit, offset, scores: rows };
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/:game/scores/rank
  // Get a specific machine's score and rank.
  //
  // Query params:
  //   machine_id — required
  //   order      — "desc" (default) or "asc"
  // -------------------------------------------------------------------------
  fastify.get('/:game/scores/rank', { preValidation }, async (request, reply) => {
    const { game } = request.params;
    if (!guardGame(request, reply, game)) return;

    const { machine_id, order = 'desc' } = request.query ?? {};
    if (!machine_id) return reply.code(400).send({ error: 'machine_id is required' });

    const dir = order === 'asc' ? 'ASC' : 'DESC';

    const gameRow = getGame(game);
    if (!gameRow) return reply.code(404).send({ error: 'Game not found' });

    const entry = fastify.db
      .prepare('SELECT * FROM scores WHERE game_id = ? AND machine_id = ?')
      .get(gameRow.id, machine_id);

    if (!entry) return reply.code(404).send({ error: 'No score found for this machine' });

    const rank = fastify.db
      .prepare(`
        SELECT COUNT(*) + 1 as rank FROM scores
        WHERE game_id = ?
          AND score ${dir === 'DESC' ? '>' : '<'} ?
      `)
      .get(gameRow.id, entry.score);

    const total = fastify.db
      .prepare('SELECT COUNT(*) as c FROM scores WHERE game_id = ?')
      .get(gameRow.id).c;

    return {
      player_name:  entry.player_name,
      score:        entry.score,
      rank:         rank.rank,
      total,
      submitted_at: entry.submitted_at
    };
  });
}
