import { Request, Response } from 'express';
import ConfigService from '../providers/ConfigService';

class HealthController {
  /** Liveness probe — answers without touching ES or MySQL. */
  public live = (req: Request, res: Response) => {
    res.json({
      ok: true,
      service: 'spx-service',
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  };

  /**
   * Readiness — reports what the service is configured to talk to.
   * Connectivity checks land here as ES/MySQL providers are migrated over.
   */
  public ready = (req: Request, res: Response) => {
    const cfg = ConfigService.get();
    res.json({
      ok: true,
      service: 'spx-service',
      configLoaded: ConfigService.isLoaded(),
      elasticsearch: { configured: Boolean(cfg.elasticsearch_config?.hosts) },
      mysql: { configured: Boolean(cfg.mySQL_config?.host) },
      tls: { enabled: ConfigService.sslOptions() !== null },
    });
  };
}

export default new HealthController();
