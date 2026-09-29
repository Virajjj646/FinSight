import { z } from 'zod';

export const createDocumentBody = z.object({
    title: z.string().trim().min(1).max(200).optional(),
});

export const documentIdParams = z.object({
    id: z.uuid(),
});