// Local Postgres without Docker: boots a real PostgreSQL 17 binary (from the
// embedded-postgres npm package) with data under .pgdata/. Use this when Docker
// is unavailable; otherwise prefer `docker compose up -d`.
//
// Databases are always created as UTF-8 (on Windows initdb would otherwise inherit
// the WIN1252 code page, which cannot store ₹ and other non-Latin text).
//
// Usage: node scripts/dev-db.mjs     -> start and keep running
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, '.pgdata');
const port = Number(process.env.PGPORT ?? 5433);

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'rtm',
  password: 'rtm',
  port,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
});

const fresh = !existsSync(resolve(dataDir, 'PG_VERSION'));
if (fresh) await pg.initialise();
await pg.start();

const client = pg.getPgClient();
await client.connect();
for (const db of ['rtm', 'rtm_test']) {
  const r = await client.query('SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = $1', [db]);
  if (r.rowCount === 0) {
    await client.query(`CREATE DATABASE ${db} ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
    console.log(`created database ${db} (UTF8)`);
  } else if (r.rows[0].enc !== 'UTF8') {
    console.warn(`WARNING: database ${db} is ${r.rows[0].enc}, not UTF8 — recreate it (drop it and restart this script), then migrate and seed.`);
  }
}
await client.end();

console.log(`Postgres ready on localhost:${port} (user rtm / password rtm). Ctrl+C to stop.`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
