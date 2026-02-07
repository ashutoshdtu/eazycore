import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { definePlugin } from 'eazycore';

// --- Contracts ---
export const LoggerContract = z.object({
  info: z.function({
    input: z.tuple([z.string()]),
    output: z.void(),
  }),
  debug: z.function({
    input: z.tuple([z.string()]),
    output: z.void(),
  }),
  warn: z.function({
    input: z.tuple([z.string()]),
    output: z.void(),
  }),
  error: z.function({
    input: z.tuple([z.string()]),
    output: z.void(),
  }),
  trace: z.function({
    input: z.tuple([z.string()]),
    output: z.void(),
  }),
});

export const DatabaseContract = z.object({
  query: z.function({
    input: z.tuple([z.string()]),
    output: z.string(),
  }),
});

// --- Definitions ---

export const LoggerDef = definePlugin({
  id: 'logger-plugin',
  schema: z.object({
    provider: z.enum(['pino', 'console']).default('console'),
    level: z.enum(['info', 'debug', 'warn', 'error', 'trace']).default('info'),
    prefix: z.string().optional(),
  }),
  setup: async (ctx, config, _deps, id) => {
    let logger: z.infer<typeof LoggerContract>;

    // Implementation Factory
    if (config.provider === 'pino') {
      const { default: pino } = await import('pino');
      logger = pino({
        level: config.level,
        msgPrefix: config.prefix,
      }) as unknown as z.infer<typeof LoggerContract>;
    } else {
      logger = {
        info: (m: string) => console.log(`[${config.prefix}] ${m}`),
        debug: (m: string) => console.debug(`[${config.prefix}] ${m}`),
        warn: (m: string) => console.warn(`[${config.prefix}] ${m}`),
        error: (m: string) => console.error(`[${config.prefix}] ${m}`),
        trace: (m: string) => console.trace(`[${config.prefix}] ${m}`),
      };
    }

    ctx.registerService(id, LoggerContract, logger);
  },
});

export const DatabaseDef = definePlugin({
  id: 'db-plugin',
  schema: z.object({ connStr: z.string() }),
  requirements: { logger: LoggerContract },
  // Pointing to THIS file so the worker can find 'db-plugin' export here
  entryPoint: fileURLToPath(import.meta.url),
  setup: (ctx, config, deps, id) => {
    deps.logger.info(`Connecting to DB at ${config.connStr}`);
    const service = {
      query: (sql: string) => `[Result for ${sql}]`,
    };
    ctx.registerService(id, DatabaseContract, service);
  },
  teardown: (id) => console.log(`   [${id}] Teardown`),
});

export const ServerDef = definePlugin({
  id: 'api-server',
  schema: z.object({ port: z.number() }),
  requirements: { db: DatabaseContract, logger: LoggerContract },
  setup: async (_ctx, config, deps, id) => {
    const result = await deps.db.query('SELECT * FROM users');
    deps.logger.info(
      `   [${id}] Server started on :${config.port}. Result: ${result}`
    );
  },
  teardown: (id) => console.log(`   [${id}] Teardown`),
});
