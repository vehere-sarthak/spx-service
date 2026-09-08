import Config from './providers/Config';
import ConfigService from './providers/ConfigService';
import { AppRoutes } from './providers/AppRoutes';
import { Server } from './providers/Server';
import ProcessEvents from './providers/ProcessEvents';

const CONFIG_REFRESH_MS = 2 * 60 * 1000;

void main();

async function main(): Promise<void> {
  ProcessEvents.attach();

  // spx-ui owns spiderx.yml — pull it before binding.
  await Config.load();

  const svc = ConfigService.get().service || {};

  const server = new Server({
    port: process.env.PORT || svc.port || 8082,
    bind: process.env.BIND || svc.bind || '0.0.0.0',
    apiPrefix: process.env.API_PREFIX || svc.apiPrefix || '/api/v1',
    routes: AppRoutes.routes,
  });
  await server.start();

  // Keep in step with spx-ui, same cadence uiServices uses.
  setInterval(ConfigService.fetchConfig, CONFIG_REFRESH_MS);
}
