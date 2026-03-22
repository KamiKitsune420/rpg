import fp from 'fastify-plugin';
import { verifyJwt } from '../auth.js';

async function authenticatePlugin(fastify) {
  // Decorate request with the game payload after JWT verification
  fastify.decorate('authenticate', async function (request, reply) {
    const auth = request.headers['authorization'];

    if (!auth || !auth.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing or malformed Authorization header' });
    }

    try {
      request.game = verifyJwt(auth.slice(7));
    } catch {
      return reply.code(401).send({ error: 'Invalid or expired token' });
    }
  });

  // Decorator for admin routes — checks X-Admin-Key header
  fastify.decorate('authenticateAdmin', async function (request, reply) {
    const key = request.headers['x-admin-key'];

    if (!key || key !== process.env.ADMIN_KEY) {
      return reply.code(401).send({ error: 'Invalid admin key' });
    }
  });
}

export default fp(authenticatePlugin);
