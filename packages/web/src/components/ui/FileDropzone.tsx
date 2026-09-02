import { useState, type ReactNode } from 'react';
import { cx } from './cx.js';

/**
 * Drop a PDF, or click to choose one.
 *
 * Promoted out of `SetupWizard`'s private `UploadSlot`, which stayed fully
 * interactive mid-upload and only swapped its blurb text — there was no busy
 * state at all. This one blocks input and says what it is doing.
 */
export function FileDropzone({
  title,
  blurb,
  badge,
  filled,
  busy = false,
  disabled = false,
  onFile,
}: {
  title: ReactNode;
  blurb: ReactNode;
  /** e.g. a required/optional chip. */
  badge?: ReactNode;
  /** What is already here, if anything. */
  filled?: { name: string; meta: string };
  busy?: boolean;
  disabled?: boolean;
  onFile: (file: File) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const inert = busy || disabled;

  return (
    <label
      className={cx(
        'dropzone',
        filled && 'is-filled',
        dragging && !inert && 'is-dragging',
        busy && 'is-busy',
      )}
      onDragOver={(event) => {
        if (inert) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (inert) return;
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
    >
      <input
        type="file"
        accept="application/pdf"
        disabled={inert}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = '';
        }}
      />

      <div className="dropzone__top">
        <span className="dropzone__title">{title}</span>
        {badge}
      </div>

      {filled ? (
        <div className="dropzone__file">
          <span className="dropzone__name">{filled.name}</span>
          <span className="dropzone__meta">{filled.meta}</span>
        </div>
      ) : (
        <p className="dropzone__blurb">{blurb}</p>
      )}

      <span className="dropzone__action">
        {busy ? (
          <>
            <span className="spinner" aria-hidden="true" />
            Reading…
          </>
        ) : filled ? (
          'Replace'
        ) : (
          'Choose a PDF or drop it here'
        )}
      </span>
    </label>
  );
}
