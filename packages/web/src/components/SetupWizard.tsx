import { useMemo, useState } from 'react';
import type { DocumentKind, DocumentSummary, Rubric } from '@gradesense/shared';
import { api, type RubricDraft } from '../api.js';
import { useToast } from '../ToastProvider.js';
import { Badge } from './ui/Badge.js';
import { Button } from './ui/Button.js';
import { Card } from './ui/Card.js';
import { Callout } from './ui/Callout.js';
import { NumberInput } from './ui/Field.js';
import { FileDropzone } from './ui/FileDropzone.js';
import { Disclose } from './ui/misc.js';
import { cx } from './ui/cx.js';

/**
 * Setting up an exam, then marking a script against it.
 *
 * This is the phase that happens once per paper rather than once per student:
 * upload the question paper and the marking scheme, read a rubric out of them,
 * and confirm it. The rubric is the specification every subsequent mark is
 * measured against, so a mistake here is repeated across the whole class — which
 * is exactly why the confirmation step exists and why the marks are editable
 * before anything is graded.
 */

type SlotKind = Extract<DocumentKind, 'question_paper' | 'model_answer' | 'student_answer'>;

interface Slot {
  kind: SlotKind;
  title: string;
  blurb: string;
  required: boolean;
}

const SLOTS: Slot[] = [
  {
    kind: 'question_paper',
    title: 'Question paper',
    blurb: 'What was asked. Supplies each question as the candidate saw it.',
    required: false,
  },
  {
    kind: 'model_answer',
    title: 'Model answer & marking scheme',
    blurb: 'The criteria, the marks, and any grading guidance. This becomes the rubric.',
    required: true,
  },
  {
    kind: 'student_answer',
    title: 'Student answer',
    blurb: 'The script to be marked.',
    required: true,
  },
];

const STEPS = [
  { n: 1, title: 'Upload the documents', hint: 'The scheme is the one that matters.' },
  { n: 2, title: 'Read the rubric', hint: 'Parsed from the scheme, then confirmed by you.' },
  { n: 3, title: 'Mark the script', hint: 'Graded against the rubric you confirmed.' },
];

