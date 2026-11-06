import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

/** Rebuilds the dedicated test database from migrations + seed. Refuses anything not named *_test. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL!;
  if (!/\/[a-z0-9_]*_test(\?|$)/.test(url)) throw new Error(`Refusing to reset non-test database: ${url}`);
  const prisma = new PrismaClient({ datasourceUrl: url });
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  await prisma.$disconnect();
  const env = { ...process.env, DATABASE_URL: url };
  execSync('npx prisma migrate deploy', { env, stdio: 'ignore' });
  execSync('npx tsx prisma/seed.ts', { env, stdio: 'ignore' });
}
