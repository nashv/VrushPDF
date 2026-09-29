/**
 * PDF printing pipeline.
 *
 * Dispatches to native system printing via Tauri when available, falling back
 * to a high-resolution print iframe in browser environments.
 */
import { printPdf as tauriPrintPdf } from "$lib/tauri/files";
import { loadDocument, pdfjs } from "./pdfjs";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function printPdf(bytes: Uint8Array, docTitle = "Document"): Promise<void> {
  try {
    await tauriPrintPdf(bytes, docTitle);
    return;
  } catch {
    // If not running in Tauri (e.g. browser test), fall back to print iframe
  }

  const loaded = await loadDocument(bytes);
  const doc = loaded.doc;
  const pageUrls: { url: string; width: number; height: number }[] = [];

  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const baseViewport = page.getViewport({ scale: 1 });
      // 2x scale / 150-200 DPI for sharp print rendering
      const printScale = 2.0;
      const viewport = page.getViewport({ scale: printScale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));

      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("could not acquire 2D canvas context for printing");

      await page.render({
        canvas,
        viewport,
        background: "#ffffff",
        annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE,
      }).promise;

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (blob) {
        pageUrls.push({
          url: URL.createObjectURL(blob),
          width: baseViewport.width,
          height: baseViewport.height,
        });
      }
    }

    if (pageUrls.length === 0) return;

    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.setAttribute("aria-hidden", "true");
    document.body.appendChild(iframe);

    const cleanup = () => {
      for (const p of pageUrls) {
        URL.revokeObjectURL(p.url);
      }
      iframe.remove();
      doc.loadingTask.destroy().catch(() => {});
    };

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(docTitle)}</title>
  <style>
    @page {
      margin: 0;
      size: auto;
    }
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      width: 100%;
    }
    .page-wrap {
      page-break-after: always;
      break-after: page;
      page-break-inside: avoid;
      break-inside: avoid;
      width: 100vw;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    .page-wrap:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    img {
      max-width: 100%;
      max-height: 100%;
      width: auto;
      height: auto;
      object-fit: contain;
      display: block;
    }
  </style>
</head>
<body>
  ${pageUrls.map((p) => `<div class="page-wrap"><img src="${p.url}" /></div>`).join("")}
</body>
</html>`;

    const docFrame = iframe.contentWindow?.document;
    if (!docFrame) {
      cleanup();
      return;
    }

    docFrame.open();
    docFrame.write(html);
    docFrame.close();

    // Wait for images to load inside the iframe
    await new Promise<void>((resolve) => {
      let loadedImages = 0;
      const imgs = docFrame.querySelectorAll("img");
      if (imgs.length === 0) {
        resolve();
        return;
      }
      const onImgLoad = () => {
        loadedImages++;
        if (loadedImages >= imgs.length) resolve();
      };
      imgs.forEach((img) => {
        if (img.complete) {
          onImgLoad();
        } else {
          img.onload = onImgLoad;
          img.onerror = onImgLoad;
        }
      });
      setTimeout(resolve, 500);
    });

    const frameWindow = iframe.contentWindow;
    if (frameWindow) {
      frameWindow.focus();
      frameWindow.print();
    }

    // Schedule cleanup after the print dialog interaction
    setTimeout(cleanup, 30000);
  } catch (err) {
    for (const p of pageUrls) {
      URL.revokeObjectURL(p.url);
    }
    doc.loadingTask.destroy().catch(() => {});
    throw err;
  }
}
