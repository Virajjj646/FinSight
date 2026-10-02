import { Router } from 'express';
import { uploadPdf } from './document.upload.js';
import { uploadDocument, getDocumentsById } from './document.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { env } from '../../config/env.js';

const router = Router();

// Runs before multer, so rejected uploads are never buffered.
const uploadLimiter = rateLimit({
    name: 'upload',
    limit: env.RATE_LIMIT_UPLOAD_PER_HOUR,
    windowSec: 60 * 60,
    key: (req) => req.auth.tenantId,
});

router.use(authenticate);

router.post('/', uploadLimiter, uploadPdf, uploadDocument);
router.get('/:id', getDocumentsById);

export default router;
