import type { Annotation, CriterionScore, GradingResult, QuestionResult } from '@gradesense/shared';
import { ScoreDial } from './ScoreDial.js';

/**
 * The explanation panel: what was awarded, why, and on what evidence.
 *
 * Every criterion shows its mark, the reasoning, the quote it rests on, and the
 * correction. An unverified quote is labelled as such rather than dropped — a
 * system that hid its own failed citations would look more trustworthy than it
 * is, which is the opposite of the point.
 */

const STATUS_LABELS = {
  correct: 'Correct',
  partial: 'Partial',
  missing: 'Missing',
  incorrect: 'Incorrect',
} as const;

const AUDIT_LABELS: Record<string, string> = {
  clamped_above_max: 'Mark reduced to the maximum',
  clamped_below_zero: 'Negative mark raised to zero',
  total_recomputed: 'Total recomputed from the criteria',
  evidence_unverified: 'Cited evidence not found in the answer',
  malformed_output_repaired: 'Grader re-asked after invalid output',
  malformed_output_unrecoverable: 'Grader never returned usable output',
  blank_answer_detected: 'Question detected as unanswered',
  anchor_unresolved: 'Annotation could not be placed on the page',
  model_retry: 'Grader retried after a transient failure',
  rubric_criterion_missing: 'Rubric point not returned by the grader',
  unknown_criterion_ignored: 'Unknown criterion ignored',
};

export function RubricPanel({
  result,
  annotations,
  selectedId,
  onSelectAnnotation,
}: {
  result: GradingResult;
  annotations: Annotation[];
  selectedId: string | null;
  onSelectAnnotation: (id: string | null) => void;
}) {
  const percentage = result.maxMarks > 0 ? Math.round((result.totalMarks / result.maxMarks) * 100) : 0;

  return (
    <div className="rubric-panel">
      <div className="score-header">
        <ScoreDial total={result.totalMarks} max={result.maxMarks} confidence={result.confidence} />
        <div className="score-meta">
          <h2>
            {percentage}% of the paper
            {/* Sits beside the heading rather than on the dial, where it used to
                collide with the confidence figure. */}
            {result.requiresHumanReview && <span className="chip-review">needs review</span>}
          </h2>
          <p>
            {result.questions.length} questions · {annotations.length} annotations
          </p>
          <span className="score-provider">
            {result.provider === 'mock' ? 'rule-based mock' : `${result.provider} · ${result.model}`}
          </span>
        </div>
      </div>

      {result.requiresHumanReview && (
        <div className="review-banner">
          <strong>Needs a human check before these marks are used</strong>
          <ul>
            {result.reviewReasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      {result.questions.map((question, index) => (
        <QuestionBlock
          key={question.questionId}
          question={question}
          index={index}
          annotations={annotations}
          selectedId={selectedId}
          onSelectAnnotation={onSelectAnnotation}
        />
      ))}

      {result.audit.length > 0 && (
        <details className="disclose">
          <summary>Automatic corrections applied ({result.audit.length})</summary>
          <ul>
            {result.audit.map((event, index) => (
              <li key={index}>
                <span className="audit-kind">{AUDIT_LABELS[event.kind] ?? event.kind}</span>
                {event.before !== null && event.after !== null && (
                  <span className="audit-change">
                    {event.before} → {event.after}
                  </span>
                )}
                <span className="audit-detail">{event.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function QuestionBlock({
  question,
  index,
  annotations,
  selectedId,
  onSelectAnnotation,
}: {
  question: QuestionResult;
  index: number;
  annotations: Annotation[];
  selectedId: string | null;
  onSelectAnnotation: (id: string | null) => void;
}) {
  const fraction = question.maxMarks > 0 ? question.awardedMarks / question.maxMarks : 0;

  return (
    <section className="question-block">
      <header className="question-header">
        <h3>
          Q{question.number} · {question.subject}
        </h3>
        <div className="question-marks">
          <span className="mark-bar">
            <span style={{ width: `${fraction * 100}%` }} />
          </span>
          {question.awardedMarks} / {question.maxMarks}
          {question.state !== 'graded' && <span className={`state-tag ${question.state}`}>{question.state}</span>}
        </div>
      </header>

      <p className="question-summary">{question.summary}</p>

      <ul className="criteria">
        {question.criteria.map((criterion, criterionIndex) => (
          <CriterionRow
            key={criterion.criterionId}
            criterion={criterion}
            delayMs={index * 90 + criterionIndex * 45}
            annotations={annotations.filter((a) => a.criterionId === criterion.criterionId)}
            selectedId={selectedId}
            onSelectAnnotation={onSelectAnnotation}
          />
        ))}
      </ul>

      {question.notes.length > 0 && (
        <details className="disclose">
          <summary>Why the confidence is {Math.round(question.confidence * 100)}%</summary>
          <ul>
            {question.notes.map((note, noteIndex) => (
              <li key={noteIndex}>{note}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function CriterionRow({
  criterion,
  delayMs,
  annotations,
  selectedId,
  onSelectAnnotation,
}: {
  criterion: CriterionScore;
  delayMs: number;
  annotations: Annotation[];
  selectedId: string | null;
  onSelectAnnotation: (id: string | null) => void;
}) {
  const full = criterion.awardedMarks >= criterion.maxMarks;
  const none = criterion.awardedMarks === 0;
  const tone = full ? 'full' : none ? 'zero' : 'partial';
  const linked = annotations[0];
  const active = linked !== undefined && linked.id === selectedId;

  return (
    <li className={`criterion ${tone}${active ? ' active' : ''}`} style={{ animationDelay: `${delayMs}ms` }}>
      <div className="criterion-head">
        <span className={`criterion-mark ${tone}`}>
          {criterion.awardedMarks}/{criterion.maxMarks}
        </span>
        <span className="criterion-description">{criterion.description}</span>
        <span className={`criterion-status ${criterion.status}`}>{STATUS_LABELS[criterion.status]}</span>
      </div>

      <p className="criterion-reasoning">{criterion.reasoning}</p>

      {criterion.evidence && (
        <blockquote
          className={`evidence${criterion.evidence.verified ? '' : ' unverified'}${linked ? ' clickable' : ''}`}
          onClick={() => linked && onSelectAnnotation(linked.id)}
          title={linked ? 'Show this on the paper' : undefined}
        >
          <span className="evidence-quote">“{criterion.evidence.quote}”</span>
          {!criterion.evidence.verified && (
            <span className="evidence-flag">
              This quote could not be found in the answer, so the judgement is unverified.
            </span>
          )}
        </blockquote>
      )}

      {criterion.correction && (
        <p className="criterion-correction">
          <strong>Correction:</strong> {criterion.correction}
        </p>
      )}
    </li>
  );
}
