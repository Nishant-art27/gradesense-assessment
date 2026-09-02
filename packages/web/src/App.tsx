import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Annotation, FindingKind, GradingResult, GradingSummary, Rect } from '@gradesense/shared';
import { api, ApiRequestError, type GradedPaper, type HealthInfo } from './api.js';
import { ToastProvider, useToast } from './ToastProvider.js';
import { AppShell, type Status } from './components/AppShell.js';
import { PaperViewer } from './components/PaperViewer.js';
import { RubricPanel } from './components/RubricPanel.js';
import { AnnotationEditor } from './components/AnnotationEditor.js';
import { LandingHero } from './components/LandingHero.js';
import { SetupWizard } from './components/SetupWizard.js';
import { Button } from './components/ui/Button.js';
import { Card } from './components/ui/Card.js';
import { Skeleton } from './components/ui/misc.js';

export function App() {
  return (
    <ToastProvider>
      <GradeSense />
    </ToastProvider>
  );
}

function GradeSense() {
  const toast = useToast();

  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [samples, setSamples] = useState<string[]>([]);
  const [history, setHistory] = useState<GradingSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const [documentId, setDocumentId] = useState<string | null>(null);
  const [result, setResult] = useState<GradingResult | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [savingAnnotation, setSavingAnnotation] = useState(false);
  /** 'landing' → 'setup' (upload + rubric) → 'workspace' (a marked script). */
  const [setupOpen, setSetupOpen] = useState(false);

  const selected = useMemo(
    () => annotations.find((annotation) => annotation.id === selectedId) ?? null,
    [annotations, selectedId],
  );

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await api.listResults());
    } catch {
      // History is a convenience; a failure here should not block marking.
    } finally {
      setHistoryLoading(false);
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

  const fail = useCallback((error: unknown, fallback: string) => {
    if (error instanceof ApiRequestError) {
      setStatus({ kind: 'error', message: error.message, details: error.details, retryable: error.retryable });
    } else {
      setStatus({ kind: 'error', message: fallback, details: [], retryable: false });
    }
  }, []);

  const applyGraded = (graded: GradedPaper) => {
    setResult(graded.result);
    setAnnotations(graded.annotations);
    setSelectedId(null);
    setStatus({ kind: 'idle' });
    void refreshHistory();
  };

  /* ------------------------------- actions ------------------------------- */

  const gradeDocument = async (id: string, rubricId?: string | null) => {
    setStatus({ kind: 'busy', message: 'Marking against the rubric…' });
    try {
      const graded = await api.grade(id, rubricId ? { rubricId } : undefined);
      setDocumentId(id);
      setSetupOpen(false);
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
    setSetupOpen(false);
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

  const toolbar = inWorkspace ? (
    <div className="toolbar">
      <div className="toolbar__group">
        <span className="toolbar__file">
          <strong>{result?.studentAnswerFilename ?? 'Answer paper'}</strong>
          {result && <span>· {annotations.length} annotations</span>}
        </span>
      </div>

      {result && (
        <div className="toolbar__group">
          <Button
            variant="glass"
            size="sm"
            active={drawMode}
            onClick={() => setDrawMode((current) => !current)}
            title="Drag on the paper to add your own annotation"
          >
            {drawMode ? 'Drag on the paper…' : '+ Add annotation'}
          </Button>
          <Button variant="primary" size="sm" onClick={() => void exportPdf()}>
            Export annotated PDF
          </Button>
        </div>
      )}
    </div>
  ) : undefined;

  return (
    <AppShell
      health={health}
      status={status}
      onHome={backToStart}
      showBack={inWorkspace}
      toolbar={toolbar}
      onRetry={documentId ? () => void gradeDocument(documentId) : undefined}
    >
      {setupOpen && !inWorkspace ? (
        <SetupWizard
          onGraded={(studentId, rubricId) => gradeDocument(studentId, rubricId)}
          onCancel={() => setSetupOpen(false)}
          onError={fail}
        />
      ) : !inWorkspace ? (
        <LandingHero
          samples={samples}
          history={history}
          historyLoading={historyLoading}
          busy={busy}
          onPick={(slug) => void loadSample(slug)}
          onOpen={(id) => void openFromHistory(id)}
          onUpload={(file) => void uploadAndGrade(file)}
          onSetup={() => setSetupOpen(true)}
        />
      ) : (
        <main className="workspace">
          <section className="paper-col">
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

          <aside className="rail">
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
              <Card pad="md" className="panel-loading">
                <Skeleton height={104} width={104} />
                <Skeleton height={16} width="60%" />
                <Skeleton height={12} width="40%" />
                <Skeleton height={72} />
                <Skeleton height={72} />
              </Card>
            )}
          </aside>
        </main>
      )}
    </AppShell>
  );
}
