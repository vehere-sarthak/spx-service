import ConfigService from './ConfigService';

class Config {
  /**
   * Pull the config from spx-ui before the server binds, mirroring uiServices'
   * `await this.fetchUiConfig()` in Server.start().
   */
  public async load(): Promise<void> {
    await ConfigService.fetchConfig();
    if (ConfigService.isLoaded()) {
      const svc = ConfigService.get().service || {};
      console.log(
        `[spx-service] config pulled from spx-ui — api ${svc.apiPrefix || '/api/v1'} on port ${svc.port || 8082}`
      );
    } else {
      console.warn('[spx-service] starting with built-in defaults; will retry spx-ui on the refresh timer');
    }
  }
}

export default new Config();
