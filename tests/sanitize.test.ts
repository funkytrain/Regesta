import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The HTML produced by converting a .docx is inserted into the page. A .docx
 * is a file that may come from anywhere -- a download, an email -- so its
 * content is treated as untrusted even though the converter does not emit
 * scripts of its own.
 *
 * A replica of the server function: if it changes there, it must change here.
 */
function sanitizeHtml(html: string): string {
  const PERMITIDAS = new Set([
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'sub', 'sup',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'blockquote', 'hr', 'img',
  ]);

  return html
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?([a-zA-Z0-9]+)((?:\s[^>]*)?)\/?>/g, (tag, name: string, atributos: string) => {
      const n = name.toLowerCase();
      if (!PERMITIDAS.has(n)) return '';
      if (tag.startsWith('</')) return `</${n}>`;
      if (n === 'img') {
        const src = /\ssrc\s*=\s*"(data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+)"/i.exec(atributos);
        return src ? `<img src="${src[1]}" alt="">` : '';
      }
      return `<${n}>`;
    });
}

describe('limpieza del HTML convertido', () => {
  test('conserva la estructura que da sentido al document', () => {
    const input = '<p>Visita al <strong>Archivo de Orihuela</strong></p><ul><li>QL 1566-1583</li></ul>';
    assert.equal(sanitizeHtml(input), input);
  });

  test('conserva las tablas, que son lo que llevan los planes de visita', () => {
    const input = '<table><tr><th>Libro</th><td>QL 1566</td></tr></table>';
    assert.equal(sanitizeHtml(input), input);
  });

  test('elimina los guiones con su contenido', () => {
    const output = sanitizeHtml('<p>Before</p><script>alert(1)</script><p>After</p>');
    assert.equal(output, '<p>Before</p><p>After</p>');
    assert.ok(!output.includes('alert'));
  });

  test('elimina los marcos incrustados', () => {
    assert.equal(sanitizeHtml('<iframe src="http://ejemplo"></iframe><p>Texto</p>'), '<p>Texto</p>');
  });

  test('quita los manejadores de events de las tags permitidas', () => {
    const output = sanitizeHtml('<p onclick="algo()">Texto</p>');
    assert.equal(output, '<p>Texto</p>');
    assert.ok(!output.includes('onclick'));
  });

  test('quita los enlaces, que en un document del archivo no aportan', () => {
    // They are not on the allowed list: their content is kept, the tag is
    // not.
    assert.equal(sanitizeHtml('<p>See <a href="javascript:something()">here</a></p>'), '<p>See here</p>');
  });

  test('keeps embedded images as inline data', () => {
    const input = '<img src="data:image/png;base64,iVBORw0KGgo=" />';
    assert.equal(sanitizeHtml(input), '<img src="data:image/png;base64,iVBORw0KGgo=" alt="">');
  });

  test('descarta una imagen que apunte a un servidor externo', () => {
    // An external address would leak to that server the fact that the
    // document is being read.
    assert.equal(sanitizeHtml('<img src="https://rastreador.example/pixel.png">'), '');
  });

  test('descarta una imagen cuyo origen no sea una imagen', () => {
    assert.equal(sanitizeHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">'), '');
  });
});
