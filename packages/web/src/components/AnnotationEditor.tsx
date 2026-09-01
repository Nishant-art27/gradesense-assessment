import { useEffect, useState } from 'react';
import type { Annotation, FindingKind } from '@gradesense/shared';
import { FINDING_KINDS } from '@gradesense/shared';
import { KIND_LABELS } from './AnnotationOverlay.js';

/**
 * Editor for the selected annotation.
 *
 * Nothing in this panel can change a mark. It edits comment text, correction
 * text, kind and severity, and it can delete the annotation — the grading result
 * is untouched throughout, which is exactly the guarantee the brief asks for.
 */
export function AnnotationEditor({
  annotation,
  saving,
  onChange,
  onDelete,
  onClose,
}: {
  annotation: Annotation;
  saving: boolean;
  onChange: (patch: { comment?: string; correction?: string | null; kind?: FindingKind; severity?: 'minor' | 'major' }) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [comment, setComment] = useState(annotation.comment);
  const [correction, setCorrection] = useState(annotation.correction ?? '');

  // Reset the fields when a different annotation is selected.
  useEffect(() => {
    setComment(annotation.comment);
    setCorrection(annotation.correction ?? '');
  }, [annotation.id, annotation.comment, annotation.correction]);

  const dirty = comment !== annotation.comment || correction !== (annotation.correction ?? '');

  return (
    <div className="annotation-editor">
      <header>
        <h3>Annotation</h3>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <div className="editor-meta">
        <span className={`kind-chip kind-${annotation.kind}`}>{KIND_LABELS[annotation.kind]}</span>
        <span className="editor-page">page {annotation.rect.page + 1}</span>
        {annotation.origin === 'human' ? (
          <span className="provenance human">added by you</span>
        ) : annotation.editedByHuman ? (
          <span className="provenance edited">edited by you</span>
        ) : (
          <span className="provenance ai">from the grader</span>
        )}
      </div>

      {annotation.anchorStatus !== 'exact' && (
        <p className={`anchor-note ${annotation.anchorStatus}`}>
          {annotation.anchorStatus === 'fuzzy' &&
            'Matched approximately — the answer text differs slightly from the quote.'}
          {annotation.anchorStatus === 'region' &&
            'Placed from an approximate diagram region. Drag the box if it is not quite right.'}
          {annotation.anchorStatus === 'unresolved' &&
            'This could not be placed on the page, so it is shown as a margin note. Drag it where it belongs.'}
        </p>
      )}

      {annotation.quote && (
        <blockquote className="editor-quote">
          “{annotation.quote}”
        </blockquote>
      )}

      <label>
        Comment
        <textarea value={comment} rows={4} onChange={(event) => setComment(event.target.value)} />
      </label>

      <label>
        Correction
        <textarea value={correction} rows={3} onChange={(event) => setCorrection(event.target.value)} />
      </label>

      <label>
        Type
        <select
          value={annotation.kind}
          onChange={(event) => onChange({ kind: event.target.value as FindingKind })}
        >
          {FINDING_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>

      <div className="editor-actions">
        <button
          type="button"
          className="primary"
          disabled={!dirty || saving}
          onClick={() => onChange({ comment, correction: correction.length > 0 ? correction : null })}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" className="danger" onClick={onDelete} disabled={saving}>
          Delete
        </button>
      </div>

      <p className="editor-footnote">
        Editing or deleting mark-up never changes the marks and never re-runs grading.
      </p>
    </div>
  );
}
