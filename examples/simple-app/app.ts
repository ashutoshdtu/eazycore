// app.ts
import {
  EazyCore,
  type PluginInstance,
  type PluginTypeDefinition,
} from 'eazycore';
import { DatabaseDef, LoggerDef, ServerDef } from './plugins';

export interface EazyAppConfig {
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: Generic definitions
  extraDefinitions?: PluginTypeDefinition<any, any>[];
  lockDefinitions?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: Generic instances
  plugins: PluginInstance<any, any>[];
}

export class EazyApp {
  private core = new EazyCore();
  private config: EazyAppConfig;
  // biome-ignore lint/nursery/useConsistentMemberAccessibility: <explanation>
  public log = this.core.log;

  constructor(config: EazyAppConfig) {
    this.config = config;
    this.core.log(`🚀 Initializing ${config.name}...`);

    // 1. Register System Definitions (The "Standard Library" of your framework)
    this.core.registerDefinition(LoggerDef);
    this.core.registerDefinition(DatabaseDef);
    this.core.registerDefinition(ServerDef);

    // 2. Lock Registry (Optional Security)
    if (config.lockDefinitions) {
      this.core.lockDefinitions();
    }
    // 3. Register Extra Definitions (if any)
    else if (config.extraDefinitions) {
      for (const def of config.extraDefinitions) {
        this.core.registerDefinition(def);
      }
    }

    // 4. Lock Registry (Finally)
    this.core.lockDefinitions();

    // 4. Register Plugin Instances
    for (const plugin of config.plugins) {
      this.core.registerPlugin(plugin);
    }
  }

  async start(options: { dryRun?: boolean } = {}) {
    await this.core.start(options);
  }

  async stop(options: { dryRun?: boolean } = {}) {
    await this.core.stop(options);
  }
}
