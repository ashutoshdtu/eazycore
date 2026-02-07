// rpc.ts
import type { MessagePort, Worker, parentPort } from 'node:worker_threads';
import { nanoid } from 'nanoid';

// TODO: Make this configurable
const DEFAULT_RPC_TIMEOUT_MS = 10000;

// --- Types ---
export type RpcMessage =
  | { type: 'CALL'; id: string; method: string; args: unknown[] }
  | { type: 'RESPONSE'; id: string; result: unknown }
  | { type: 'ERROR'; id: string; error: string }
  | { type: 'TEARDOWN'; id: string }
  | { type: 'TEARDOWN_COMPLETE'; id: string; error?: string };

// New: For Worker -> Main dependency calls
export type UplinkMessage =
  | {
    type: 'UPLINK_CALL';
    id: string;
    serviceName: string;
    method: string;
    args: unknown[];
  }
  | { type: 'UPLINK_RESPONSE'; id: string; result: unknown }
  | { type: 'UPLINK_ERROR'; id: string; error: string };

// --- 1. Client (Main -> Worker) ---
export function createRpcClient<T extends object>(
  worker: Worker,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS
): T {
  const pending = new Map<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();

  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  worker.on('message', (msg: any) => {
    if (msg.type === 'RESPONSE') {
      pending.get(msg.id)?.resolve(msg.result);
    }
    if (msg.type === 'ERROR') {
      pending.get(msg.id)?.reject(new Error(msg.error));
    }
    if (msg.type === 'RESPONSE' || msg.type === 'ERROR') {
      pending.delete(msg.id);
    }
  });

  return new Proxy({} as T, {
    get: (_, prop) => {
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          const id = nanoid();

          // 1. Set Timeout
          const timer = setTimeout(() => {
            pending.delete(id); // Clean up memory
            reject(
              new Error(
                `RPC Timeout: Call to '${String(prop)}' took > ${timeoutMs}ms`
              )
            );
          }, timeoutMs);

          // 2. Wrap Resolve/Reject to clear timeout
          pending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          });
          // pending.set(id, { resolve, reject });
          worker.postMessage({ type: 'CALL', id, method: String(prop), args });
        });
    },
  });
}

// --- 2. Server (Worker implementation) ---
export function createRpcServer(
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  service: any,
  port: MessagePort | typeof parentPort
) {
  if (!port) {
    return;
  }
  // @ts-ignore - Ensure port is started
  if (port.start) {
    port.start();
  }

  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  port.on('message', async (msg: any) => {
    if (msg.type === 'CALL') {
      try {
        const result = await service[msg.method](...msg.args);
        port.postMessage({ type: 'RESPONSE', id: msg.id, result });
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      } catch (err: any) {
        port.postMessage({ type: 'ERROR', id: msg.id, error: err.message });
      }
    }
  });
}

// --- 3. Uplink Client (Worker -> Main) ---
// We now use a recursive Proxy so 'deps.anyService.anyMethod()' just works.
// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export function createUplinkClient(port: MessagePort): any {
  port.start(); // CRITICAL: Must start the transferred port
  const pending = new Map<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();

  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  port.on('message', (msg: any) => {
    if (msg.type === 'UPLINK_RESPONSE') {
      pending.get(msg.id)?.resolve(msg.result);
    }
    if (msg.type === 'UPLINK_ERROR') {
      pending.get(msg.id)?.reject(new Error(msg.error));
    }
    if (msg.type === 'UPLINK_RESPONSE' || msg.type === 'UPLINK_ERROR') {
      pending.delete(msg.id);
    }
  });

  // Layer 1: deps.serviceName
  return new Proxy(
    {},
    {
      get: (_, serviceName: string) => {
        // Layer 2: deps.serviceName.methodName
        return new Proxy(
          {},
          {
            get: (__, method: string) => {
              return (...args: unknown[]) =>
                new Promise((resolve, reject) => {
                  const id = nanoid();
                  pending.set(id, { resolve, reject });
                  port.postMessage({
                    type: 'UPLINK_CALL',
                    id,
                    serviceName,
                    method,
                    args,
                  });
                });
            },
          }
        );
      },
    }
  );
}

// --- 4. Uplink Server (Main side) ---
export function createUplinkServer(
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  ctx: { getService: (id: string) => any },
  wiring: Record<string, string>,
  port: MessagePort
) {
  port.start(); // CRITICAL
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  port.on('message', async (msg: any) => {
    if (msg.type === 'UPLINK_CALL') {
      try {
        const serviceId = wiring[msg.serviceName];
        if (!serviceId) {
          throw new Error(`Wiring missing for ${msg.serviceName}`);
        }

        const service = ctx.getService(serviceId);
        const result = await service[msg.method](...msg.args);

        port.postMessage({ type: 'UPLINK_RESPONSE', id: msg.id, result });
        // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      } catch (err: any) {
        port.postMessage({
          type: 'UPLINK_ERROR',
          id: msg.id,
          error: err.message,
        });
      }
    }
  });
}

// ✅ NEW: Helper to gracefully stop a worker
export function gracefulTeardown(
  worker: Worker,
  timeoutMs = 5000
): Promise<void> {
  return new Promise((resolve, _reject) => {
    const id = nanoid();

    // 1. Safety Timeout (Force Kill)
    const timer = setTimeout(() => {
      worker.terminate(); // Force kill
      // biome-ignore lint/suspicious/noConsole: <explanation>
      console.warn('[RPC] Worker teardown timed out. Force terminated.');
      resolve();
    }, timeoutMs);

    // 2. Listen for completion
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    const handler = (msg: any) => {
      if (msg.type === 'TEARDOWN_COMPLETE' && msg.id === id) {
        clearTimeout(timer);
        worker.off('message', handler);
        if (msg.error) {
          // biome-ignore lint/suspicious/noConsole: <explanation>
          console.error(`[RPC] Worker teardown failed: ${msg.error}`);
        }
        resolve();
      }
    };

    worker.on('message', handler);

    // 3. Send Signal
    worker.postMessage({ type: 'TEARDOWN', id });
  });
}

// Helper to serialize errors
function serializeError(err: Error) {
  return {
    message: err.message || 'Unknown Error',
    stack: err.stack,
    name: err.name,
    // Add other custom properties if needed
    // code: err.code,
  };
}

// Helper to hydrate errors on receipt
function deserializeError(errData: Error) {
  const e = new Error(errData.message);
  e.stack = errData.stack;
  e.name = errData.name;
  return e;
}