export function SetupWizard({
  onGraded,
  onCancel,
  onError,
}: {
  onGraded: (studentDocumentId: string, rubricId: string) => Promise<void>;
  onCancel: () => void;
  onError: (error: unknown, fallback: string) => void;
}) {
  const toast = useToast();

  const [uploads, setUploads] = useState<Partial<Record<SlotKind, DocumentSummary>>>({});
  const [busySlot, setBusySlot] = useState<SlotKind | null>(null);

  const [draft, setDraft] = useState<RubricDraft | null>(null);
  const [rubric, setRubric] = useState<Rubric | null>(null);
  const [reading, setReading] = useState(false);
  const [marking, setMarking] = useState(false);

  const canRead = Boolean(uploads.model_answer);
  const canMark = Boolean(rubric && uploads.student_answer);

  /** Live totals, so an edited mark shows its effect before anything is saved. */
  const totals = useMemo(() => {
    if (!rubric) return null;
    const questions = rubric.questions.map((question) => ({
      id: question.id,
      sum: question.criteria.reduce((total, criterion) => total + (criterion.maxMarks || 0), 0),
    }));
    return {
      byQuestion: new Map(questions.map((entry) => [entry.id, entry.sum])),
      paper: questions.reduce((total, entry) => total + entry.sum, 0),
    };
  }, [rubric]);

  const upload = async (kind: SlotKind, file: File) => {
    setBusySlot(kind);
    try {
      const uploaded = await api.uploadDocument(file, kind);
      setUploads((current) => ({ ...current, [kind]: uploaded }));
      // A new marking scheme invalidates any rubric read from the old one.
      if (kind === 'model_answer' || kind === 'question_paper') {
        setDraft(null);
        setRubric(null);
      }
      toast(
        uploaded.transcription?.status === 'pending'
          ? `${file.name} is a scan · reading the handwriting on ${uploaded.transcription.pages.length} page${uploaded.transcription.pages.length === 1 ? '' : 's'} in the background`
          : uploaded.transcription?.status === 'unsupported'
            ? `${file.name} is a scan with no text layer, and the current provider cannot read images`
            : `${file.name} read · ${uploaded.pageCount} page${uploaded.pageCount === 1 ? '' : 's'}`,
      );
    } catch (error) {
      onError(error, `Could not read ${file.name}.`);
    } finally {
      setBusySlot(null);
    }
  };

  const readRubric = async () => {
    if (!uploads.model_answer) return;
    setReading(true);
    try {
      const extracted = await api.extractRubric(
        uploads.model_answer.id,
        uploads.question_paper?.id ?? null,
      );
      setDraft(extracted);
      setRubric(extracted.rubric);
      toast(`Rubric read · ${extracted.rubric.totalMarks} marks across ${extracted.rubric.questions.length} questions`);
    } catch (error) {
      onError(error, 'Could not read a rubric.');
    } finally {
      setReading(false);
    }
  };

  const confirmAndMark = async () => {
    if (!rubric || !uploads.student_answer) return;
    setMarking(true);
    try {
      // Saved with the marks as they now stand, including any the teacher changed.
      const saved = await api.saveRubric({
        ...rubric,
        totalMarks: totals?.paper ?? rubric.totalMarks,
        questions: rubric.questions.map((question) => ({
          ...question,
          maxMarks: totals?.byQuestion.get(question.id) ?? question.maxMarks,
        })),
      });
      await onGraded(uploads.student_answer.id, saved.id);
    } catch (error) {
      onError(error, 'Could not mark the paper.');
    } finally {
      setMarking(false);
    }
  };

  /** Lets the teacher correct an inferred criterion's wording before marking. */
  const setCriterionDescription = (questionId: string, criterionId: string, value: string) => {
    setRubric((current) =>
      current === null
        ? current
        : {
            ...current,
            questions: current.questions.map((question) =>
              question.id !== questionId
                ? question
                : {
                    ...question,
                    criteria: question.criteria.map((criterion) =>
                      criterion.id === criterionId ? { ...criterion, description: value } : criterion,
                    ),
                  },
            ),
          },
    );
  };

  const setCriterionMarks = (questionId: string, criterionId: string, value: number) => {
    setRubric((current) =>
      current === null
        ? current
        : {
            ...current,
            questions: current.questions.map((question) =>
              question.id !== questionId
                ? question
                : {
                    ...question,
                    criteria: question.criteria.map((criterion) =>
                      criterion.id === criterionId ? { ...criterion, maxMarks: value } : criterion,
                    ),
                  },
            ),
          },
    );
  };

  /** Which step the teacher is on, for the stepper and the de-emphasis. */
  const activeStep = !canRead ? 1 : rubric === null ? 2 : 3;

  return (
    <div className="setup">
      <div className="setup__inner">
      <header className="setup__head">
        <div>
          <h1>Set up an exam</h1>
          <p>
            Upload the paper and its marking scheme once. GradeSense reads the rubric out of them, you
            confirm it, and then every script is marked against it.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          ← Back
        </Button>
      </header>

      <nav className="stepper" aria-label="Progress">
        {STEPS.map((step) => (
          <div
            key={step.n}
            className={cx(
              'stepper__step',
              step.n === activeStep && 'is-active',
              step.n < activeStep && 'is-done',
            )}
          >
            <span className="stepper__n">Step {step.n}</span>
            <span className="stepper__title">{step.title}</span>
            <span className="stepper__hint">{step.hint}</span>
          </div>
        ))}
      </nav>

      {/* Step 1 — the three documents the brief asks for */}
      <section className="step">
        <StepHead n={1} title="Upload the documents" done={canRead} />
        <div className="slot-grid">
          {SLOTS.map((slot) => {
            const uploaded = uploads[slot.kind];
            return (
              <FileDropzone
                key={slot.kind}
                title={slot.title}
                blurb={slot.blurb}
                badge={
                  slot.required ? (
                    <Badge tone="primary">required</Badge>
                  ) : (
                    <Badge>optional</Badge>
                  )
                }
                filled={
                  uploaded
                    ? {
                        name: uploaded.filename,
                        meta: describeUpload(uploaded),
                      }
                    : undefined
                }
                busy={busySlot === slot.kind}
                onFile={(file) => void upload(slot.kind, file)}
              />
            );
          })}
        </div>
      </section>

      {/* Step 2 — read the rubric and let a human check it */}
      <section className={cx('step', activeStep < 2 && 'is-waiting')}>
        <StepHead n={2} title="Read the rubric" done={rubric !== null} />
        {!rubric ? (
          <Card glass className="step__body">
            <p className="step__hint">
              {canRead
                ? 'GradeSense will read the questions, criteria, marks and grading guidance out of the marking scheme.'
                : 'Upload a marking scheme first — that is where the criteria and marks come from.'}
            </p>
            <Button variant="primary" disabled={!canRead} loading={reading} onClick={() => void readRubric()}>
              {reading ? 'Reading…' : 'Read the rubric'}
            </Button>
          </Card>
        ) : (
          <RubricReview
            rubric={rubric}
            draft={draft}
            totals={totals}
            onChangeMarks={setCriterionMarks}
            onChangeDescription={setCriterionDescription}
            onReread={() => void readRubric()}
            rereading={reading}
          />
        )}
      </section>

      {/* Step 3 — mark */}
      <section className={cx('step', activeStep < 3 && 'is-waiting')}>
        <StepHead n={3} title="Mark the script" done={false} />
        <Card glass className="step__body">
          <p className="step__hint">
            {canMark
              ? `${uploads.student_answer?.filename} will be marked against this rubric, out of ${totals?.paper ?? 0}.`
              : 'Confirm a rubric and upload a student answer to mark.'}
          </p>
          <Button
            variant="primary"
            size="lg"
            disabled={!canMark}
            loading={marking}
            onClick={() => void confirmAndMark()}
          >
            {marking ? 'Marking…' : 'Confirm rubric & mark →'}
          </Button>
        </Card>
      </section>
      </div>
    </div>
  );
}

