import { useMemo, useState } from 'react';
import type { Annotation, CriterionScore, GradingResult, QuestionResult } from '@gradesense/shared';
import { ConfidenceReading, ScoreDial } from './ScoreDial.js';
import { Badge } from './ui/Badge.js';
import { Card } from './ui/Card.js';
import { Callout } from './ui/Callout.js';
import { Quote } from './ui/Quote.js';
import { Disclose, Meter, Segmented, bandFor } from './ui/misc.js';
import { cx } from './ui/cx.js';

/**
 * The explanation panel: what was awarded, why, and on what evidence.
 *
 * Every criterion shows its mark, the reasoning, the quote it rests on, and the
 * correction. An unverified quote is labelled as such rather than dropped — a
 * system that hid its own failed citations would look more trustworthy than it
 * is, which is the opposite of the point.
 *
 * The summary is pinned and the questions sit behind a tab row, because the
 * whole paper stacked into one column meant the mark scrolled off screen exactly
 * when a teacher was reading the reasons for it.
 */

const STATUS_LABELS = {
  correct: 'Correct',
  partial: 'Partial',
  missing: 'Missing',
  incorrect: 'Incorrect',
} as const;

const STATUS_TONES = {
  correct: 'success',
  partial: 'accent',
  missing: 'neutral',
  incorrect: 'danger',
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

const ALL = 'all';

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
  const [tab, setTab] = useState<string>(ALL);
  const percentage = result.maxMarks > 0 ? Math.round((result.totalMarks / result.maxMarks) * 100) : 0;

  const tabs = useMemo(
    () => [
      { id: ALL, label: 'All' },
      ...result.questions.map((question) => ({
        id: question.questionId,
        label: `Q${question.number}`,
        detail: `${question.awardedMarks}/${question.maxMarks}`,
      })),
    ],
    [result.questions],
  );

  // A tab for a question that no longer exists falls back to All.
  const shown =
    tab === ALL
      ? result.questions
      : result.questions.filter((question) => question.questionId === tab);
  const questions = shown.length > 0 ? shown : result.questions;

  return (
    <Card className="panel">
      {/*
        Summary and tabs pin together. The mark is what a teacher checks the
        reasoning against, and the tabs are how they move between questions —
        both are useless once scrolled off the top of a long paper.
      */}
      <div className="panel__sticky">
        <div className="panel__summary">
          <ScoreDial total={result.totalMarks} max={result.maxMarks} confidence={result.confidence} />
          <div className="panel__meta">
            <h2 className="panel__pct">
              {percentage}% of the paper
              {result.requiresHumanReview && <Badge tone="accent">needs review</Badge>}
            </h2>
            <p className="panel__counts">
              <ConfidenceReading confidence={result.confidence} /> · {result.questions.length}{' '}
              questions · {annotations.length} annotations
            </p>
            <span className="panel__provider">
              {result.provider === 'mock' ? 'rule-based mock' : `${result.provider} · ${result.model}`}
            </span>
          </div>
        </div>

        <div className="panel__tabs">
          <Segmented options={tabs} value={tab} onChange={setTab} ariaLabel="Questions" />
        </div>
      </div>

      <div className="panel__body">
        {result.requiresHumanReview && (
          <Callout tone="warn" title="Needs a human check before these marks are used">
            <ul>
              {result.reviewReasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          </Callout>
        )}

        {questions.map((question) => (
          <QuestionBlock
            key={question.questionId}
            question={question}
            annotations={annotations}
            selectedId={selectedId}
            onSelectAnnotation={onSelectAnnotation}
          />
        ))}

        {result.audit.length > 0 && (
          <Disclose summary={`Automatic corrections applied (${result.audit.length})`}>
            <ul className="audit">
              {result.audit.map((event, index) => (
                <li key={index}>
                  <span className="audit__kind">
                    {AUDIT_LABELS[event.kind] ?? event.kind}
                    {event.before !== null && event.after !== null && (
                      <span className="audit__change">
                        {event.before} → {event.after}
                      </span>
                    )}
                  </span>
                  <span className="audit__detail">{event.detail}</span>
                </li>
              ))}
            </ul>
          </Disclose>
        )}
      </div>
    </Card>
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
    <section className="question">
      <header className="question__head">
        <h3>
          Q{question.number} · {question.subject}
        </h3>
        <div className="question__marks">
          {question.state !== 'graded' && (
            <Badge tone={question.state === 'ungraded' ? 'danger' : 'neutral'}>{question.state}</Badge>
          )}
          <Meter value={question.awardedMarks} max={question.maxMarks} />
          <span>
            {question.awardedMarks} / {question.maxMarks}
          </span>
        </div>
      </header>

      {/* Whose standard produced these marks. Inferred criteria are never shown
          as though the instructor wrote them. */}
      {question.criteriaSource === 'ai-inferred' ? (
        <Callout tone="warn" title="AI-inferred grading">
          <p>
            No instructor rubric was provided for this question. The criteria below were inferred
            from the model answer, and the marks follow them.
          </p>
        </Callout>
      ) : (
        !question.guidanceProvided && (
          <p className="question__provenance">
            Instructor-defined rubric · no grading guidance was supplied for this question
          </p>
        )
      )}

      <p className="question__summary">{question.summary}</p>

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
        <Disclose summary={`Why the confidence is ${Math.round(question.confidence * 100)}%`}>
          <ul>
            {question.notes.map((note, noteIndex) => (
              <li key={noteIndex}>{note}</li>
            ))}
          </ul>
        </Disclose>
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
  const tone = bandFor(criterion.awardedMarks, criterion.maxMarks);
  const linked = annotations[0];
  const active = linked !== undefined && linked.id === selectedId;
  const evidence = criterion.evidence;

  return (
    <li>
      <Card pad="none" className={cx('criterion', tone, active && 'is-active')}>
        <div className="criterion__head">
          <span className="criterion__mark">
            {criterion.awardedMarks}/{criterion.maxMarks}
          </span>
          <span className="criterion__description">{criterion.description}</span>
          <Badge tone={STATUS_TONES[criterion.status]}>{STATUS_LABELS[criterion.status]}</Badge>
        </div>

        <p className="criterion__reasoning">{criterion.reasoning}</p>

        {evidence && (
          <>
            <Quote
              flagged={!evidence.verified}
              onActivate={linked ? () => onSelectAnnotation(linked.id) : undefined}
              title={linked ? 'Show this on the paper' : undefined}
              flag={
                evidence.verified
                  ? undefined
                  : 'This quote could not be found in the answer, so the judgement is unverified.'
              }
            >
              “{evidence.quote}”
            </Quote>
            {/*
              A fuzzy match is a real caveat: the quote is not literally what the
              student wrote. Saying so is cheaper than a teacher discovering it.
            */}
            {evidence.verified && evidence.similarity < 0.999 && (
              <span className="match-note">
                Matched at {Math.round(evidence.similarity * 100)}% — the answer reads “
                {evidence.matchedText ?? evidence.quote}”
              </span>
            )}
          </>
        )}

        {criterion.correction && (
          <p className="criterion__correction">
            <strong>Correction:</strong> {criterion.correction}
          </p>
        )}
      </Card>
    </li>
  );
}
