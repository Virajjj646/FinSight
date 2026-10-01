import { pipeline } from '@huggingface/transformers';
import { EMBEDDING_MODEL } from './model.js';

export const EMBEDDING_DIMS = 384;
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

let extractorPromise;

function getExtractor() {
  extractorPromise ??= pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'fp32' }).catch(
    (err) => {
      extractorPromise = undefined;
      throw err;
    },
  );
  return extractorPromise;
}

export async function embedTexts(texts, { batchSize = 16 } = {}) {
  const extractor = await getExtractor();
  const vectors = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const tensor = await extractor(batch, { pooling: 'cls', normalize: true });
    vectors.push(...tensor.tolist());
  }

  for (const [i, v] of vectors.entries()) {
    if (v.length !== EMBEDDING_DIMS) {
      throw new Error(`Embedding ${i} has ${v.length} dims, expected ${EMBEDDING_DIMS}`);
    }
  }
  return vectors;
}

export async function embedQuery(query) {
  const [vector] = await embedTexts([QUERY_PREFIX + query]);
  return vector;
}