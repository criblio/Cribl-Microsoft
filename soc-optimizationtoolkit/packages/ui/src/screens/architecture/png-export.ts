/**
 * png-export - rasterize the exported SVG to PNG bytes via an offscreen
 * canvas (2026-07-29, user choice: SVG + PNG downloads). Thin DOM glue by
 * nature (Image + canvas), so it is NOT unit-tested - the pure SVG exporter
 * is; failures reject and the caller surfaces them in the export note.
 */

/** Render an SVG document string to PNG bytes at the given scale factor. */
export async function svgToPngBytes(svg: string, scale = 2): Promise<Uint8Array> {
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("could not rasterize the SVG"));
      img.src = url;
    });
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("2D canvas is unavailable in this browser");
    }
    context.drawImage(image, 0, 0, width, height);
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result === null) {
          reject(new Error("PNG encoding failed"));
        } else {
          resolve(result);
        }
      }, "image/png");
    });
    return new Uint8Array(await pngBlob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}
