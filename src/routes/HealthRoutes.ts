import { Router } from 'express';
import HealthController from '../controllers/HealthController';

const router = Router();

router.get('/live', HealthController.live);
router.get('/ready', HealthController.ready);

export { router as HealthRoutes };
