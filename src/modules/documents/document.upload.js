import multer from 'multer';
import { MAX_UPLOAD_BYTES } from '../../infrastructure/db/schema.js';
import { AppError } from '../../lib/AppError.js';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 },
}).single('file');

export function uploadPdf(req, res, next){
    upload(req, res, (err) => {
        if(!err) return next();
        if(err instanceof multer.MulterError){
            if(err.code === 'LIMIT_FILE_SIZE'){
                return next(new AppError(413, 'FILLE_TOO_LARGE', 'Max upload size is 10 MB'));
            }
            return next(new AppError(400, 'INVALID_VALID', err.message));
        }
        next(err);
    });
}