import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { env } from '../../config/env.js';
import { postAsk } from './ask.controller.js';

const router = Router();

const askLimiter = rateLimit({
    name: 'ask',
    limit: env.RATE_LIMIT_ASK_PER_MIN,
    windowSec: 60,
    key: (req) => `${req.auth.tenantId}:${req.auth.userId}`,
});

router.use(authenticate);
router.post('/', askLimiter, postAsk);

export default router;
