import { createRequire } from "node:module";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const require = createRequire(import.meta.url);
const STANDARD_FONTS_DIR =
     path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts")
        .replaceAll("\\", "/") + "/";

export class UnextractableDocumentError extends Error {
    constructor(message) {
        super(message);
        this.name = "UnextractableDocumentError";
    }
}

const MIN_CHARS_PER_PAGE = 20;
const MAX_EMPTY_PAGE_RATIO = 0.3;
const PAGE_NUMBER_LINE = /^(page\s+)?\d+(\s+of\s+\d+)?$/i;

export async function extractDocumentText(buffer) {
    const rawPages = await extractPages(buffer);
    const pages = stripBoilerplate(
        rawPages.map((p) => ({ ...p, text: normalizeText(p.text) })),
    );
    assertExtractable(pages);
    return pages;
}

async function extractPages(buffer) {
    const loadingTask = getDocument({
        data: new Uint8Array(buffer),
        isEvalSupported: false,
        disableFontFace: true,
        standardFontDataUrl: STANDARD_FONTS_DIR,
    });
    let pdf;
    try {
        pdf = await loadingTask.promise;
    } catch (error) {
        throw new UnextractableDocumentError(`Cannot open PDF: ${error.name}`);
    }

    try {
        const pages = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
            const page = await pdf.getPage(pageNumber);
            const content = await page.getTextContent();
            const text = itemsToText(content.items);
            pages.push({ pageNumber, text });
            page.cleanup();
        }
        return pages;
    } finally {
        await loadingTask.destroy();
    }
}

export function normalizeText(text) {
    return text
        .normalize("NFKC")
        .replace(/([a-z])-\n([a-z])/g, "$1$2")
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export function stripBoilerplate(pages) {
    const repeated = new Set();
    if (pages.length >= 3) {
        const counts = new Map();
        for (const { text } of pages) {
            const lines = text.split("\n").filter(Boolean);
            const edges = new Set([...lines.slice(0, 2), ...lines.slice(-2)]);
            for (const line of edges) counts.set(line, (counts.get(line) ?? 0) + 1);
        }
        const threshold = Math.ceil(pages.length * 0.5);
        for (const [line, n] of counts) if (n >= threshold) repeated.add(line);
    }
    return pages.map((p) => ({
        ...p,
        text: p.text
            .split("\n")
            .filter((line) => !repeated.has(line) && !PAGE_NUMBER_LINE.test(line.trim()))
            .join("\n")
            .trim(),
    }));
}

function assertExtractable(pages) {
    if (pages.length === 0) throw new UnextractableDocumentError("PDF has no pages");
    const empty = pages.filter((p) => p.text.length < MIN_CHARS_PER_PAGE).length;
    if (empty / pages.length > MAX_EMPTY_PAGE_RATIO) {
        throw new UnextractableDocumentError(
            `${empty}/${pages.length} pages have no extractable text (scanned? OCR not supported yet)`,
        );
    }
}

// pdf.js gives positioned text fragments. Some word gaps exist only as distance,
// so insert a space when the next fragment starts visibly after the previous one ends.
function itemsToText(items) {
    let text = "";
    let prevEnd = null;

    for (const item of items) {
        if (!("str" in item)) continue;

        const x = item.transform[4];
        const fontSize = Math.hypot(item.transform[2], item.transform[3]) || 10;
        const gap = prevEnd === null ? 0 : x - prevEnd;

        if (gap > fontSize * 0.1 && !/\s$/.test(text) && !/^\s/.test(item.str)) text += " ";
        text += item.str;

        if (item.hasEOL) {
            text += "\n";
            prevEnd = null;
        } else {
            prevEnd = x + item.width;
        }
    }
    return text;
}