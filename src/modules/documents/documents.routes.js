import { Router } from 'express';
import { uploadPdf } from './document.upload.js';
import {
    uploadDocument,
    getDocumentsById,
    getDocumentFileController,
    listDocumentsController,
    retryDocumentController,
    deleteDocumentController,
} from './document.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
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
router.get('/', listDocumentsController);
router.get('/:id', getDocumentsById);
router.get('/:id/file', getDocumentFileController);
router.post('/:id/retry', retryDocumentController);
router.delete('/:id', requireRole('OWNER', 'ADMIN'), deleteDocumentController);

export default router;
