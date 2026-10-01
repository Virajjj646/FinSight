import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../../infrastructure/db/index.js';
import { documents, documentChunks } from '../../../infrastructure/db/schema.js';
import { EMBEDDING_MODEL } from './model.js';

class ClaimLostError extends Error {}

// Returns true if written, false if this worker no longer holds the claim.
export async function writeChunks(
  { documentId, tenantId, pageCount, chunks, vectors },
  { database = db } = {},
) {
  if (chunks.length === 0) throw new Error('writeChunks called with no chunks');
  if (chunks.length !== vectors.length) {
    throw new Error(`chunks (${chunks.length}) and vectors (${vectors.length}) differ`);
  }

  try {
    await database.transaction(async (tx) => {
      // Claim check first: also takes the row lock for the rest of the tx.
      const updated = await tx
        .update(documents)
        .set({ status: 'ready', pageCount, updatedAt: sql`now()` })
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.tenantId, tenantId),
            eq(documents.status, 'processing'),
          ),
        )
        .returning({ id: documents.id });

      if (updated.length === 0) throw new ClaimLostError();

      await tx
        .delete(documentChunks)
        .where(
          and(eq(documentChunks.documentId, documentId), eq(documentChunks.tenantId, tenantId)),
        );

      await tx.insert(documentChunks).values(
        chunks.map((c, i) => ({
          tenantId,
          documentId,
          ordinal: c.ordinal,
          section: c.section,
          pageStart: c.pageStart,
          pageEnd: c.pageEnd,
          content: c.content,
          tokenCount: c.tokenCount,
          embedding: vectors[i],
          embeddingModel: EMBEDDING_MODEL,
        })),
      );
    });
    return true;
  } catch (err) {
    if (err instanceof ClaimLostError) return false;
    throw err;
  }
}