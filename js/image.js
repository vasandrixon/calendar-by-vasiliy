/**
 * Утиліти для зображень: завантаження, стиснення, мініатюри, кадр з відео.
 * Усе робиться через canvas, результат — Blob (JPEG).
 */
(function () {
  function sourceSize(source) {
    if (source instanceof HTMLVideoElement) return { w: source.videoWidth, h: source.videoHeight };
    if (source instanceof HTMLImageElement) return { w: source.naturalWidth, h: source.naturalHeight };
    return { w: source.width, h: source.height };
  }

  function createCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff'; // фон для прозорих PNG (JPEG не має альфа-каналу)
    ctx.fillRect(0, 0, width, height);
    return { canvas, ctx };
  }

  function toBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Не вдалося обробити зображення'))),
        'image/jpeg',
        quality
      );
    });
  }

  /** Завантажує файл/Blob у <img>. */
  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Не вдалося прочитати зображення'));
      };
      img.src = url;
    });
  }

  /** Зменшує зображення так, щоб довша сторона була ≤ maxSide (не збільшує). */
  function compress(source, maxSide, quality) {
    const { w, h } = sourceSize(source);
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const width = Math.max(1, Math.round(w * scale));
    const height = Math.max(1, Math.round(h * scale));

    const { canvas, ctx } = createCanvas(width, height);
    ctx.drawImage(source, 0, 0, width, height);
    return toBlob(canvas, quality);
  }

  /** Квадратна мініатюра: обрізка по центру + зменшення до size×size. */
  function squareThumb(source, size, quality) {
    const { w, h } = sourceSize(source);
    const side = Math.min(w, h);
    const out = Math.min(size, side);

    const { canvas, ctx } = createCanvas(out, out);
    ctx.drawImage(source, (w - side) / 2, (h - side) / 2, side, side, 0, 0, out, out);
    return toBlob(canvas, quality);
  }

  /** Знімає поточний кадр з <video> у canvas повної роздільності. */
  function frameFromVideo(video) {
    const { w, h } = sourceSize(video);
    if (!w || !h) throw new Error('Камера ще не готова');

    const { canvas, ctx } = createCanvas(w, h);
    ctx.drawImage(video, 0, 0, w, h);
    return canvas;
  }

  window.Daily = window.Daily || {};
  window.Daily.image = { loadImage, compress, squareThumb, frameFromVideo };
})();
