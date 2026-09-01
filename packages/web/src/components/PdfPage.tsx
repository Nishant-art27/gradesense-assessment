import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * Renders one PDF page to a canvas at the container's width.
 *
 * The canvas is backed at device pixel ratio so text stays sharp, while its CSS
 * size stays in layout pixels — which is what the annotation overlay measures
 * against. Renders are cancelled on unmount and on re-render, because pdf.js
 * throws if two render tasks touch the same canvas.
 */
export function PdfPage({
  document: pdf,
  pageNumber,
  width,
  onSize,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  onSize?: (size: { width: number; height: number }) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void } | null = null;

    void (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;

      const unscaled = page.getViewport({ scale: 1 });
      const scale = width / unscaled.width;
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);

      const canvas = canvasRef.current;
      if (!canvas) return;

      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      setHeight(viewport.height);
      onSize?.({ width: viewport.width, height: viewport.height });

      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, viewport.width, viewport.height);

      const task = page.render({ canvasContext: context, viewport });
      renderTask = task;
      try {
        await task.promise;
      } catch (error) {
        // A cancelled render is expected during resize; anything else is real.
        const name = (error as { name?: string })?.name;
        if (name !== 'RenderingCancelledException') throw error;
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdf, pageNumber, width, onSize]);

  return <canvas ref={canvasRef} className="pdf-canvas" style={{ height: height || undefined }} />;
}
