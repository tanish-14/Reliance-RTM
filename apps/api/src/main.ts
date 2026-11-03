import 'reflect-metadata';
import 'dotenv/config';

async function bootstrap() {
  // Imported after dotenv so module-level config (JWT secret) sees .env.
  const { createApp } = await import('./app.module');
  const app = await createApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
