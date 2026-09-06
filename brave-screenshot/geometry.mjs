export function positions(size, viewport) {
  if (!Number.isFinite(size) || !Number.isFinite(viewport) || size <= 0 || viewport <= 0) throw new Error('Invalid page dimensions.');
  const result = [0];
  while (result.at(-1) + viewport < size) result.push(Math.min(result.at(-1) + viewport, size - viewport));
  return result;
}

export function outputSize(width, height, scale) {
  const w = Math.round(width * scale), h = Math.round(height * scale);
  if (!(w > 0 && h > 0) || w > 32767 || h > 32767 || w * h > 64000000) {
    throw new Error('This page is too large for one image (64 megapixels / 32,767 pixels per side). Zoom out or capture a section.');
  }
  return { width: w, height: h };
}

export function cropRect(rect, scale, width, height) {
  const x = Math.max(0, Math.round(rect.x * scale));
  const y = Math.max(0, Math.round(rect.y * scale));
  const right = Math.min(width, Math.round((rect.x + rect.width) * scale));
  const bottom = Math.min(height, Math.round((rect.y + rect.height) * scale));
  if (right <= x || bottom <= y) throw new Error('Select a larger area.');
  return { x, y, width: right - x, height: bottom - y };
}
