// index.ts
import { MessageChannel, Worker } from 'node:worker_threads'; // Add MessageChannel
import type { ZodSchema, ZodType, z } from 'zod';
import { createRpcClient, createUplinkServer, gracefulTeardown } from './rpc'; // Add UplinkServer

// --- Types ---
export type WiringMap<T extends Record<string, ZodType>> = {
  [K in keyof T]: string;
};

export type ExecutionMode = 'main' | 'worker';

export class PluginContext {
  private services = new Map<string, unknown>();

  registerService<T>(
    id: string,
    schema: ZodSchema<T>,
    impl: T,
    validate = true
  ): void {
    if (this.services.has(id)) {
      throw new Error(`Service '${id}' already registered.`);
    }
    // Note: If 'impl' is a Proxy from a worker, Zod might fail if it strictly checks
    // for Function prototypes. Zod schemas for worker plugins should likely use z.function()
    // without strict impl checks, or we trust the RPC type safety.
    if (validate) {
      try {
        // We skip deep validation for Proxies as they are "Ghost" objects
        // In a strict world, we would validate the interface shape.
        schema.parse(impl);
      } catch (e) {
        throw new Error(`Service '${id}' failed contract validation: ${e}`);
      }
    }
    this.services.set(id, impl);
  }

  getService(id: string): unknown {
    if (!this.services.has(id)) {
      throw new Error(`Service '${id}' not found.`);
    }
    return this.services.get(id);
  }

  hasService(id: string): boolean {
    return this.services.has(id);
  }
}

// --- Definition Helper ---

type InferDeps<T extends Record<string, ZodType>> = {
  [K in keyof T]: z.infer<T[K]>;
};

export interface PluginTypeDefinition<
  TConfig extends ZodType,
  TReqs extends Record<string, ZodType>,
> {
  id: string;
  schema: TConfig;
  requirements?: TReqs;
  entryPoint?: string; // Required for workers
  setup: (
    ctx: PluginContext,
    config: z.infer<TConfig>,
    // deps: Record<keyof TReqs, any>,
    deps: InferDeps<TReqs>,
    pluginId: string
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  ) => void | Promise<void> | Promise<any>;
  teardown?: (pluginId: string) => void | Promise<void>;

  // Factory Helper attached to the definition for easy instantiation
  create: (
    id: string,
    config: z.infer<TConfig>,
    wiring?: WiringMap<TReqs>,
    mode?: ExecutionMode
  ) => PluginInstance<z.infer<TConfig>, TReqs>;
}

// ✅ STANDALONE HELPER: Does not require an EazyCore instance
export function definePlugin<
  C extends ZodType,
  // biome-ignore lint/complexity/noBannedTypes: <explanation>
  R extends Record<string, ZodType> = {},
>(def: Omit<PluginTypeDefinition<C, R>, 'create'>): PluginTypeDefinition<C, R> {
  return {
    ...def,
    create: (id, config, wiring = {} as WiringMap<R>, mode = 'main') => ({
      id,
      typeId: def.id,
      config,
      wiring,
      mode,
    }),
  };
}

export interface PluginInstance<C, R extends Record<string, ZodType>> {
  id: string;
  typeId: string;
  config: C;
  wiring: WiringMap<R>;
  mode: ExecutionMode;
}

// --- The Graph Core ---
export class EazyCore {
  // biome-ignore lint/nursery/useConsistentMemberAccessibility: <explanation>
  public context = new PluginContext();

  // Stores the Definitions (The "Shapes")
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private pluginTypes = new Map<string, PluginTypeDefinition<any, any>>();

  // Stores the Instances (The "Living Objects")
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private instances = new Map<string, PluginInstance<any, any>>();
  private workers = new Map<string, Worker>();

  // ✅ FREEZE FEATURE
  private definitionsLocked = false;

  // biome-ignore lint/nursery/useConsistentMemberAccessibility: <explanation>
  public log = console.log;

  constructor() {
    // Safety net: ensure we kill workers if the main process dies unexpectedly
    process.on('exit', () => this.killAllWorkersSync());
  }

  // Synchronous kill for process.exit events
  private killAllWorkersSync() {
    for (const [id, worker] of this.workers) {
      worker.terminate(); // Fire and forget
    }
  }

