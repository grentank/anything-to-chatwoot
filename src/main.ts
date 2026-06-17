import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
loadDotenv();

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { APP_CONFIG } from './config/config.module';
import { AppConfig } from './config/config.schema';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    // rawBody is required to verify Chatwoot webhook HMAC signatures.
    { rawBody: true, bufferLogs: false },
  );

  const config = app.get<AppConfig>(APP_CONFIG);
  app.useLogger(levelsFor(config.logLevel));
  // Ensure adapters are stopped and webhooks processed gracefully on shutdown.
  app.enableShutdownHooks();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.log(`anything-to-chatwoot listening on :${config.port} (${config.nodeEnv})`);
}

/** Map our configured log level to the set of Nest log levels to enable. */
function levelsFor(level: AppConfig['logLevel']) {
  const order: AppConfig['logLevel'][] = ['error', 'warn', 'log', 'debug', 'verbose'];
  const idx = order.indexOf(level);
  return order.slice(0, idx + 1);
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
