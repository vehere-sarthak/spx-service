import { Router } from 'express';
import { asyncHandler } from '../lib/http';
import AuthSessionRoutes from './AuthSessionRoutes';

const router = Router();

/**
 * Legacy path. /api/v1/auth/session carries the same MFA/TOTP gates, so this
 * stamps action=login onto the body and hands the request straight to that
 * router rather than duplicating the logic.
 */
router.post(
  '/',
  asyncHandler(async (req, reply, next) => {
    req.body = { ...(req.body ?? {}), action: 'login' };
    req.url = '/';
    return AuthSessionRoutes(req, reply, next);
  })
);

export default router;
