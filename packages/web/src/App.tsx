import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Annotation, FindingKind, GradingResult, GradingSummary, Rect } from '@gradesense/shared';
import { api, ApiRequestError, type GradedPaper, type HealthInfo } from './api.js';
import { PaperViewer } from './components/PaperViewer.js';
import { RubricPanel } from './components/RubricPanel.js';
import { AnnotationEditor } from './components/AnnotationEditor.js';
import { LandingHero } from './components/LandingHero.js';

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'error'; message: string; details: string[]; retryable: boolean };

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'err';
}

export function App() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [samples, setSamples] = useState<string[]>([]);
  const [history, setHistory] = useState<GradingSummary[]>([]);

  const [documentId, setDocumentId] = useState<string | null>(null);
  const [result, setResult] = useState<GradingResult | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [savingAnnotation, setSavingAnnotation] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toastSeq = useRef(0);

  const selected = useMemo(
    () => annotations.find((annotation) => annotation.id === selectedId) ?? null,
    [annotations, selectedId],
  );

  /** Transient confirmation, so an edit that persisted silently still shows feedback. */
  const toast = useCallback((text: string, tone: 'ok' | 'err' = 'ok') => {
    const id = (toastSeq.current += 1);
    setToasts((current) => [...current, { id, text, tone }]);
    setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== id)), 2600);
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await api.listResults());
    } catch {
      // History is a convenience; a failure here should not block marking.
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [healthInfo, sampleList] = await Promise.all([api.health(), api.listSampleAnswers()]);
        setHealth(healthInfo);
        setSamples(sampleList.answers);
      } catch {
        setStatus({
          kind: 'error',
          message: 'Could not reach the GradeSense API. Is the server running on port 4000?',
          details: [],
          retryable: true,
        });
      }
      void refreshHistory();
    })();
  }, [refreshHistory]);

  const fail = useCallback(
    (error: unknown, fallback: string) => {
      if (error instanceof ApiRequestError) {
        setStatus({ kind: 'error', message: error.message, details: error.details, retryable: error.retryable });
      } else {
        setStatus({ kind: 'error', message: fallback, details: [], retryable: false });
      }
    },
    [],
  );

  const applyGraded = (graded: GradedPaper) => {
    setResult(graded.result);
    setAnnotations(graded.annotations);
    setSelectedId(null);
    setStatus({ kind: 'idle' });
    void refreshHistory();
  };

  /* ------------------------------- actions ------------------------------- */

  const gradeDocument = async (id: string) => {
    setStatus({ kind: 'busy', message: 'Marking against the rubric…' });
    try {
      const graded = await api.grade(id);
      applyGraded(graded);
      toast(`Marked: ${graded.result.totalMarks} / ${graded.result.maxMarks}`);
    } catch (error) {
      fail(error, 'Marking failed.');
    }
  };

  const loadSample = async (slug: string) => {
    setStatus({ kind: 'busy', message: `Reading ${slug}.pdf…` });
    setResult(null);
    setAnnotations([]);
    try {
      const loaded = await api.loadSample(slug);
      setDocumentId(loaded.studentAnswer.id);
      await gradeDocument(loaded.studentAnswer.id);
    } catch (error) {
      fail(error, 'Could not load the sample answer.');
    }
  };

  const uploadAndGrade = async (file: File) => {
    setStatus({ kind: 'busy', message: `Reading ${file.name}…` });
    setResult(null);
    setAnnotations([]);
    try {
      const uploaded = await api.uploadDocument(file, 'student_answer');
      setDocumentId(uploaded.id);
      await gradeDocument(uploaded.id);
    } catch (error) {
      fail(error, 'Could not read that file.');
    }
  };

  const openFromHistory = async (id: string) => {
    setStatus({ kind: 'busy', message: 'Opening…' });
    try {
      const graded = await api.getResult(id);
      setDocumentId(graded.result.studentAnswerDocumentId);
      applyGraded(graded);
    } catch (error) {
      fail(error, 'Could not open that result.');
    }
  };

  const backToStart = () => {
    setDocumentId(null);
    setResult(null);
    setAnnotations([]);
    setSelectedId(null);
    setDrawMode(false);
    setStatus({ kind: 'idle' });
    void refreshHistory();
  };

  /* ---------------------- annotation editing (no re-grade) ---------------- */

  /**
   * None of these calls /api/grade. The marks on screen are the marks that were
   * awarded, however much the mark-up is rearranged.
   */

  const moveAnnotation = async (id: string, rect: Rect) => {
    setAnnotations((current) =>
      current.map((annotation) =>
        annotation.id === id ? { ...annotation, rect, extraRects: [], editedByHuman: true } : annotation,
      ),
    );
    try {
      const updated = await api.updateAnnotation(result!.id, id, { rect });
      setAnnotations((current) => current.map((a) => (a.id === id ? updated : a)));
      toast('Annotation moved · marks unchanged');
    } catch (error) {
      fail(error, 'Could not save the new position.');
    }
  };

  const editAnnotation = async (
    id: string,
    patch: { comment?: string; correction?: string | null; kind?: FindingKind; severity?: 'minor' | 'major' },
  ) => {
    setSavingAnnotation(true);
    try {
      const updated = await api.updateAnnotation(result!.id, id, patch);
      setAnnotations((current) => current.map((a) => (a.id === id ? updated : a)));
      toast('Saved · marks unchanged');
    } catch (error) {
      fail(error, 'Could not save the annotation.');
    } finally {
      setSavingAnnotation(false);
    }
  };

  const deleteAnnotation = async (id: string) => {
    const previous = annotations;
    setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
    setSelectedId(null);
    try {
      await api.deleteAnnotation(result!.id, id);
      toast('Annotation deleted · marks unchanged');
    } catch (error) {
      setAnnotations(previous); // put it back if the server disagreed
      fail(error, 'Could not delete the annotation.');
    }
  };

  const addAnnotation = async (rect: Rect) => {
    if (!result) return;
    setDrawMode(false);
    try {
      const created = await api.createAnnotation(result.id, {
        rect,
        comment: '',
        correction: null,
        kind: 'incorrect',
        severity: 'major',
      });
      setAnnotations((current) => [...current, created]);
      setSelectedId(created.id);
      toast('Annotation added');
    } catch (error) {
      fail(error, 'Could not add the annotation.');
    }
  };

  const exportPdf = async () => {
    if (!result) return;
    setStatus({ kind: 'busy', message: 'Building the annotated copy…' });
    try {
      await api.exportAnnotated(result.id, `${result.studentAnswerFilename.replace(/\.pdf$/i, '')}-annotated.pdf`);
      setStatus({ kind: 'idle' });
      toast('Annotated PDF downloaded');
    } catch (error) {
      fail(error, 'Could not export the annotated copy.');
    }
  };

  /* -------------------------------- render -------------------------------- */

  const busy = status.kind === 'busy';
  const inWorkspace = documentId !== null;

  return (
    <div className="app">
      <header className="app-header">
        <button type="button" className="brand" onClick={backToStart} title="Back to the start">
          <span className="brand-mark">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 12.5l5 5L20 6.5" />
            </svg>
          </span>
          <span className="brand-text">
            <span className="brand-name">GradeSense</span>
            <span className="brand-sub">explainable marking</span>
          </span>
        </button>

        <div className="header-right">
          {inWorkspace && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={backToStart}>
              ← All papers
            </button>
          )}
          {health && (
            <span className={`provider-pill${health.live ? ' live' : ''}`}>
              <span className="pulse-dot" />
              {health.live ? `live · ${health.model}` : 'deterministic mock · no API key'}
            </span>
          )}
        </div>
      </header>

      {inWorkspace && (
        <div className="toolbar">
          <div className="toolbar-group">
            <span className="toolbar-file">
              <strong>{result?.studentAnswerFilename ?? 'Answer paper'}</strong>
              {result && <span>· {annotations.length} annotations</span>}
            </span>
          </div>

          {result && (
            <div className="toolbar-group">
              <button
                type="button"
                className={`btn btn-sm${drawMode ? ' btn-active' : ''}`}
                onClick={() => setDrawMode((current) => !current)}
                title="Drag on the paper to add your own annotation"
              >
                {drawMode ? 'Drag on the paper…' : '+ Add annotation'}
              </button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => void exportPdf()}>
                Export annotated PDF
              </button>
            </div>
          )}
        </div>
      )}

      {status.kind === 'busy' && (
        <div className="banner busy">
          <span className="spinner" />
          <span>{status.message}</span>
        </div>
      )}
      {status.kind === 'error' && (
        <div className="banner error">
          <div>
            <strong>{status.message}</strong>
            {status.details.length > 0 && (
              <ul>
                {status.details.map((detail, index) => (
                  <li key={index}>{detail}</li>
                ))}
              </ul>
            )}
            {status.retryable && documentId && (
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginTop: 8 }}
                onClick={() => void gradeDocument(documentId)}
              >
                Try again
              </button>
            )}
          </div>
        </div>
      )}

      {!inWorkspace ? (
        <LandingHero
          samples={samples}
          history={history}
          busy={busy}
          onPick={(slug) => void loadSample(slug)}
          onOpen={(id) => void openFromHistory(id)}
          onUpload={(file) => void uploadAndGrade(file)}
        />
      ) : (
        <main className="layout">
          <section className="paper-column">
            <PaperViewer
              fileUrl={api.documentFileUrl(documentId)}
              annotations={annotations}
              selectedId={selectedId}
              drawMode={drawMode}
              onSelect={setSelectedId}
              onMoved={(id, rect) => void moveAnnotation(id, rect)}
              onDrawn={(rect) => void addAnnotation(rect)}
            />
          </section>

          <aside className="side-column">
            {selected ? (
              <div className="panel">
                <AnnotationEditor
                  annotation={selected}
                  saving={savingAnnotation}
                  onChange={(patch) => void editAnnotation(selected.id, patch)}
                  onDelete={() => void deleteAnnotation(selected.id)}
                  onClose={() => setSelectedId(null)}
                />
              </div>
            ) : result ? (
              <div className="panel">
                <RubricPanel
                  result={result}
                  annotations={annotations}
                  selectedId={selectedId}
                  onSelectAnnotation={setSelectedId}
                />
              </div>
            ) : (
              <div className="panel viewer-message">Marking…</div>
            )}
          </aside>
        </main>
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((entry) => (
          <div key={entry.id} className={`toast ${entry.tone}`}>
            {entry.tone === 'ok' ? '✓' : '!'} {entry.text}
          </div>
        ))}
      </div>
    </div>
  );
}