  /**
   * Registers a Plugin Type Definition.
   * Call this during bootstrap.
   */

  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  registerDefinition(def: PluginTypeDefinition<any, any>) {
    if (this.definitionsLocked) {
      throw new Error(
        `Registry is locked. Cannot register new plugin type: '${def.id}'`
      );
    }
    if (this.pluginTypes.has(def.id)) {
      throw new Error(`Plugin Type '${def.id}' is already registered.`);
    }
    this.pluginTypes.set(def.id, def);
  }

  /**
   * 🔒 Locks the registry.
   *
   * Useful to ensure 3rd parties cannot inject new TYPES, only instances.
   */
  lockDefinitions() {
    this.definitionsLocked = true;
  }

  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  registerPlugin(plugin: PluginInstance<any, any>) {
    if (!this.pluginTypes.has(plugin.typeId)) {
      throw new Error(
        `Unknown Plugin Type: '${plugin.typeId}'. Did you forget to register the definition?`
      );
    }
    if (this.instances.has(plugin.id)) {
      throw new Error(`Plugin Instance ID '${plugin.id}' is already used.`);
    }
    this.instances.set(plugin.id, plugin);
  }

  /**
   * TOPOLOGICAL SORT
   * Returns plugin IDs in the order they must be started.
   */
  private resolveExecutionOrder(): string[] {
    const visited = new Set<string>();
    const sorted: string[] = [];
    const visiting = new Set<string>();

    const visit = (nodeId: string, ancestors: string[]) => {
      if (visited.has(nodeId)) {
        return;
      }
      if (visiting.has(nodeId)) {
        throw new Error(
          `Cyclic dependency: ${ancestors.join(' -> ')} -> ${nodeId}`
        );
      }
      visiting.add(nodeId);
      ancestors.push(nodeId);

      const instance = this.instances.get(nodeId);
      if (instance) {
        const dependencies = Object.values(instance.wiring);
        for (const depId of dependencies) {
          if (this.instances.has(depId)) {
            visit(depId, ancestors);
          }
        }
      }
      visiting.delete(nodeId);
      ancestors.pop();
      visited.add(nodeId);
      sorted.push(nodeId);
    };

    for (const id of this.instances.keys()) {
      visit(id, []);
    }
    return sorted;
  }

  generateMermaidGraph(): string {
    let graph = 'graph TD;\n';
    for (const [id, plugin] of this.instances) {
      // 1. Define the Node
      // Format: ID["ID (Type) [Mode]"]
      // Add visual cue for Workers (Hexagon shape or different color)
      const shape = plugin.mode === 'worker' ? '{{' : '[';
      const endShape = plugin.mode === 'worker' ? '}}' : ']';
      graph += `  ${id}${shape}"${id}<br/><small>(${plugin.typeId}) [${plugin.mode}]</small>"${endShape};\n`;

      // 2. Define the Edges (Dependencies)
      // Format: Consumer -->|requirement name| Provider
      for (const [reqName, targetId] of Object.entries(plugin.wiring)) {
        if (this.instances.has(targetId)) {
          graph += `  ${id} -.->|${reqName}| ${targetId};\n`;
        } else {
          // Highlight external/missing services in red
          graph += `  ${id} -.->|${reqName}| MISSING[?${targetId}?];\n`;
          // biome-ignore lint/style/noUnusedTemplateLiteral: <explanation>
          graph += `  style MISSING fill:#f9f,stroke:#333,stroke-width:2px;\n`;
        }
      }
    }
    return graph;
  }

