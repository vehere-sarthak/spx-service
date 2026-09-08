import cors from 'cors';
import { Request, Response, NextFunction } from 'express';
import ConfigService from '../providers/ConfigService';

/**
 * spx-ui runs on :4000, so credentialed cross-origin access is allowed only from
 * that origin on the appliance's own addresses. The origin list is derived
 * lazily because the config arrives from spx-ui after process start.
 */
class CORS {
  private cachedPort: number | null = null;
  private cachedOrigins: string[] = [];

  private origins(): string[] {
    const uiPort = ConfigService.get().server?.port || 4000;
    if (this.cachedPort === uiPort) return this.cachedOrigins;

    const setup = ConfigService.getSetupConfig();
    const appIps: string[] = setup?.app?.ip || [];
    this.cachedOrigins = [
      ...appIps.map((ip: string) => `https://${ip}:${uiPort}`),
      `https://127.0.0.1:${uiPort}`,
      `https://0.0.0.0:${uiPort}`,
      `https://localhost:${uiPort}`,
    ];
    this.cachedPort = uiPort;
    console.log('[spx-service] Allowed origins:', this.cachedOrigins);
    return this.cachedOrigins;
  }

  public applyCorsOptions = (req: Request, res: Response, next: NextFunction) => {
    const restricted = this.origins();
    const requestOrigin = req.headers.origin;
    const exposedHeaders = [
      'Content-Type',
      'Authorization',
      'Content-Disposition',
      'x-host-server',
      'x-meta-time',
      'X-Meta-Time',
    ];

    const corsOptions: cors.CorsOptions =
      requestOrigin && restricted.includes(requestOrigin)
        ? {
            origin: restricted,
            credentials: true,
            methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
            preflightContinue: false,
            optionsSuccessStatus: 204,
            exposedHeaders,
          }
        : {
            origin: '*',
            credentials: false,
            methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
            preflightContinue: false,
            optionsSuccessStatus: 204,
            exposedHeaders,
          };

    cors(corsOptions)(req, res, next);
  };
}

export default new CORS();
