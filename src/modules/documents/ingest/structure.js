const SECTION_RE = /^(\d{1,2})\.\s+(\S.*)$/;
const CLAUSE_RE = /^(\d{1,2})\.(\d{1,2})\.?\s+\S/;

export function toLines(pages) {
  const lines = [];
  for (const { pageNumber, text } of pages) {
    for (const raw of text.split('\n')) {
      const t = raw.trim();
      if (t) lines.push({ text: t, page: pageNumber });
    }
  }
  return lines;
}

function looksLikeSectionTitle(title) {
  return (
    title.length <= 80 &&
    /^[A-Z]/.test(title) &&
    !/[.,;:]$/.test(title) &&
    title.split(/\s+/).length <= 8
  );
}

export function parseStructure(pages) {
  const lines = toLines(pages);

  let title = null;
  if (lines.length && !SECTION_RE.test(lines[0].text)) {
    title = lines.shift().text;
  }

  const preamble = { number: 0, heading: 'Preamble', lastClause: 0, blocks: [] };
  const sections = [preamble];
  let section = preamble;
  let block = { id: null, lines: [] };
  preamble.blocks.push(block);

  for (const line of lines) {
    const s = SECTION_RE.exec(line.text);
    if (s && Number(s[1]) === section.number + 1 && looksLikeSectionTitle(s[2])) {
      section = { number: Number(s[1]), heading: line.text, lastClause: 0, blocks: [] };
      block = { id: null, lines: [] };
      section.blocks.push(block);
      sections.push(section);
      continue;
    }

    const c = CLAUSE_RE.exec(line.text);
    if (c && Number(c[1]) === section.number && Number(c[2]) === section.lastClause + 1) {
      section.lastClause = Number(c[2]);
      block = { id: `${c[1]}.${c[2]}`, lines: [line] };
      section.blocks.push(block);
      continue;
    }

    block.lines.push(line);
  }

  return {
    title,
    sections: sections
      .map(({ number, heading, blocks }) => ({
        number,
        heading,
        blocks: blocks.filter((b) => b.lines.length > 0),
      }))
      .filter((sec) => sec.blocks.length > 0),
  };
}