  async start(options: { dryRun?: boolean } = {}) {
    this.log(`🧩 EazyCore Starting${options.dryRun ? ' [DRY RUN]' : ''}...`);
    const order = this.resolveExecutionOrder();

    this.log(`🟡 Execution Order: ${order.join(' -> ')}`);
    if (options.dryRun) {
      // this.log('\n🔍 Verifying Topology...');
      // this.log(`🟡 Execution Order: \n   ${order.join(' \n   ⬇\n   ')}`);
      this.log('📊 Mermaid Graph:');
      // this.log('-------------------------------------------');
      this.log('---');
      this.log(this.generateMermaidGraph());
      this.log('---');
      this.log('✅ System Ready');
      return;
    }

    for (const id of order) {
      // biome-ignore lint/style/noNonNullAssertion: <explanation>
      const plugin = this.instances.get(id)!;
      // ✅ Now this lookup works because we registered definitions on THIS instance
      // biome-ignore lint/style/noNonNullAssertion: <explanation>
      const type = this.pluginTypes.get(plugin.typeId)!;

      this.log(`   [${id}] Initializing (${plugin.mode})...`);

      // 1. Validate Config
      const config = type.schema.parse(plugin.config);

      // 2. Resolve Dependencies (Common to both modes)
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      const deps: Record<string, any> = {};

      if (plugin.mode === 'main' && type.requirements) {
        for (const key of Object.keys(type.requirements)) {
          const serviceId = plugin.wiring[key];
          if (!serviceId) {
            throw new Error(`Plugin '${id}' missing wiring for '${key}'`);
          }
          deps[key] = this.context.getService(serviceId);
        }
      }

      // 3. Execution Branch
      if (plugin.mode === 'main') {
        // --- LOCAL ---
        // 'setup' usually registers the service into ctx itself
        // But for consistency with workers, we allow setup to return the service object
        const result = await type.setup(this.context, config, deps, id);
        if (result && !this.context.hasService(id)) {
          // Auto-register if the plugin returns a service object
          // This allows the shorthand "return { ... }" style in main.ts
          this.context.registerService(id, type.schema, result);
        }
      } else if (plugin.mode === 'worker') {
        // --- WORKER ---
        if (!type.entryPoint) {
          throw new Error(`Plugin '${type.id}' missing entryPoint`);
        }

        // ✅ NEW: Create a private channel for dependencies
        const { port1: mainPort, port2: workerPort } = new MessageChannel();

        // ✅ Start the Uplink Server on the main thread
        // This listens to the worker asking for "logger" and routes it to "sys-logger"
        createUplinkServer(this.context, plugin.wiring, mainPort);

        // Spawn Worker
        // We use a generic 'worker-host.js' that loads the actual plugin code
        const worker = new Worker(
          new URL('./worker-host.mjs', import.meta.url),
          {
            workerData: {
              pluginId: id,
              typeId: type.id,
              entryPoint: type.entryPoint,
              config: config,
              uplinkPort: workerPort,
            },
            // ✅ CRITICAL: We must transfer ownership of the port to the worker
            transferList: [workerPort],
            // This tells Node to use the same loader as the main process
            // execArgv: process.execArgv,
            // execArgv: ['--import', 'tsx'],
          }
        );
        this.workers.set(id, worker);
        // Create the Proxy immediately
        // This allows other plugins to 'require' this worker plugin immediately
        // The calls will just await until the worker responds.
        const proxy = createRpcClient(worker);
        // Register the Proxy as the Service
        this.context.registerService(id, type.schema, proxy, false);
      }
    }
    this.log('✅ System Ready');
  }

  async stop(options: { dryRun?: boolean } = {}) {
    this.log(`\n🛑 EazyCore Stopping...${options.dryRun ? ' [DRY RUN]' : ''}`);
    const order = this.resolveExecutionOrder().reverse();

    if (options.dryRun) {
      this.log(`🟠 Teardown Order: ${order.join(' -> ')}`);
      this.log('✅ System Stopped');
      return;
    }

    for (const id of order) {
      // biome-ignore lint/style/noNonNullAssertion: <explanation>
      const plugin = this.instances.get(id)!;
      // biome-ignore lint/style/noNonNullAssertion: <explanation>
      const type = this.pluginTypes.get(plugin.typeId)!;
      try {
        if (plugin.mode === 'main' && type.teardown) {
          await type.teardown(id);
        } else if (plugin.mode === 'worker') {
          const worker = this.workers.get(id);
          if (worker) {
            this.log(`   [${id}] Terminating Worker...`);
            // ✅ Graceful Teardown with 5s timeout
            await gracefulTeardown(worker, 5000);
            await worker.terminate(); // Final cleanup
            this.workers.delete(id);
          }
        }
      } catch (err) {
        this.log(`   [${id}] Error during teardown: ${err}`);
      }
    }
    this.log('✅ System Stopped');
  }
}
