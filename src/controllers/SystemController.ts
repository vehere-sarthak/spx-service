import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import ConfigService from '../providers/ConfigService';

class SystemController {
  /**
   * Non-secret view of the effective runtime config, for install verification.
   * Secrets (ES/MySQL passwords, session secret) are deliberately never echoed.
   */
  public config = (req: Request, res: Response) => {
    const cfg = ConfigService.get();
    res.json({
      ok: true,
      service: 'spx-service',
      configSource: ConfigService.isLoaded() ? 'spx-ui' : 'defaults (spx-ui unreachable)',
      server: cfg.server,
      serviceConfig: {
        port: cfg.service?.port,
        bind: cfg.service?.bind,
        apiPrefix: cfg.service?.apiPrefix,
        preferHttps: cfg.service?.preferHttps,
      },
      elasticsearch: {
        hosts: cfg.elasticsearch_config?.hosts,
        username: cfg.elasticsearch_config?.username,
        rejectUnauthorized: cfg.elasticsearch_config?.rejectUnauthorized === true,
      },
      mysql: {
        host: cfg.mySQL_config?.host,
        port: cfg.mySQL_config?.port,
        database: cfg.mySQL_config?.database,
        user: cfg.mySQL_config?.user,
      },
      tls: {
        enabled: ConfigService.sslOptions() !== null,
        certificate: ConfigService.certPaths().cert,
        key: ConfigService.certPaths().key,
      },
      dbIndex: cfg.dbIndex,
    });
  };

  /** Build metadata written by buildInfo.js at package time. */
  public about = (req: Request, res: Response) => {
    const file = path.join(process.cwd(), 'buildInfo.txt');
    let buildInfo: string | null = null;
    try {
      if (fs.existsSync(file)) buildInfo = fs.readFileSync(file, 'utf-8');
    } catch {
      buildInfo = null;
    }
    res.json({
      ok: true,
      service: 'spx-service',
      node: process.version,
      buildInfo,
    });
  };
}

export default new SystemController();
