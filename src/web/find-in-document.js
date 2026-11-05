/**
 * Search inside the open document.
 *
 * The results list knows where the searched word is and shows it in the
 * preview, but on opening the document that position was lost and had to be
 * found again by eye. This module recovers it: it highlights every match,
 * lets you step through them and scrolls the view to the first.
 *
 * There are two distinct cases. In text and Word files the content is made of
 * document nodes and matches are marked by wrapping them. In a PDF the
 * content is painted on a canvas, so PDF.js is asked for the position of each
 * word and a box is drawn on top.
 */

/** Normalises for comparison: no diacritics, lowercase. */
function normalise(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/* ---------- Text and Word: marking over the nodes ---------- */

/**
 * Wraps each occurrence of the term inside an element in <mark>.
 * Returns the marks created, in the order they appear.
 */
export function markInNodes(container, term) {
  clearMarks(container);
  if (!term) return [];

  const needle = normalise(term);
  if (!needle) return [];

  // Text nodes are collected first: modifying them while walking the tree
  // would invalidate the walk.
  const nodes = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue.trim()) nodes.push(n);
  }

  const marks = [];
  for (const node of nodes) {
    const text = node.nodeValue;
    const flat = normalise(text);

    let from = 0;
    let found = flat.indexOf(needle, from);
    if (found === -1) continue;

    const fragment = document.createDocumentFragment();
    let cursor = 0;

    while (found !== -1) {
      if (found > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, found)));
      }
      const mark = document.createElement('mark');
      // Sliced from the original text, not the normalised one, so the accents
      // and capitals stay exactly as they are in the document.
      mark.textContent = text.slice(found, found + needle.length);
      fragment.appendChild(mark);
      marks.push(mark);

      cursor = found + needle.length;
      from = cursor;
      found = flat.indexOf(needle, from);
    }

    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }
    node.parentNode.replaceChild(fragment, node);
  }

  return marks;
}

/** Undoes the marking and rejoins the split text nodes. */
export function clearMarks(container) {
  for (const mark of container.querySelectorAll('mark')) {
    mark.replaceWith(document.createTextNode(mark.textContent));
  }
  container.normalize();
}

/* ---------- PDF: boxes over the canvas ---------- */

/**
 * Searches for the term on an already rendered page and places a box over
 * each occurrence.
 *
 * PDF.js delivers the text fragments with their position in the PDF
 * coordinate system; they have to be carried over to the canvas one using the
 * same viewport the page was rendered with.
 */
export async function markOnPage(pdf, pageNumber, sheet, term, cssScale) {
  for (const old of sheet.querySelectorAll('.pdf-mark')) old.remove();
  if (!term) return [];

  const needle = normalise(term);
  if (!needle) return [];

  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: cssScale });

  const marks = [];

  for (const chunk of content.items) {
    if (!('str' in chunk) || !chunk.str) continue;
    const flat = normalise(chunk.str);
    if (!flat.includes(needle)) continue;

    // The fragment matrix composed with the viewport one: it carries the PDF
    // coordinates over to those of the rendered page.
    const m = compose(viewport.transform, chunk.transform);

    // In the composed matrix, m[4] and m[5] are the corner of the fragment
    // and hypot(m[2], m[3]) its line height.
    const left = m[4];
    const bottom = m[5];
    const height = Math.hypot(m[2], m[3]);

    // The width comes in PDF units: it needs the same scale as the rest of
    // the page.
    const totalWidth = chunk.width * cssScale;
    const perCharacter = totalWidth / Math.max(1, chunk.str.length);

    let from = 0;
    let pos = flat.indexOf(needle, from);
    while (pos !== -1) {
      const mark = document.createElement('div');
      mark.className = 'pdf-mark';
      mark.style.left = `${left + pos * perCharacter}px`;
      // The PDF vertical origin sits at the baseline; the canvas one at the
      // top, so the line height has to be subtracted.
      mark.style.top = `${bottom - height}px`;
      mark.style.width = `${needle.length * perCharacter}px`;
      mark.style.height = `${height}px`;
      sheet.appendChild(mark);
      marks.push(mark);

      from = pos + needle.length;
      pos = flat.indexOf(needle, from);
    }
  }

  return marks;
}

/** Multiplies two PDF transformation matrices. */
function compose(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * Works out which pages of a PDF the term appears on, without rendering them.
 * This is what allows jumping straight to the first, even if it is page 20.
 */
export async function pagesWithTerm(pdf, term) {
  const needle = normalise(term);
  if (!needle) return [];

  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    const text = normalise(content.items.map((i) => ('str' in i ? i.str : '')).join(' '));
    if (text.includes(needle)) pages.push(n);
  }
  return pages;
}
