// worker-host.ts
import { parentPort, workerData } from 'node:worker_threads';
import { createRpcServer, createUplinkClient } from './rpc'; // Explicit .ts import

async function bootstrap() {
  const { pluginId, typeId, entryPoint, config, uplinkPort } = workerData;

  try {
    // 1. Dynamic Import (Works natively in ESM)
    const mod = await import(entryPoint);

    // 2. Find the definition
    let def = mod.default?.id === typeId ? mod.default : null;
    if (!def) {
      def = Object.values(mod).find(
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
        (x: any) => x && typeof x === 'object' && x.id === typeId
      );
    }

    if (!def) {
      throw new Error(
        `Could not find PluginTypeDefinition for '${typeId}' in ${entryPoint}`
      );
    }

    // 3. Mock Context
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    let serviceImplementation: any = null;
    const mockCtx = {
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      registerService: (id: string, schema: any, impl: any) => {
        schema.parse(impl);
        serviceImplementation = impl;
      },
      getService: (id: string) => {
        throw new Error('Workers cannot access other services yet.');
      },
      hasService: (id: string) => false,
    };

    // ✅ NEW: Create the Deps Proxy using the Uplink Client
    // This turns deps.logger.info(...) into a message back to main
    const deps = createUplinkClient(uplinkPort);

    // 4. Run Setup
    const result = await def.setup(mockCtx, config, deps, pluginId);

    if (!serviceImplementation && result) {
      serviceImplementation = result;
    }

    // 5. Start RPC Server
    createRpcServer(serviceImplementation, parentPort);

    if (parentPort) {
      // ✅ NEW: Listen for Lifecycle Signals
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      parentPort.on('message', async (msg: any) => {
        if (msg.type === 'TEARDOWN') {
          try {
            // Run the user's teardown logic if it exists
            if (def.teardown) {
              await def.teardown(pluginId);
            }
            parentPort?.postMessage({ type: 'TEARDOWN_COMPLETE', id: msg.id });
            // biome-ignore lint/suspicious/noExplicitAny: <explanation>
          } catch (err: any) {
            parentPort?.postMessage({
              type: 'TEARDOWN_COMPLETE',
              id: msg.id,
              error: err.message,
            });
          }
        }
      });
    }
    parentPort?.postMessage({ type: 'WORKER_READY', id: pluginId });
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: <explanation>
    console.error(`[Worker ${pluginId}] Fatal Error:`, err);
    process.exit(1);
  }
}

bootstrap();
