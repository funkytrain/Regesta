/**
 * Extraction of the text inside documents, so they can be searched.
 *
 * An archive typically holds notarial records, censuses, population rolls and
 * articles in PDF, as well as transcriptions and visit plans. Without this,
 * searching for a surname only looks at file names, and everything written
 * inside those documents stays out of reach.
 *
 * Only text that is already digital is extracted: a scanned PDF with no text
 * layer returns nothing, and that is recorded so it can be told apart from a
 * failure.
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export interface ExtractedText {
  text: string;
  pages: number | null;
  /** A scanned PDF with no text layer: not an error, it simply has none. */
  noTextLayer: boolean;
}

/** Server-side PDF.js. Loaded once, and only if needed. */
let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs') | null = null;

async function loadPdfjs() {
  pdfjs ??= await import(
    pathToFileURL(resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href
  );
  return pdfjs!;
}

/** Cap per document. Text beyond this adds nothing to the search. */
const CHARACTER_CAP = 400_000;

export async function extractFromPdf(path: string): Promise<ExtractedText> {
  const lib = await loadPdfjs();
  const data = new Uint8Array(await readFile(path));

  const doc = await lib.getDocument({
    data,
    // An archive holds PDFs downloaded from many places: nothing they carry
    // inside is executed.
    isEvalSupported: false,
    // Without this, every PDF using non-embedded standard fonts warns on the
    // console. Under Node a disk path with a trailing slash is accepted.
    standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/',
  }).promise;

  const chunks: string[] = [];
  let total = 0;

  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    const line = content.items
      .map((i) => ('str' in i ? i.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (line) {
      chunks.push(line);
      total += line.length;
      if (total > CHARACTER_CAP) break;
    }
  }

  await doc.destroy();

  const text = chunks.join('\n').slice(0, CHARACTER_CAP);
  return {
    text,
    pages: doc.numPages,
    // A scan with no text layer returns a few stray characters or none at
    // all; it is flagged so they can be counted and not mistaken for
    // failures.
    noTextLayer: text.replace(/\s/g, '').length < 20,
  };
}

export async function extractFromDocx(path: string): Promise<ExtractedText> {
  const mammoth = await import('mammoth');
  const r = await mammoth.extractRawText({ path });
  const text = r.value.replace(/\s+/g, ' ').trim().slice(0, CHARACTER_CAP);
  return { text, pages: null, noTextLayer: text.length < 20 };
}

export async function extractFromPlainText(path: string): Promise<ExtractedText> {
  const raw = await readFile(path);
  // Transcriptions are often written on Windows over many years: some in
  // UTF-8 and others in Latin-1.
  let text: string;
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    text = new TextDecoder('utf-8').decode(raw.subarray(3));
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      text = new TextDecoder('windows-1252').decode(raw);
    }
  }
  text = text.replace(/\s+/g, ' ').trim().slice(0, CHARACTER_CAP);
  return { text, pages: null, noTextLayer: text.length < 20 };
}

/** Picks the extractor by extension. Returns null if there is none. */
export async function extractText(path: string, extension: string): Promise<ExtractedText | null> {
  switch (extension.toLowerCase()) {
    case '.pdf':
      return extractFromPdf(path);
    case '.docx':
      return extractFromDocx(path);
    case '.txt':
    case '.md':
      return extractFromPlainText(path);
    default:
      return null;
  }
}
