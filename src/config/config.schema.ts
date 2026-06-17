import { z } from 'zod';

/**
 * Environment schema. Validated once at startup so the process fails fast with a
 * clear message instead of throwing deep inside a request later.
 */

const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const envSchema = z.object({
  // --- App ---
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),
  FORWARD_SYSTEM_MESSAGES: booleanFromEnv.default('false'),

  // --- Chatwoot ---
  CHATWOOT_BASE_URL: z.string().url(),
  CHATWOOT_API_ACCESS_TOKEN: z.string().min(1),
  CHATWOOT_ACCOUNT_ID: z.coerce.number().int().positive(),
  // Optional HMAC secret to verify Chatwoot webhooks. Verification is skipped if empty.
  CHATWOOT_WEBHOOK_SECRET: z.string().optional().default(''),

  // --- Telegram ---
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_INBOX_ID: z.coerce.number().int().positive(),
  TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),
  // Required only in webhook mode: public https domain that Telegram calls back.
  TELEGRAM_WEBHOOK_DOMAIN: z.string().url().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional().default(''),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  logLevel: Env['LOG_LEVEL'];
  forwardSystemMessages: boolean;
  chatwoot: {
    baseUrl: string;
    apiAccessToken: string;
    accountId: number;
    webhookSecret: string;
  };
  telegram: {
    botToken: string;
    inboxId: number;
    mode: Env['TELEGRAM_MODE'];
    webhookDomain?: string;
    webhookSecret: string;
  };
}

/** Parse and validate `process.env` into a typed, structured config object. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  if (env.TELEGRAM_MODE === 'webhook' && !env.TELEGRAM_WEBHOOK_DOMAIN) {
    throw new Error('TELEGRAM_WEBHOOK_DOMAIN is required when TELEGRAM_MODE=webhook');
  }

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    forwardSystemMessages: env.FORWARD_SYSTEM_MESSAGES,
    chatwoot: {
      baseUrl: env.CHATWOOT_BASE_URL.replace(/\/+$/, ''),
      apiAccessToken: env.CHATWOOT_API_ACCESS_TOKEN,
      accountId: env.CHATWOOT_ACCOUNT_ID,
      webhookSecret: env.CHATWOOT_WEBHOOK_SECRET,
    },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN,
      inboxId: env.TELEGRAM_INBOX_ID,
      mode: env.TELEGRAM_MODE,
      webhookDomain: env.TELEGRAM_WEBHOOK_DOMAIN,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    },
  };
}
