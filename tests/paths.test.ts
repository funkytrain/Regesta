import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, normalize, sep } from 'node:path';

/**
 * The application serves files from the user's folder and is exposed on the
 * local network. Without this check, a crafted request could read any file
 * on the machine.
 *
 * It tests the same function the API uses, replicated here because it is not
 * exported: if it changes there, this test must change with it.
 */
function insideOf(base: string, candidata: string): string | null {
  const raizAbs = resolve(base);
  const destino = resolve(raizAbs, normalize(candidata));
  if (destino !== raizAbs && !destino.startsWith(raizAbs + sep)) return null;
  return destino;
}

const BASE = resolve('C:/regesta/data/miniaturas');

describe('control de rutas', () => {
  test('acepta una path normal dentro de la folder', () => {
    assert.notEqual(insideOf(BASE, '39/39aa9df3.webp'), null);
  });

  test('rechaza salir con ..', () => {
    assert.equal(insideOf(BASE, '../../../windows/win.ini'), null);
    assert.equal(insideOf(BASE, '..'), null);
  });

  test('rechaza una path absoluta', () => {
    assert.equal(insideOf(BASE, 'C:/windows/win.ini'), null);
  });

  test('rechaza los .. intercalados', () => {
    assert.equal(insideOf(BASE, 'ab/../../../etc/passwd'), null);
  });

  test('a sibling folder with a similar prefix does not get through', () => {
    // 'thumbnails-other' starts the same as 'thumbnails': without comparing
    // against the separator, the prefix alone would pass it.
    assert.equal(insideOf(BASE, '../miniaturas-otras/x.webp'), null);
  });
});
