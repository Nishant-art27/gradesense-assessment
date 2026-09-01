import { useCallback, useRef, useState } from 'react';
import type { Annotation, FindingKind, Rect } from '@gradesense/shared';

/**
 * The interactive annotation layer for one page.
 *
 * Everything here works in normalised page coordinates (0..1) and converts to
 * pixels only at the moment of drawing. That is what lets an annotation survive
 * a window resize, a different zoom, and the PDF export — which reads the same
 * numbers and draws them at PDF scale.
 *
 * Dragging is implemented with pointer capture rather than window listeners, so
 * a drag that leaves the page still tracks correctly and always ends.
 */

export const KIND_LABELS: Record<FindingKind, string> = {
  incorrect: 'Incorrect',
  missing: 'Missing',
  spelling: 'Spelling',
  grammar: 'Grammar',
  layout: 'Layout',
  praise: 'Good',
};

type DragMode = 'move' | 'resize';

interface DragState {
  annotationId: string;
  mode: DragMode;
  /** Pointer offset within the box at drag start, normalised. */
  grabDx: number;
  grabDy: number;
  origin: Rect;
}

export function AnnotationOverlay({
  pageIndex,
  width,
  height,
  annotations,
  selectedId,
  drawMode,
  onSelect,
  onMoved,
  onDrawn,
}: {
  pageIndex: number;
  width: number;
  height: number;
  annotations: Annotation[];
  selectedId: string | null;
  drawMode: boolean;
  onSelect: (id: string | null) => void;
  /** Called once, when a drag finishes — not on every pointer move. */
  onMoved: (id: string, rect: Rect) => void;
  onDrawn: (rect: Rect) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  /** Live rectangle during a drag, so the box follows the pointer without a round trip. */
  const [preview, setPreview] = useState<{ id: string; rect: Rect } | null>(null);
  const [newBox, setNewBox] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);

  const toNormalised = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const box = svgRef.current?.getBoundingClientRect();
      if (!box) return { x: 0, y: 0 };
      return {
        x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
        y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
      };
    },
    [],
  );

  const onPage = annotations.filter((annotation) => annotation.rect.page === pageIndex);

  /* ------------------------------ drawing new ----------------------------- */

  const handleBackgroundDown = (event: React.PointerEvent<SVGRectElement>) => {
    if (!drawMode) {
      onSelect(null);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toNormalised(event);
    setNewBox({ from: point, to: point });
  };

  const handleBackgroundMove = (event: React.PointerEvent<SVGRectElement>) => {
    if (!newBox) return;
    setNewBox({ ...newBox, to: toNormalised(event) });
  };

  const handleBackgroundUp = () => {
    if (!newBox) return;
    const rect = rectFromPoints(pageIndex, newBox.from, newBox.to);
    setNewBox(null);
    // Ignore an accidental click that produced no meaningful area.
    if (rect.width > 0.01 && rect.height > 0.008) onDrawn(rect);
  };

  /* ------------------------------ moving/resizing -------------------------- */

  const beginDrag = (
    event: React.PointerEvent<SVGElement>,
    annotation: Annotation,
    mode: DragMode,
  ) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toNormalised(event);
    onSelect(annotation.id);
    setDrag({
      annotationId: annotation.id,
      mode,
      grabDx: point.x - annotation.rect.x,
      grabDy: point.y - annotation.rect.y,
      origin: annotation.rect,
    });
    setPreview({ id: annotation.id, rect: annotation.rect });
  };

  const handleDragMove = (event: React.PointerEvent<SVGElement>) => {
    if (!drag) return;
    const point = toNormalised(event);
    const origin = drag.origin;

    const rect: Rect =
      drag.mode === 'move'
        ? {
            page: pageIndex,
            x: clamp(point.x - drag.grabDx, 0, 1 - origin.width),
            y: clamp(point.y - drag.grabDy, 0, 1 - origin.height),
            width: origin.width,
            height: origin.height,
          }
        : {
            page: pageIndex,
            x: origin.x,
            y: origin.y,
            width: clamp(point.x - origin.x, 0.01, 1 - origin.x),
            height: clamp(point.y - origin.y, 0.008, 1 - origin.y),
          };

    setPreview({ id: drag.annotationId, rect });
  };

  const handleDragEnd = () => {
    if (drag && preview && preview.id === drag.annotationId) {
      const moved =
        Math.abs(preview.rect.x - drag.origin.x) > 0.0005 ||
        Math.abs(preview.rect.y - drag.origin.y) > 0.0005 ||
        Math.abs(preview.rect.width - drag.origin.width) > 0.0005 ||
        Math.abs(preview.rect.height - drag.origin.height) > 0.0005;
      // Only persist a real change, so a click-to-select does not mark the
      // annotation as edited by a human.
      if (moved) onMoved(drag.annotationId, preview.rect);
    }
    setDrag(null);
    setPreview(null);
  };

  /*
   * Rectangles are converted to pixels here rather than drawn in a 0..1 viewBox.
   * A unit viewBox on a non-square page scales x and y differently, which
   * distorts anything with a fixed size — a 1.5-unit stroke on the resize handle
   * became a 1300px band of colour across the page, and the handle itself came
   * out as a stretched rectangle. Working in pixels keeps strokes and handles
   * literal; the stored coordinates stay normalised either way.
   */
  const toPixels = (rect: Rect) => ({
    x: rect.x * width,
    y: rect.y * height,
    width: rect.width * width,
    height: rect.height * height,
  });

  const HANDLE = 9;

  return (
    <svg
      ref={svgRef}
      className={`annotation-overlay${drawMode ? ' drawing' : ''}`}
      width={width}
      height={height}
    >
      {/* Full-page hit target: deselects on click, or starts a new box in draw mode. */}
      <rect
        x={0}
        y={0}
        width={width}
        height={height}
        fill="transparent"
        pointerEvents="all"
        onPointerDown={handleBackgroundDown}
        onPointerMove={handleBackgroundMove}
        onPointerUp={handleBackgroundUp}
      />

      {onPage.map((annotation) => {
        const live = toPixels(preview?.id === annotation.id ? preview.rect : annotation.rect);
        const selected = annotation.id === selectedId;
        const extras = preview?.id === annotation.id ? [] : annotation.extraRects;

        return (
          <g
            key={annotation.id}
            className={`annotation kind-${annotation.kind} anchor-${annotation.anchorStatus}${selected ? ' selected' : ''}`}
          >
            {/* Continuation boxes for a quote that wrapped across lines. */}
            {extras
              .filter((rect) => rect.page === pageIndex)
              .map((rect, index) => (
                <rect
                  key={index}
                  {...toPixels(rect)}
                  className="annotation-box continuation"
                  pointerEvents="none"
                />
              ))}

            <rect
              {...live}
              className="annotation-box"
              onPointerDown={(event) => beginDrag(event, annotation, 'move')}
              onPointerMove={handleDragMove}
              onPointerUp={handleDragEnd}
            />

            {selected && (
              <rect
                x={live.x + live.width - HANDLE / 2}
                y={live.y + live.height - HANDLE / 2}
                width={HANDLE}
                height={HANDLE}
                className="annotation-handle"
                onPointerDown={(event) => beginDrag(event, annotation, 'resize')}
                onPointerMove={handleDragMove}
                onPointerUp={handleDragEnd}
              />
            )}
          </g>
        );
      })}

      {newBox && (
        <rect
          {...toPixels(rectFromPoints(pageIndex, newBox.from, newBox.to))}
          className="annotation-box drafting"
          pointerEvents="none"
        />
      )}
    </svg>
  );
}

function rectFromPoints(page: number, a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    page,
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
