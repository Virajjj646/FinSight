// Shared benchmark helpers: load the gold set and corpus, validate spans,
// ingest into a throwaway tenant, and clean up.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../src/infrastructure/db/index.js';
import { tenants, documents } from '../../src/infrastructure/db/schema.js';
import { extractDocumentText } from '../../src/modules/documents/ingest/extract.js';
import { parseStructure } from '../../src/modules/documents/ingest/structure.js';
import { chunkDocument } from '../../src/modules/documents/ingest/chunk.js';
import { getTokenCounter } from '../../src/modules/documents/ingest/model.js';
import { embedTexts } from '../../src/modules/documents/ingest/embed.js';
import { writeChunks } from '../../src/modules/documents/ingest/write.js';

export const norm = (s) =>
  String(s ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();

export const pct = (x) => `${(x * 100).toFixed(1)}%`;

export const quantile = (xs, q) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

export async function loadGold(path) {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

// Returns { key: { path, buffer, pages, text } } with text normalized for span checks.
export async function loadCorpus(path) {
  const corpus = JSON.parse(await readFile(path, 'utf8'));
  const extracted = {};
  for (const [key, docPath] of Object.entries(corpus.documents)) {
    const buffer = await readFile(docPath);
    const pages = await extractDocumentText(buffer);
    extracted[key] = {
      path: docPath,
      buffer,
      pages,
      text: norm(pages.map((p) => p.text).join('\n')),
    };
  }
  return extracted;
}

export function validateSpans(gold, extracted) {
  const problems = [];
  for (const q of gold) {
    for (const a of q.answers) {
      if (!extracted[a.doc]) problems.push(`${q.id}: unknown doc "${a.doc}"`);
      else if (!extracted[a.doc].text.includes(norm(a.span))) {
        problems.push(`${q.id}: span not found in ${a.doc}: "${a.span}"`);
      }
    }
  }
  return problems;
}

export async function createBenchTenant() {
  const [tenant] = await db
    .insert(tenants)
    .values({ name: `bench-${randomUUID()}` })
    .returning();
  return tenant.id;
}

// Same steps as the worker (structure -> chunk -> embed -> writeChunks),
// without the upload, queue and file storage.
export async function ingestCorpus(tenantId, extracted) {
  const countTokens = await getTokenCounter();
  const docIds = {};
  const chunkCounts = {};

  for (const [key, { buffer, pages, path }] of Object.entries(extracted)) {
    const title = basename(path);
    const [doc] = await db
      .insert(documents)
      .values({
        tenantId,
        title,
        status: 'processing',
        contentSha256: createHash('sha256').update(buffer).digest('hex'),
      })
      .returning({ id: documents.id });

    const chunks = chunkDocument(parseStructure(pages), {
      countTokens,
      fallbackTitle: title.replace(/\.pdf$/i, ''),
    });
    const vectors = await embedTexts(chunks.map((c) => c.content));
    const written = await writeChunks({
      documentId: doc.id,
      tenantId,
      pageCount: pages.length,
      chunks,
      vectors,
    });
    if (!written) throw new Error(`could not write chunks for ${title}`);

    docIds[key] = doc.id;
    chunkCounts[key] = chunks.length;
  }

  const docKeyById = Object.fromEntries(Object.entries(docIds).map(([k, id]) => [id, k]));
  return { docIds, docKeyById, chunkCounts };
}

export async function deleteBenchTenant(tenantId) {
  await db.delete(documents).where(eq(documents.tenantId, tenantId)); // chunks cascade
  await db.delete(tenants).where(eq(tenants.id, tenantId));
}
