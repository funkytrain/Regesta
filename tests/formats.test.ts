import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * An archive mixes images with PDFs, plain-text transcriptions and the odd
 * Word document. Each family needs its own viewer, and the filter has to
 * group by family rather than by individual extension: someone asking for
 * images wants them all, be they .jpg, .jpeg or .png.
 */

const FAMILIAS: Record<string, string[]> = {
  imagen: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tif', '.tiff', '.webp'],
  pdf: ['.pdf'],
  text: ['.txt', '.md'],
  document: ['.doc', '.docx', '.odt', '.rtf'],
};

function familiaDe(extension: string): string {
  for (const [familia, exts] of Object.entries(FAMILIAS)) {
    if (exts.includes(extension.toLowerCase())) return familia;
  }
  return 'other';
}

describe('format families', () => {
  test('all las variantes de imagen caen en la misma familia', () => {
    for (const ext of ['.jpg', '.JPG', '.jpeg', '.png', '.tiff']) {
      assert.equal(familiaDe(ext), 'imagen', `${ext} should be an image`);
    }
  });

  test('transcriptions count as text', () => {
    assert.equal(familiaDe('.txt'), 'text');
  });

  test('PDFs go to their own viewer', () => {
    assert.equal(familiaDe('.pdf'), 'pdf');
  });

  test('an unknown format is not forced into any family', () => {
    assert.equal(familiaDe('.xlsx'), 'other');
    assert.equal(familiaDe('.zip'), 'other');
  });

  test('no extension belongs to two families', () => {
    const seen = new Set<string>();
    for (const exts of Object.values(FAMILIAS)) {
      for (const e of exts) {
        assert.ok(!seen.has(e), `${e} is in two families`);
        seen.add(e);
      }
    }
  });
});

/**
 * Transcriptions tend to be written on Windows over many years: some in
 * UTF-8 and others in Latin-1. Decoding them all as UTF-8 would break the
 * accented characters exactly where they matter most, inside proper names.
 */
function decode(data: Buffer): string {
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(data.subarray(3));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('windows-1252').decode(data);
  }
}

describe('decoding the transcriptions', () => {
  test('lee UTF-8', () => {
    assert.equal(decode(Buffer.from('MARTÍNEZ BERNABÉ', 'utf8')), 'MARTÍNEZ BERNABÉ');
  });

  test('lee UTF-8 con marca de position de bytes, sin dejarla en el text', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('AÑO', 'utf8')]);
    assert.equal(decode(withBom), 'AÑO');
  });

  test('recupera los acentos de un file en Latin-1', () => {
    // 'BURLÓ' saved by an old Windows: the Ó is byte 0xD3.
    const latin1 = Buffer.from([0x42, 0x55, 0x52, 0x4c, 0xd3]);
    assert.equal(decode(latin1), 'BURLÓ');
  });

  test('a Latin-1 accented letter is not lost', () => {
    // 'MIÑANA': the Ñ is byte 0xD1.
    const latin1 = Buffer.from([0x4d, 0x49, 0xd1, 0x41, 0x4e, 0x41]);
    assert.equal(decode(latin1), 'MIÑANA');
  });

  test('unaccented text reads the same in any encoding', () => {
    const simple = Buffer.from('PADRON TERUEL 1841', 'ascii');
    assert.equal(decode(simple), 'PADRON TERUEL 1841');
  });
});
