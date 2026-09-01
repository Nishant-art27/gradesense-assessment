import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Annotation, Rect } from '@gradesense/shared';
import { PdfPage } from './PdfPage.js';
import { AnnotationOverlay } from './AnnotationOverlay.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * The answer paper with its annotations on top.
 *
 * Pages are stacked rather than paged through, because a teacher scrolling a
 * two-page script is closer to how the paper is actually read, and it keeps the
 * coordinate maths per page trivial: each page owns its own overlay.
 */
export function PaperViewer({
  fileUrl,
  annotations,
  selectedId,
  drawMode,
  onSelect,
  onMoved,
  onDrawn,
}: {
  fileUrl: string;
  annotations: Annotation[];
  selectedId: string | null;
  drawMode: boolean;
  onSelect: (id: string | null) => void;
  onMoved: (id: string, rect: Rect) => void;
  onDrawn: (rect: Rect) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [sizes, setSizes] = useState<Record<number, { width: number; height: number }>>({});

  // Track the container width so pages re-render to fit.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const measure = () => setWidth(Math.max(320, element.clientWidth - 2));
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;

    setPdf(null);
    setError(null);
    setSizes({});

    void (async () => {
      try {
        const task = pdfjs.getDocument({ url: fileUrl });
        loaded = await task.promise;
        if (cancelled) {
          void loaded.destroy();
          return;
        }
        setPdf(loaded);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not open the PDF.');
      }
    })();

    return () => {
      cancelled = true;
      void loaded?.destroy();
    };
  }, [fileUrl]);

  if (error) {
    return <div className="viewer-message error">Could not display the answer paper: {error}</div>;
  }

  return (
    <div className="paper-viewer" ref={containerRef}>
      {!pdf && <div className="viewer-message">Loading the answer paper…</div>}

      {pdf &&
        width > 0 &&
        Array.from({ length: pdf.numPages }, (_, index) => {
          const size = sizes[index];
          return (
            <div className="pdf-page-wrapper" key={index}>
              <div className="pdf-page-number">Page {index + 1}</div>
              <div className="pdf-page-stack">
                <PdfPage
                  document={pdf}
                  pageNumber={index + 1}
                  width={width}
                  onSize={(next) =>
                    setSizes((current) =>
                      current[index]?.height === next.height ? current : { ...current, [index]: next },
                    )
                  }
                />
                {size && (
                  <AnnotationOverlay
                    pageIndex={index}
                    width={size.width}
                    height={size.height}
                    annotations={annotations}
                    selectedId={selectedId}
                    drawMode={drawMode}
                    onSelect={onSelect}
                    onMoved={onMoved}
                    onDrawn={onDrawn}
                  />
                )}
              </div>
            </div>
          );
        })}
    </div>
  );
}
