import { Router } from 'express';
import { HealthRoutes } from '../routes/HealthRoutes';
import { SystemRoutes } from '../routes/SystemRoutes';

/**
 * Every route group mounts under the configured apiPrefix (/api/v1).
 * Handlers migrating out of spx-ui's Next API routes get added here.
 */
class AppRoutesProvider {
  public get routes(): Router {
    const router = Router();
    router.use('/health', HealthRoutes);
    router.use('/system', SystemRoutes);
    return router;
  }
}

export const AppRoutes = new AppRoutesProvider();
