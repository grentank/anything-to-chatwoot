import { Global, Module } from '@nestjs/common';
import { AppConfig, loadConfig } from './config.schema';

/** DI token to inject the validated {@link AppConfig}. */
export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * Global config module. Loads + validates env once and exposes it as a value
 * provider, so the rest of the app injects a typed object rather than reading
 * `process.env` directly.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
