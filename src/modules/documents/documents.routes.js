import { Router } from 'express';
import { uploadPdf } from './document.upload.js';
import { uploadDocument, getDocumentsById } from './document.controller.js';
import { authenticate } from '../../middleware/authenticate.js';

const router = Router();

router.use(authenticate);

router.post('/', uploadPdf, uploadDocument);
router.get('/:id', getDocumentsById);

export default router;