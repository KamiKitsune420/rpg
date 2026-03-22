import 'dotenv/config';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

import db from './db.js';
import authenticatePlugin from './plugins/authenticate.js';
import authRoutes from './routes/auth.js';
import gameRoutes from './routes/game.js';
import scoreRoutes from './routes/scores.js';
import adminRoutes from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const MOTD_DIR    = path.join(UPLOADS_DIR, 'motd');
const GAMES_DIR   = path.join(UPLOADS_DIR, 'games');

// Ensure upload directories exist on startup
if (!existsSync(MOTD_DIR))  mkdirSync(MOTD_DIR,  { recursive: true });
if (!existsSync(GAMES_DIR)) mkdirSync(GAMES_DIR, { recursive: true });

const fastify = Fastify({ logger: true });

// Make db and upload paths available to all routes
fastify.decorate('db', db);
fastify.decorate('uploadsDir', UPLOADS_DIR);

// Register auth decorators (authenticate, authenticateAdmin)
await fastify.register(authenticatePlugin);

// Serve audio MOTD files from /uploads/motd/
// To host a MOTD audio file: drop it in the uploads/motd/ directory on the server
// and reference it as: BASE_URL + "/uploads/motd/filename.ogg"
await fastify.register(staticFiles, {
  root:   UPLOADS_DIR,
  prefix: '/uploads/'
});

// Routes
await fastify.register(authRoutes,  { prefix: '/api/v1' });
await fastify.register(gameRoutes,  { prefix: '/api/v1' });
await fastify.register(scoreRoutes, { prefix: '/api/v1' });
await fastify.register(adminRoutes, { prefix: '/api/v1/admin' });

// Health check — useful to confirm the server is up
fastify.get('/health', async () => ({ status: 'ok' }));

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '127.0.0.1';

try {
  await fastify.listen({ port: PORT, host: HOST });
  console.log(`Game server running on ${HOST}:${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