function StepHead({ n, title, done }: { n: number; title: string; done: boolean }) {
  return (
    <header className="step__head">
      <span className={cx('step__n', done && 'is-done')} aria-hidden="true">
        {done ? '✓' : n}
      </span>
      <h2>{title}</h2>
    </header>
  );
}

function RubricReview({
  rubric,
  draft,
  totals,
  onChangeMarks,
  onChangeDescription,
  onReread,
  rereading,
}: {
  rubric: Rubric;
  draft: RubricDraft | null;
  totals: { byQuestion: Map<string, number>; paper: number } | null;
  onChangeMarks: (questionId: string, criterionId: string, value: number) => void;
  onChangeDescription: (questionId: string, criterionId: string, value: string) => void;
  onReread: () => void;
  rereading: boolean;
}) {
  return (
    <Card glass className="rubric-review">
      <div className="rubric-review__head">
        <div>
          <h3>{rubric.title}</h3>
          <p className="rubric-review__source">
            {draft?.source === 'model' ? 'read by the language model' : 'parsed directly from the scheme'} ·{' '}
            {totals?.paper ?? rubric.totalMarks} marks · {rubric.questions.length} questions
          </p>
        </div>
        <Button variant="ghost" size="sm" loading={rereading} onClick={onReread}>
          Re-read
        </Button>
      </div>

      {draft && draft.warnings.length > 0 && (
        <div className="rubric-review__note">
          <Callout tone="warn" title="Worth checking">
            <ul>
              {draft.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </Callout>
        </div>
      )}

      {rubric.questions.map((question) => (
        <div className="rubric-q" key={question.id}>
          <div className="rubric-q__head">
            <h4>
              Q{question.number} · {question.subject}
            </h4>
            {/* Whose criteria these are. Inferred ones are never presented as
                the instructor's, here or on the marked paper. */}
            {question.criteriaSource === 'ai-inferred' ? (
              <Badge tone="accent">AI-inferred criteria</Badge>
            ) : (
              <Badge tone="success">Instructor-defined</Badge>
            )}
            {question.criteriaSource === 'instructor' && question.guidance.length === 0 && (
              <Badge tone="neutral">no guidance</Badge>
            )}
            {question.requiresDiagram && <Badge tone="neutral">diagram marks</Badge>}
            <span className="rubric-q__marks">
              {totals?.byQuestion.get(question.id) ?? question.maxMarks} marks
            </span>
          </div>

          {question.criteriaSource === 'ai-inferred' && (
            <p className="rubric-q__note">
              No instructor rubric was provided for this question, so these criteria were inferred from
              the model answer. Edit anything that is wrong before marking.
            </p>
          )}

          <ul>
            {question.criteria.map((criterion) => (
              <li className="criterion-edit" key={criterion.id}>
                <NumberInput
                  min={0}
                  max={20}
                  step={0.5}
                  value={criterion.maxMarks}
                  aria-label={`Marks for ${criterion.description}`}
                  onChange={(event) =>
                    onChangeMarks(question.id, criterion.id, Number(event.target.value) || 0)
                  }
                />
                {/* Editable so a teacher can correct an inferred criterion's
                    wording before anything is marked against it. */}
                <textarea
                  className="criterion-edit__text"
                  rows={2}
                  value={criterion.description}
                  aria-label={`Criterion wording for Q${question.number}`}
                  onChange={(event) =>
                    onChangeDescription(question.id, criterion.id, event.target.value)
                  }
                />
              </li>
            ))}
          </ul>

          {question.guidance.length > 0 && (
            <Disclose summary={`${question.guidance.length} grading guidance rules`}>
              <ul>
                {question.guidance.map((rule, index) => (
                  <li key={index}>{rule}</li>
                ))}
              </ul>
            </Disclose>
          )}
        </div>
      ))}

      <div className="rubric-total">
        <span>
          These marks drive every script graded against this rubric. Adjust any that were read
          wrongly before you continue.
        </span>
        <strong>{totals?.paper ?? rubric.totalMarks} marks</strong>
      </div>
    </Card>
  );
}

/** What was read from an upload, in the words a teacher needs: pages, and whether it is a scan. */
function describeUpload(uploaded: { pageCount: number; transcription?: { status: string; pages: number[] } }): string {
  const pages = `${uploaded.pageCount} page${uploaded.pageCount === 1 ? '' : 's'}`;
  switch (uploaded.transcription?.status) {
    case 'pending':
      return `${pages} · scanned handwriting, being read`;
    case 'done':
      return `${pages} · scanned handwriting, read`;
    case 'unsupported':
      return `${pages} · scanned, provider cannot read images`;
    case 'failed':
      return `${pages} · scanned, reading failed`;
    default:
      return `${pages} read`;
  }
}
