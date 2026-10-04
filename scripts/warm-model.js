// Build-time download of the embedding model and tokenizer into the
// transformers cache. Must not import src/config/env.js (no app env at build).
import { pipeline } from '@huggingface/transformers';
import { EMBEDDING_MODEL, getTokenizer } from '../src/modules/documents/ingest/model.js';

// dtype must match src/modules/documents/ingest/embed.js.
await pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'fp32' });
await getTokenizer();

console.log(`Warmed ${EMBEDDING_MODEL} (fp32) and its tokenizer`);
