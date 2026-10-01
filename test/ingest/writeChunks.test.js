// test/documents/writeChunks.test.js
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../src/infrastructure/db/index.js";
import {
    tenants,
    documents,
    documentChunks,
    EMBEDDING_DIMENSIONS,
} from "../../src/infrastructure/db/schema.js";
import { writeChunks } from "../../src/modules/documents/ingest/write.js";
import { closeTestDb } from "../helpers/db.js";

// One-hot unit vectors: valid, normalized, and easy to tell apart
const vec = (hot, dims = EMBEDDING_DIMENSIONS) =>
    Array.from({ length: dims }, (_, j) => (j === hot ? 1 : 0));

const chunk = (ordinal, content) => ({
    ordinal,
    section: "1. Definitions",
    pageStart: 1,
    pageEnd: 1,
    content,
    tokenCount: 5,
});

describe("writeChunks", () => {
    let tenant;

    before(async () => {
        [tenant] = await db
            .insert(tenants)
            .values({ name: `write-chunks-${randomUUID()}` })
            .returning();
    });

    beforeEach(async () => {
        await db.delete(documents).where(eq(documents.tenantId, tenant.id)); // chunks cascade
    });

    after(async () => {
        await db.delete(documents).where(eq(documents.tenantId, tenant.id));
        await db.delete(tenants).where(inArray(tenants.id, [tenant.id]));
        await closeTestDb();
    });

    async function seedDocument(status = "processing") {
        const [doc] = await db
            .insert(documents)
            .values({
                tenantId: tenant.id,
                title: "Test contract",
                contentSha256: randomBytes(32).toString("hex"),
                status,
            })
            .returning();
        return doc;
    }

    const chunksOf = (doc) =>
        db
            .select()
            .from(documentChunks)
            .where(and(eq(documentChunks.documentId, doc.id), eq(documentChunks.tenantId, doc.tenantId)))
            .orderBy(asc(documentChunks.ordinal));

    const docOf = async (doc) =>
        (await db.select().from(documents).where(eq(documents.id, doc.id)))[0];

    const write = (doc, chunks, vectors, pageCount = 1) =>
        writeChunks({ documentId: doc.id, tenantId: doc.tenantId, pageCount, chunks, vectors });

    it("writes chunks with vectors and marks the document ready", async () => {
        const doc = await seedDocument();

        const ok = await write(doc, [chunk(0, "a"), chunk(1, "b")], [vec(0), vec(1)], 3);

        assert.equal(ok, true);
        const rows = await chunksOf(doc);
        assert.deepEqual(rows.map((r) => r.content), ["a", "b"]);
        assert.equal(rows[0].embedding.length, EMBEDDING_DIMENSIONS);
        assert.equal(rows[1].embedding[1], 1); // vectors line up with their chunks
        assert.ok(rows.every((r) => r.embeddingModel)); // model recorded on every row

        const d = await docOf(doc);
        assert.equal(d.status, "ready");
        assert.equal(d.pageCount, 3);
    });

    it("re-ingest replaces old chunks instead of appending", async () => {
        const doc = await seedDocument();
        await write(doc, [chunk(0, "a"), chunk(1, "b")], [vec(0), vec(1)]);
        await db.update(documents).set({ status: "processing" }).where(eq(documents.id, doc.id));

        await write(doc, [chunk(0, "new")], [vec(2)]);

        const rows = await chunksOf(doc);
        assert.deepEqual(rows.map((r) => r.content), ["new"]);
    });

    it("lost claim returns false and leaves existing chunks untouched", async () => {
        const doc = await seedDocument("ready");
        await db.insert(documentChunks).values({
            ...chunk(0, "existing"),
            tenantId: doc.tenantId,
            documentId: doc.id,
            embedding: vec(0),
            embeddingModel: "Xenova/bge-small-en-v1.5",
        });

        const ok = await write(doc, [chunk(0, "intruder")], [vec(1)]);

        assert.equal(ok, false);
        assert.deepEqual((await chunksOf(doc)).map((r) => r.content), ["existing"]);
        assert.equal((await docOf(doc)).status, "ready");
    });

    it("failure mid-transaction rolls back: old chunks survive, status unchanged", async () => {
        const doc = await seedDocument();
        await write(doc, [chunk(0, "old")], [vec(0)]);
        await db.update(documents).set({ status: "processing" }).where(eq(documents.id, doc.id));

        await assert.rejects(
            write(doc, [chunk(0, "a"), chunk(1, "b")], [vec(0), vec(0, EMBEDDING_DIMENSIONS - 1)]), // bad dims
        );

        // If the DELETE had committed on its own, "old" would be gone
        assert.deepEqual((await chunksOf(doc)).map((r) => r.content), ["old"]);
        assert.equal((await docOf(doc)).status, "processing");
    });
});