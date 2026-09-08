import { Router } from 'express';
import SystemController from '../controllers/SystemController';

const router = Router();

router.get('/config', SystemController.config);
router.get('/about', SystemController.about);

export { router as SystemRoutes };
