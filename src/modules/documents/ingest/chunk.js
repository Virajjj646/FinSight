const SENTENCE_SPLIT = /(?<=[.;:])\s+(?=\S)/;

// Pieces from the same original line (cont: true) rejoin with a space.
function join(pieces) {
  return pieces
    .map((p, i) => (i === 0 ? p.text : (p.cont ? ' ' : '\n') + p.text))
    .join('');
}

function toChunk(prefix, section, pieces, count) {
  const content = prefix + join(pieces);
  const pages = pieces.map((p) => p.page);
  return {
    section,
    pageStart: Math.min(...pages),
    pageEnd: Math.max(...pages),
    content,
    tokenCount: count(content),
  };
}

// Last resort for a single line over the cap: sentences, then words.
function splitToFit(text, prefix, count, cap) {
  const out = [];
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    if (count(prefix + sentence) <= cap) {
      out.push(sentence);
      continue;
    }
    let cur = [];
    for (const word of sentence.split(/\s+/)) {
      if (cur.length && count(prefix + [...cur, word].join(' ')) > cap) {
        out.push(cur.join(' '));
        cur = [];
      }
      cur.push(word);
    }
    if (cur.length) out.push(cur.join(' '));
  }
  return out;
}

function toPieces(lines, prefix, count, cap) {
  const pieces = [];
  for (const { text, page } of lines) {
    if (count(prefix + text) <= cap) {
      pieces.push({ text, page });
    } else {
      splitToFit(text, prefix, count, cap).forEach((t, i) =>
        pieces.push({ text: t, page, cont: i > 0 }),
      );
    }
  }
  return pieces;
}

function overlapTail(win, count, budget) {
  const tail = [];
  let acc = 0;
  for (let i = win.length - 1; i > 0 && acc < budget; i--) {
    tail.unshift(win[i]);
    acc += count(win[i].text);
  }
  return tail;
}

function windows(pieces, prefix, count, { target, cap, overlap }) {
  const out = [];
  let win = [];
  for (const p of pieces) {
    if (win.length && count(prefix + join([...win, p])) > target) {
      out.push(win);
      win = overlapTail(win, count, overlap * target);
      while (win.length && count(prefix + join([...win, p])) > cap) win.shift();
    }
    win.push(p);
  }
  if (win.length) out.push(win);
  return out;
}

export function chunkDocument(
  structure,
  { countTokens, fallbackTitle = 'Untitled document', target = 350, cap = 480, overlap = 0.15 },
) {
  const title = structure.title ?? fallbackTitle;
  const opts = { target, cap, overlap };
  const chunks = [];

  for (const { heading, blocks } of structure.sections) {
    const prefix = `${title} — ${heading}\n\n`;
    let current = [];
    const flush = () => {
      if (current.length) chunks.push(toChunk(prefix, heading, current, countTokens));
      current = [];
    };

    for (const block of blocks) {
      const pieces = block.lines.map(({ text, page }) => ({ text, page }));

      if (countTokens(prefix + join([...current, ...pieces])) <= target) {
        current.push(...pieces);
        continue;
      }
      flush();

      if (countTokens(prefix + join(pieces)) <= cap) {
        current = pieces;
        continue;
      }

      const split = toPieces(block.lines, prefix, countTokens, cap);
      for (const win of windows(split, prefix, countTokens, opts)) {
        chunks.push(toChunk(prefix, heading, win, countTokens));
      }
    }
    flush();
  }

  return chunks.map((c, ordinal) => ({ ordinal, ...c }));
}