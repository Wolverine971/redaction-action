import * as mupdf from "mupdf";

/** Renders one page (1-based) to PNG at a scale, or at a target pixel width. */
export function renderPagePng(bytes: Uint8Array, pageNumber: number, size: number | { width: number } = 1.5): Uint8Array {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const page = doc.loadPage(pageNumber - 1);
    const [x0, , x1] = page.getBounds();
    const scale = typeof size === "number" ? size : size.width / Math.max(1, x1 - x0);
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
    const png = pixmap.asPNG();
    pixmap.destroy();
    page.destroy();
    return png;
  } finally {
    doc.destroy();
  }
}
