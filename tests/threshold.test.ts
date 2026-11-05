import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error - browser module in plain JavaScript, no types
import { sauvola } from '../src/web/threshold.js';

/**
 * Sauvola exists to solve one specific case: photographs of folios with half
 * the page in shadow, where a global threshold is useless because any single
 * cut burns out one half or darkens the other.
 *
 * These tests build that situation by hand and check that the text survives
 * in both areas.
 */

/** Builds a synthetic w x h image with one grey value per pixel. */
function lienzo(w: number, h: number, pintar: (x: number, y: number) => number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = pintar(x, y);
      const p = (y * w + x) * 4;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const gris = (img: { width: number; data: Uint8ClampedArray }, x: number, y: number) =>
  img.data[(y * img.width + x) * 4]!;

describe('sauvola - adaptive threshold', () => {
  test('binarises: the output holds only black or white', () => {
    const img = lienzo(60, 60, (x, y) => (x + y) % 256);
    sauvola(img, { window: 15 });
    for (let i = 0; i < img.data.length; i += 4) {
      const v = img.data[i]!;
      assert.ok(v === 0 || v === 255, `value intermedio ${v}`);
    }
  });

  test('keeps the text in both halves under uneven lighting', () => {
    // The real case: left half in shadow (background 70), right half lit
    // (background 220). In both, a stroke 60 points darker than its
    // background.
    const w = 120;
    const h = 60;
    const enSombra = (x: number) => x < w / 2;
    const fonds = (x: number) => (enSombra(x) ? 70 : 220);
    const hayTrazo = (x: number, y: number) => y >= 28 && y <= 31 && x % 20 < 8;

    const img = lienzo(w, h, (x, y) => (hayTrazo(x, y) ? fonds(x) - 60 : fonds(x)));
    sauvola(img, { window: 21, k: 0.2 });

    // A stroke from each half must come out black, and its background
    // white. The points measured are away from x=60, the boundary between
    // the two lighting areas, where the result is legitimately ambiguous:
    // the 21 px window covers pieces of both there.
    assert.equal(gris(img, 2, 29), 0, 'the stroke in the shadowed area was lost');
    assert.equal(gris(img, 65, 29), 0, 'the stroke in the lit area was lost');
    assert.equal(gris(img, 85, 29), 0, 'the stroke on the light background was lost');
    assert.equal(gris(img, 14, 10), 255, 'the shadowed background should be white');
    assert.equal(gris(img, 74, 10), 255, 'the lit background should be white');
  });

  test('a global threshold would fail where this one works', () => {
    // The premise, checked: with the values of the previous test, the stroke
    // in the lit area (160) is LIGHTER than the background of the shadowed
    // area (70). No single cut can separate ink from paper in both.
    const trazoClaro = 220 - 60; // 160
    const fondoOscuro = 70;
    assert.ok(
      trazoClaro > fondoOscuro,
      'si esto deja de cumplirse, la sample ya no representa el problema real',
    );
  });

  test('it does not stall on a single-tone image', () => {
    const img = lienzo(40, 40, () => 128);
    assert.doesNotThrow(() => sauvola(img, { window: 15 }));
  });

  test('it accepts a window larger than the image itself', () => {
    const img = lienzo(10, 10, (x) => x * 25);
    assert.doesNotThrow(() => sauvola(img, { window: 99 }));
  });
});
