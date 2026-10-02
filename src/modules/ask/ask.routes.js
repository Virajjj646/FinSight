import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { postAsk } from './ask.controller.js';

const router = Router();

router.use(authenticate);
router.post('/',postAsk);

export default router;