import { readFile } from "node:fs/promises";
import { extractDocumentText } from "../src/modules/documents/ingest/extract.js";

const filePath = process.argv[2];
if (!filePath) {
    console.error("Usage: node scripts/extract-pdf.js <path-to-pdf>");
    process.exit(1);
}

const pages = await extractDocumentText(await readFile(filePath));

for (const p of pages) {
    console.log(`\n===== page ${p.pageNumber} (${p.text.length} chars) =====\n${p.text}`);
}