// Local Postgres without Docker: boots a real PostgreSQL 17 binary (from the
// embedded-postgres npm package) with data under .pgdata/. Use this when Docker
// is unavailable; otherwise prefer `docker compose up -d`.
//
// Usage: node scripts/dev-db.mjs            -> start and keep running
//        node scripts/dev-db.mjs --create-test -> also ensure rtm_test exists
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
  onLog: () => {},
});

const fresh = !existsSync(resolve(dataDir, 'PG_VERSION'));
if (fresh) await pg.initialise();
await pg.start();

for (const db of ['rtm', 'rtm_test']) {
  try {
    await pg.createDatabase(db);
    console.log(`created database ${db}`);
  } catch {
    // already exists
  }
}

console.log(`Postgres ready on localhost:${port} (user rtm / password rtm). Ctrl+C to stop.`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
