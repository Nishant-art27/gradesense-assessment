import type { Annotation, CriterionScore, GradingResult, QuestionResult } from '@gradesense/shared';

/**
 * The explanation panel: what was awarded, why, and on what evidence.
 *
 * Every criterion shows its mark, the reasoning, the quote it rests on, and the
 * correction. An unverified quote is labelled as such rather than dropped, so a
 * teacher can see that the system cited something it could not find — hiding
 * that would make the output look more trustworthy than it is.
 */

const STATUS_LABELS = {
  correct: 'Correct',
  partial: 'Partial',
  missing: 'Missing',
  incorrect: 'Incorrect',
} as const;

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
        <div className="score-total">
          <span className="score-value">{result.totalMarks}</span>
          <span className="score-max">/ {result.maxMarks}</span>
        </div>
        <div className="score-meta">
          <div className="score-percent">{percentage}%</div>
          <ConfidenceBar value={result.confidence} />
          <div className="score-provider">
            marked by {result.provider === 'mock' ? 'rule-based mock' : result.provider}
          </div>
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

      {result.questions.map((question) => (
        <QuestionBlock
          key={question.questionId}
          question={question}
          annotations={annotations}
          selectedId={selectedId}
          onSelectAnnotation={onSelectAnnotation}
        />
      ))}

      {result.audit.length > 0 && <AuditTrail result={result} />}
    </div>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const percent = Math.round(value * 100);
  const level = value >= 0.8 ? 'high' : value >= 0.65 ? 'medium' : 'low';

  return (
    <div className="confidence" title={`Confidence ${percent}%`}>
      <div className="confidence-track">
        <div className={`confidence-fill ${level}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="confidence-label">{percent}% confident</span>
    </div>
  );
}

function QuestionBlock({
  question,
  annotations,
  selectedId,
  onSelectAnnotation,
}: {
  question: QuestionResult;
  annotations: Annotation[];
  selectedId: string | null;
  onSelectAnnotation: (id: string | null) => void;
}) {
  return (
    <section className="question-block">
      <header className="question-header">
        <h3>
          Q{question.number} · {question.subject}
        </h3>
        <div className="question-marks">
          {question.awardedMarks} / {question.maxMarks}
          {question.state !== 'graded' && <span className={`state-tag ${question.state}`}>{question.state}</span>}
        </div>
      </header>

      <p className="question-summary">{question.summary}</p>

      <ul className="criteria">
        {question.criteria.map((criterion) => (
          <CriterionRow
            key={criterion.criterionId}
            criterion={criterion}
            annotations={annotations.filter((a) => a.criterionId === criterion.criterionId)}
            selectedId={selectedId}
            onSelectAnnotation={onSelectAnnotation}
          />
        ))}
      </ul>

      {question.notes.length > 0 && (
        <details className="question-notes">
          <summary>Why the confidence is {Math.round(question.confidence * 100)}%</summary>
          <ul>
            {question.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function CriterionRow({
  criterion,
  annotations,
  selectedId,
  onSelectAnnotation,
}: {
  criterion: CriterionScore;
  annotations: Annotation[];
  selectedId: string | null;
  onSelectAnnotation: (id: string | null) => void;
}) {
  const full = criterion.awardedMarks >= criterion.maxMarks;
  const none = criterion.awardedMarks === 0;
  const tone = full ? 'full' : none ? 'zero' : 'partial';
  const linked = annotations[0];

  return (
    <li className={`criterion ${tone}${linked && linked.id === selectedId ? ' active' : ''}`}>
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

/**
 * Every automatic correction the pipeline applied, shown rather than hidden.
 * A teacher who is asked to trust a score should be able to see where the
 * system had to overrule the grader.
 */
function AuditTrail({ result }: { result: GradingResult }) {
  const labels: Record<string, string> = {
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

  return (
    <details className="audit-trail">
      <summary>Automatic corrections applied ({result.audit.length})</summary>
      <ul>
        {result.audit.map((event, index) => (
          <li key={index}>
            <span className="audit-kind">{labels[event.kind] ?? event.kind}</span>
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
  );
}
