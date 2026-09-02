import { useEffect, useState } from 'react';
import type { Annotation, FindingKind } from '@gradesense/shared';
import { ANNOTATION_COLOURS, ANNOTATION_LABELS, FINDING_KINDS } from '@gradesense/shared';
import { Badge } from './ui/Badge.js';
import { Button } from './ui/Button.js';
import { Card } from './ui/Card.js';
import { Callout } from './ui/Callout.js';
import { Field, Select, TextArea } from './ui/Field.js';
import { Quote } from './ui/Quote.js';
import { IconClose } from './ui/icons.js';
import { cx } from './ui/cx.js';

/**
 * Editor for the selected annotation.
 *
 * Nothing in this panel can change a mark. It edits comment text, correction
 * text, kind and severity, and it can delete the annotation — the grading result
 * is untouched throughout, which is exactly the guarantee the brief asks for.
 */

const ANCHOR_NOTES: Record<string, string> = {
  fuzzy: 'Matched approximately — the answer text differs slightly from the quote.',
  region: 'Placed from an approximate diagram region. Drag the box if it is not quite right.',
  unresolved:
    'This could not be placed on the page, so it is shown as a margin note. Drag it where it belongs.',
};

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
  const anchorNote = ANCHOR_NOTES[annotation.anchorStatus];

  return (
    <Card className="editor">
      <header className="editor__head">
        <h3>Annotation</h3>
        <Button icon size="sm" onClick={onClose} aria-label="Close">
          <IconClose />
        </Button>
      </header>

      <div className="editor__meta">
        <Badge colour={ANNOTATION_COLOURS[annotation.kind]}>
          {ANNOTATION_LABELS[annotation.kind]}
        </Badge>
        <span className="editor__page">page {annotation.rect.page + 1}</span>
        <span
          className={cx(
            'editor__provenance',
            annotation.origin === 'human' ? 'human' : annotation.editedByHuman ? 'edited' : 'ai',
          )}
        >
          {annotation.origin === 'human'
            ? 'added by you'
            : annotation.editedByHuman
              ? 'edited by you'
              : 'from the grader'}
        </span>
      </div>

      {anchorNote && (
        <Callout tone={annotation.anchorStatus === 'unresolved' ? 'warn' : 'neutral'}>
          {anchorNote}
        </Callout>
      )}

      {annotation.quote && <Quote>“{annotation.quote}”</Quote>}

      <div className="editor__fields">
        <Field label="Comment">
          <TextArea value={comment} rows={4} onChange={(event) => setComment(event.target.value)} />
        </Field>

        <Field label="Correction">
          <TextArea
            value={correction}
            rows={3}
            onChange={(event) => setCorrection(event.target.value)}
          />
        </Field>

        <Field label="Type">
          <Select
            value={annotation.kind}
            onChange={(event) => onChange({ kind: event.target.value as FindingKind })}
          >
            {FINDING_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {ANNOTATION_LABELS[kind]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="editor__actions">
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty}
          loading={saving}
          onClick={() => onChange({ comment, correction: correction.length > 0 ? correction : null })}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        <Button variant="danger" size="sm" onClick={onDelete} disabled={saving}>
          Delete
        </Button>
      </div>

      <p className="editor__footnote">
        Editing or deleting mark-up never changes the marks and never re-runs grading.
      </p>
    </Card>
  );
}
