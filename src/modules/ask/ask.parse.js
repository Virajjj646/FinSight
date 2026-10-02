import { INSUFFICIENT_CONTEXT } from './ask.prompt.js';

// Matches [1], [12] and lists like [1, 3].
const MARKER = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

export function parseAnswer(text, used) {
  const raw = String(text ?? '').trim();
  if (!raw) return { abstained: true, reason: 'empty_answer' };
  if (raw.includes(INSUFFICIENT_CONTEXT)) {
    return { abstained: true, reason: 'model_insufficient_context' };
  }

  const order = [];
  let invalidMarkers = 0;

  const answer = raw
    .replace(MARKER, (_, list) => {
      const valid = [];
      for (const n of list.split(',').map((s) => Number(s.trim()))) {
        if (Number.isInteger(n) && n >= 1 && n <= used.length) {
          valid.push(n);
          if (!order.includes(n)) order.push(n);
        } else {
          invalidMarkers++;
        }
      }
      return valid.map((n) => `[${n}]`).join('');
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:])/g, '$1')
    .trim();

  if (order.length === 0) {
    return { abstained: true, reason: 'no_valid_citations', invalidMarkers };
  }

  const citations = order.map((n) => {
    const c = used[n - 1];
    return {
      marker: n,
      chunkId: c.chunkId,
      documentId: c.documentId,
      documentTitle: c.documentTitle,
      section: c.section,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
    };
  });

  return { abstained: false, answer, citations, invalidMarkers };
}
