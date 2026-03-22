import { verifyHmac, signJwt } from '../auth.js';

export default async function authRoutes(fastify) {
  /**
   * POST /api/v1/auth
   *
   * The NVGT game authenticates here before calling any other endpoint.
   * It sends a HMAC-SHA256 signature so the raw api_secret is never transmitted.
   *
   * Body:
   *   game_id   — the game's identifier (e.g. "puzzle_game")
   *   timestamp — current unix timestamp in seconds (integer)
   *   signature — HMAC-SHA256 hex of "game_id:timestamp" signed with the api_secret
   *
   * NVGT example:
   *   string msg = game_id + ":" + timestamp;
   *   string sig = hmac_sha256_hex(msg, api_secret);
   *
   * Returns: { token } — a JWT valid for 1 hour, used in all subsequent requests
   */
  fastify.post('/auth', {
    schema: {
      body: {
        type: 'object',
        required: ['game_id', 'timestamp', 'signature'],
        properties: {
          game_id:   { type: 'string', minLength: 1 },
          timestamp: { type: 'integer' },
          signature: { type: 'string', minLength: 64, maxLength: 64 }
        }
      }
    }
  }, async (request, reply) => {
    const { game_id, timestamp, signature } = request.body;

    const game = fastify.db
      .prepare('SELECT * FROM games WHERE name = ?')
      .get(game_id);

    // Return the same error whether the game doesn't exist or the signature
    // is wrong — don't leak which one failed
    if (!game || !verifyHmac(game_id, timestamp, signature, game.api_secret)) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    return { token: signJwt(game_id) };
  });
}
