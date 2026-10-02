import { z } from 'zod';
import { documentStatus } from '../../infrastructure/db/schema.js';

export const createDocumentBody = z.object({
    title: z.string().trim().min(1).max(200).optional(),
});

export const documentIdParams = z.object({
    id: z.uuid(),
});

export const listDocumentsQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
    status: z.enum(documentStatus.enumValues).optional(),
});
