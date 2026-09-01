import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Annotation, FindingKind, GradingResult, GradingSummary, Rect } from '@gradesense/shared';
import { api, ApiRequestError, type GradedPaper, type HealthInfo } from './api.js';
import { PaperViewer } from './components/PaperViewer.js';
import { RubricPanel } from './components/RubricPanel.js';
import { AnnotationEditor } from './components/AnnotationEditor.js';

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'error'; message: string; details: string[]; retryable: boolean };

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

  const selected = useMemo(
    () => annotations.find((annotation) => annotation.id === selectedId) ?? null,
    [annotations, selectedId],
  );

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

  const fail = (error: unknown, fallback: string) => {
    if (error instanceof ApiRequestError) {
      setStatus({ kind: 'error', message: error.message, details: error.details, retryable: error.retryable });
    } else {
      setStatus({ kind: 'error', message: fallback, details: [], retryable: false });
    }
  };

  const applyGraded = (graded: GradedPaper) => {
    setResult(graded.result);
    setAnnotations(graded.annotations);
    setSelectedId(null);
    setStatus({ kind: 'idle' });
    void refreshHistory();
  };

  /* ------------------------------- actions ------------------------------- */

  const gradeDocument = async (id: string) => {
    setStatus({ kind: 'busy', message: 'Marking the paper…' });
    try {
      applyGraded(await api.grade(id));
    } catch (error) {
      fail(error, 'Marking failed.');
    }
  };

  const loadSample = async (slug: string) => {
    setStatus({ kind: 'busy', message: `Loading ${slug}…` });
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

  /* ---------------------- annotation editing (no re-grade) ---------------- */

  /**
   * Each of these updates local state immediately and persists in the
   * background. None of them calls /api/grade — the marks on screen are the
   * marks that were awarded, however much the mark-up is rearranged.
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
    } catch (error) {
      fail(error, 'Could not export the annotated copy.');
    }
  };

  /* -------------------------------- render -------------------------------- */

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <h1>GradeSense</h1>
          <span className="tagline">explainable marking with annotations you can edit</span>
        </div>
        {health && (
          <div className={`provider-badge ${health.live ? 'live' : 'mock'}`}>
            {health.live ? `live · ${health.model}` : 'deterministic mock · no API key needed'}
          </div>
        )}
      </header>

      <div className="toolbar">
        <div className="toolbar-group">
          <label className="file-button">
            Upload an answer PDF
            <input
              type="file"
              accept="application/pdf"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadAndGrade(file);
                event.target.value = '';
              }}
            />
          </label>

          {samples.length > 0 && (
            <div className="sample-group">
              <span className="toolbar-label">or mark a sample:</span>
              {samples.map((slug) => (
                <button key={slug} type="button" className="chip" onClick={() => void loadSample(slug)}>
                  {slug}
                </button>
              ))}
            </div>
          )}
        </div>

        {result && (
          <div className="toolbar-group right">
            <button
              type="button"
              className={drawMode ? 'active' : ''}
              onClick={() => setDrawMode((current) => !current)}
              title="Drag on the paper to add your own annotation"
            >
              {drawMode ? 'Click and drag on the paper…' : '+ Add annotation'}
            </button>
            <button type="button" className="primary" onClick={() => void exportPdf()}>
              Export annotated PDF
            </button>
          </div>
        )}
      </div>

      {status.kind === 'busy' && <div className="banner busy">{status.message}</div>}
      {status.kind === 'error' && (
        <div className="banner error">
          <strong>{status.message}</strong>
          {status.details.length > 0 && (
            <ul>
              {status.details.map((detail, index) => (
                <li key={index}>{detail}</li>
              ))}
            </ul>
          )}
          {status.retryable && documentId && (
            <button type="button" onClick={() => void gradeDocument(documentId)}>
              Try again
            </button>
          )}
        </div>
      )}

      <main className="layout">
        <section className="paper-column">
          {documentId ? (
            <PaperViewer
              fileUrl={api.documentFileUrl(documentId)}
              annotations={annotations}
              selectedId={selectedId}
              drawMode={drawMode}
              onSelect={setSelectedId}
              onMoved={(id, rect) => void moveAnnotation(id, rect)}
              onDrawn={(rect) => void addAnnotation(rect)}
            />
          ) : (
            <EmptyState history={history} onOpen={(id) => void openFromHistory(id)} />
          )}
        </section>

        <aside className="side-column">
          {selected ? (
            <AnnotationEditor
              annotation={selected}
              saving={savingAnnotation}
              onChange={(patch) => void editAnnotation(selected.id, patch)}
              onDelete={() => void deleteAnnotation(selected.id)}
              onClose={() => setSelectedId(null)}
            />
          ) : result ? (
            <RubricPanel
              result={result}
              annotations={annotations}
              selectedId={selectedId}
              onSelectAnnotation={setSelectedId}
            />
          ) : (
            <div className="placeholder">
              <p>Upload an answer paper or pick a sample to see the marking.</p>
            </div>
          )}

          {history.length > 0 && (
            <HistoryList
              history={history}
              activeId={result?.id ?? null}
              onOpen={(id) => void openFromHistory(id)}
            />
          )}
        </aside>
      </main>
    </div>
  );
}

function EmptyState({
  history,
  onOpen,
}: {
  history: GradingSummary[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="empty-state">
      <h2>Nothing loaded yet</h2>
      <p>
        Upload a student answer, or mark one of the sample papers from the toolbar. The sample set also
        loads the question paper and the marking scheme.
      </p>
      {history.length > 0 && (
        <>
          <h3>Recently marked</h3>
          <ul className="empty-history">
            {history.slice(0, 5).map((entry) => (
              <li key={entry.id}>
                <button type="button" className="link" onClick={() => onOpen(entry.id)}>
                  {entry.studentAnswerFilename} — {entry.totalMarks}/{entry.maxMarks}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function HistoryList({
  history,
  activeId,
  onOpen,
}: {
  history: GradingSummary[];
  activeId: string | null;
  onOpen: (id: string) => void;
}) {
  return (
    <details className="history" open={activeId === null}>
      <summary>History ({history.length})</summary>
      <ul>
        {history.map((entry) => (
          <li key={entry.id} className={entry.id === activeId ? 'active' : ''}>
            <button type="button" onClick={() => onOpen(entry.id)}>
              <span className="history-name">{entry.studentAnswerFilename}</span>
              <span className="history-score">
                {entry.totalMarks}/{entry.maxMarks}
              </span>
              {entry.requiresHumanReview && <span className="history-flag" title="Needs review">review</span>}
              <span className="history-date">{new Date(entry.createdAt).toLocaleString()}</span>
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
