import { z } from 'zod';
import { MAX_K } from '../documents/retrieval/retrieve.js';

export const ASK_MAX_QUESTION_LENGTH = 1000;

export const askBody = z.object({
    question: z.string().trim().min(1).max(ASK_MAX_QUESTION_LENGTH),
    k: z.number().int().min(1).max(MAX_K).optional(),
});