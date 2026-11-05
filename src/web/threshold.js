/**
 * Adaptive thresholding (Sauvola) for reading manuscripts.
 *
 * A global threshold applies the same cut to the whole image, so in an
 * archive photograph with half the page in shadow no single value works: the
 * one that rescues the dark area burns out the light one. Sauvola computes a
 * cut of its own for each pixel from the mean and standard deviation of its
 * neighbourhood, so each area is binarised according to its own lighting.
 *
 *     t(x,y) = m(x,y) * [ 1 + k * ( s(x,y)/R - 1 ) ]
 *
 * where m is the local mean, s the local standard deviation, R its maximum
 * range (128 in 8 bits) and k controls how much faint ink is kept.
 *
 * To make it instant over 2000 px images, integral images are used: the
 * accumulated sum and sum of squares give the mean and variance of any
 * window with four reads, without walking it.
 */

/**
 * @param {ImageData} image
 * @param {{window?: number, k?: number}} options
 *   window: side of the neighbourhood in pixels. It must be larger than the
 *           stroke thickness and smaller than the scale at which the lighting
 *           changes.
 *   k: from 0.1 to 0.5. Lower keeps more faint strokes, at the cost of noise.
 * @returns {ImageData} the same image, binarised.
 */
export function sauvola(image, { window = 25, k = 0.28 } = {}) {
  const { width: width, height: height, data } = image;
  const n = width * height;

  // 1. Luminance in greyscale (Rec. 601 perceptual coefficients).
  const grey = new Float64Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    grey[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  // 2. Integral images: accumulated sum and sum of squares. An extra row and
  //    column of zeros avoids having to check the edges.
  const widthI = width + 1;
  const sum = new Float64Array(widthI * (height + 1));
  const sum2 = new Float64Array(widthI * (height + 1));

  for (let y = 0; y < height; y++) {
    let filaSuma = 0;
    let filaSuma2 = 0;
    for (let x = 0; x < width; x++) {
      const v = grey[y * width + x];
      filaSuma += v;
      filaSuma2 += v * v;
      const i = (y + 1) * widthI + (x + 1);
      sum[i] = sum[i - widthI] + filaSuma;
      sum2[i] = sum2[i - widthI] + filaSuma2;
    }
  }

  // 3. Per-pixel threshold.
  const radius = Math.max(1, Math.floor(window / 2));
  const R = 128; // maximum range of the standard deviation in 8 bits

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);

    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);

      const area = (x1 - x0 + 1) * (y1 - y0 + 1);

      // The four corners of the window in the integral image.
      const a = y0 * widthI + x0;
      const b = y0 * widthI + (x1 + 1);
      const c = (y1 + 1) * widthI + x0;
      const d = (y1 + 1) * widthI + (x1 + 1);

      const total = sum[d] - sum[b] - sum[c] + sum[a];
      const total2 = sum2[d] - sum2[b] - sum2[c] + sum2[a];

      const mean = total / area;
      // The variance can come out slightly negative from rounding error.
      const variance = Math.max(0, total2 / area - mean * mean);
      const stddev = Math.sqrt(variance);

      const threshold = mean * (1 + k * (stddev / R - 1));

      const i = y * width + x;
      const value = grey[i] > threshold ? 255 : 0;
      const p = i * 4;
      data[p] = value;
      data[p + 1] = value;
      data[p + 2] = value;
      // The alpha channel is left as it was.
    }
  }

  return image;
}

/**
 * Applies Sauvola to an already loaded image and returns the result as a data
 * URL, ready to assign to the `src` of an image element.
 *
 * The image is scaled down if very large: above around 2400 px the
 * computation starts to show and the result gains no legibility, because the
 * stroke is already resolved at that resolution.
 */
export function binarizeImage(img, options = {}) {
  const maxSide = 2400;
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.round(img.naturalWidth * scale);
  const height = Math.round(img.naturalHeight * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);

  const pixels = ctx.getImageData(0, 0, width, height);
  // The window scales with the image so it always covers a stretch of the
  // folio, not a fixed number of pixels.
  const window = Math.max(15, Math.round((Math.min(width, height) / 1000) * 25));
  ctx.putImageData(sauvola(pixels, { window, ...options }), 0, 0);

  return canvas.toDataURL('image/png');
}
