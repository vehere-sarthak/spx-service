import helmet from 'helmet';
import { Request, Response, NextFunction } from 'express';

class SecurityHeaders {
  private readonly helmetOptions = {
    contentSecurityPolicy: false as const,
    frameguard: { action: 'deny' as const },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    xssFilter: true,
    hidePoweredBy: true,
    ieNoOpen: true,
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' as const },
  };

  public getHelmetOptions() {
    return this.helmetOptions;
  }

  public applyHelmetOptions = (req: Request, res: Response, next: NextFunction) => {
    helmet(this.helmetOptions)(req, res, next);
  };

  /** API responses must never be cached by the browser or an intermediary. */
  public applyNoCache = (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
  };
}

export default new SecurityHeaders();
