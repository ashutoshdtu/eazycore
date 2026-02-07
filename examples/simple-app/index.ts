// main.ts
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EazyApp } from './app';
import { DatabaseDef, LoggerDef, ServerDef } from './plugins';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
    const app = new EazyApp({
        name: 'My Super App',
        lockDefinitions: true, // Prevent 3rd party definition injection
        extraDefinitions: [], // We don't have custom types today

        // The Declarative Composition Root
        plugins: [
            LoggerDef.create('sys-logger', {
                prefix: '[SYS]',
                provider: 'pino',
                level: 'debug',
            }),

            DatabaseDef.create(
                'my-primary-db',
                { connStr: 'postgres://local' },
                { logger: 'sys-logger' },
                'worker' // Run in background thread!
            ),

            ServerDef.create(
                'my-web-server',
                { port: 8080 },
                { db: 'my-primary-db', logger: 'sys-logger' }
            ),
        ],
    });

    // Lifecycle
    try {
        // 1. Dry Run
        app.log('\n--- DRY RUN ---');
        await app.start({ dryRun: true });
        app.log('\n⏳ Fake delay of 1s...');
        await new Promise((r) => setTimeout(r, 1000));
        await app.stop({ dryRun: true });

        // 2. Real Start
        app.log('\n--- STARTING ---');
        await app.start();

        // Keep alive for demo
        app.log('\n⏳ Fake delay of 1s...');
        await new Promise((r) => setTimeout(r, 1000));

        // 3. Shutdown
        app.log('\n--- STOPPING ---');
        await app.stop();
    } catch (err) {
        // biome-ignore lint/suspicious/noConsole: <explanation>
        console.error('Fatal App Error:', err);
        process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
