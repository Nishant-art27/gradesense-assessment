import type { ReactNode } from 'react';
import type { GradingSummary } from '@gradesense/shared';
import { Badge } from './ui/Badge.js';
import { Button } from './ui/Button.js';
import { Card, CardButton } from './ui/Card.js';
import { EmptyState, MicroLabel, PillLabel, Skeleton } from './ui/misc.js';
import { IconCeiling, IconQuote, IconSealed, IconSum } from './ui/icons.js';

/**
 * The landing screen, shown before anything is loaded.
 *
 * It does two jobs at once: it explains what the tool actually guarantees, and
 * it gets a reviewer to a marked paper in one click. The sample cards carry
 * their expected score, so the promise on the card can be checked against the
 * result immediately — which is a more convincing demo than a generic
 * "Get started" button.
 */

interface SampleMeta {
  title: string;
  blurb: string;
  score: string;
}

const SAMPLES: Record<string, SampleMeta> = {
  'student-answer': {
    title: 'Partially correct',
    blurb: 'The flagship paper. Real physics beside a voltmeter wired in series, a formula written backwards, and a graph with swapped axes.',
    score: '7.5 / 15',
  },
  'fully-correct': {
    title: 'Fully correct',
    blurb: 'Every rubric point met. Proves the grader awards full marks instead of inventing deductions.',
    score: '15 / 15',
  },
  incorrect: {
    title: 'Confidently wrong',
    blurb: 'Wrong throughout — yet every deduction still quotes the student verbatim.',
    score: '0 / 15',
  },
  blank: {
    title: 'Blank paper',
    blurb: 'Headings written, nothing answered. Scored without ever calling the model.',
    score: '0 / 15',
  },
  'ocr-errors': {
    title: 'Bad scan',
    blurb: 'Correct content mangled by OCR. Content still credited; character damage flagged separately.',
    score: '15 / 15',
  },
};

/**
 * Demo order, not alphabetical order.
 *
 * The API returns the sample slugs sorted, which puts "blank" — a paper with
 * nothing on it and no annotations — first. That is the least convincing thing
 * to show someone opening the app. The flagship paper leads, then the two clean
 * ends of the range, then the two edge cases.
 */
const SAMPLE_ORDER = ['student-answer', 'fully-correct', 'incorrect', 'ocr-errors', 'blank'];

function inDemoOrder(samples: string[]): string[] {
  const rank = (slug: string) => {
    const index = SAMPLE_ORDER.indexOf(slug);
    return index === -1 ? SAMPLE_ORDER.length : index;
  };
  return [...samples].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const GUARANTEES: Array<{ label: string; detail: string; icon: ReactNode }> = [
  {
    label: 'Marks never exceed the maximum',
    detail: 'Every criterion is clamped, and the correction is logged.',
    icon: <IconCeiling />,
  },
  {
    label: 'Totals are recomputed, never trusted',
    detail: 'The model is never even asked for a total.',
    icon: <IconSum />,
  },
  {
    label: 'Every judgement quotes the student',
    detail: 'A quote that is not in the answer loses its annotation.',
    icon: <IconQuote />,
  },
  {
    label: 'The original is never modified',
    detail: 'Export builds a copy; a test hashes the file to prove it.',
    icon: <IconSealed />,
  },
];

export function LandingHero({
  samples,
  history,
  historyLoading,
  busy,
  onPick,
  onOpen,
  onUpload,
  onSetup,
}: {
  samples: string[];
  history: GradingSummary[];
  historyLoading: boolean;
  busy: boolean;
  onPick: (slug: string) => void;
  onOpen: (id: string) => void;
  onUpload: (file: File) => void;
  onSetup: () => void;
}) {
  return (
    /* The outer element carries the full-bleed ambient wash; the inner one holds
       the content column. Without the split, the wash paints only inside the
       1180px column and its edges show as a rectangle on the ground. */
    <div className="landing">
      <div className="landing__inner">
      <section className="hero">
        <PillLabel>
          <span className="badge__dot badge__dot--live" aria-hidden="true" />
          Explainable marking · runs with no API key
        </PillLabel>

        <h1 className="hero__title">
          Marking you can
          <span>actually check</span>
        </h1>

        <p className="hero__lede">
          GradeSense reads a student answer, marks it against the rubric, and draws every mistake on
          the paper itself — with the quote it based the decision on. Then it lets a teacher move,
          rewrite or delete any of it without re-grading a thing.
        </p>

        <div className="hero__actions">
          <Button variant="primary" size="lg" disabled={busy} onClick={onSetup}>
            Set up an exam
          </Button>
          <Button
            variant="glass"
            size="lg"
            disabled={busy || !samples.includes('student-answer')}
            onClick={() => onPick('student-answer')}
          >
            Mark the sample paper →
          </Button>
        </div>

        <p className="hero__hint">
          <strong>Set up an exam</strong> takes the question paper, marking scheme and student answer, and
          reads the rubric out of the scheme. <strong>Mark the sample paper</strong> skips straight to a
          graded script using the paper provided with this assignment.
        </p>

        <ul className="guarantees">
          {GUARANTEES.map((item) => (
            <li key={item.label}>
              <Card glass pad="md" className="guarantee">
                <span className="icon-tile">{item.icon}</span>
                <div>
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <section className="section">
        <header className="section__head">
          <PillLabel>Sample papers</PillLabel>
          <h2>Pick a paper</h2>
          <p>
            Each one exercises a different failure the system has to handle. Or{' '}
            <label className="file-link">
              upload an answer PDF
              <input
                type="file"
                accept="application/pdf"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onUpload(file);
                  event.target.value = '';
                }}
              />
            </label>{' '}
            to mark against the built-in rubric.
          </p>
        </header>

        {samples.length === 0 ? (
          <div className="sample-grid">
            {[0, 1, 2, 3].map((index) => (
              <Card key={index} pad="md" className="sample">
                <Skeleton height={26} width="55%" />
                <Skeleton height={14} width="70%" />
                <Skeleton height={38} />
              </Card>
            ))}
          </div>
        ) : (
          <div className="sample-grid">
            {inDemoOrder(samples).map((slug) => {
              const meta = SAMPLES[slug] ?? {
                title: slug,
                blurb: 'An uploaded answer paper.',
                score: '—',
              };
              return (
                <CardButton
                  key={slug}
                  glass
                  className="sample"
                  disabled={busy}
                  onClick={() => onPick(slug)}
                >
                  <span className="sample__score">{meta.score}</span>
                  <h3>{meta.title}</h3>
                  <p>{meta.blurb}</p>
                  {/* The filename is provenance, not headline — it sits at the
                      foot so the score never has to share a line with it. */}
                  <span className="sample__file">{slug}.pdf</span>
                </CardButton>
              );
            })}
          </div>
        )}
      </section>

      <section className="section">
        <header className="section__head">
          <PillLabel>History</PillLabel>
          <h2>Recently marked</h2>
          <p>Saved results, with the annotations exactly as they were left.</p>
        </header>

        {historyLoading ? (
          <Card pad="md">
            <Skeleton height={20} />
          </Card>
        ) : history.length === 0 ? (
          <EmptyState title="Nothing marked yet">
            Mark a sample paper or set up an exam, and every result will be saved here with its
            annotations.
          </EmptyState>
        ) : (
          <div className="history">
            {/* Each header cell carries its column's class so the responsive rules
                that drop columns hide the heading with the data. Without them the
                header kept five cells over a two-column grid and wrapped. */}
            <div className="history__row history__head">
              <span className="history__name">
                <MicroLabel>Paper</MicroLabel>
              </span>
              <span className="history__score">
                <MicroLabel>Mark</MicroLabel>
              </span>
              <span className="history__conf">
                <MicroLabel>Conf.</MicroLabel>
              </span>
              <span className="history__flag">
                <MicroLabel>Flag</MicroLabel>
              </span>
              <span className="history__when">
                <MicroLabel>Marked</MicroLabel>
              </span>
            </div>
            {history.slice(0, 6).map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="history__row"
                onClick={() => onOpen(entry.id)}
              >
                <span className="history__name">{entry.studentAnswerFilename}</span>
                <span className="history__score">
                  {entry.totalMarks}
                  <em>/{entry.maxMarks}</em>
                </span>
                <span className="history__conf">{Math.round(entry.confidence * 100)}%</span>
                <span className="history__flag">
                  {entry.requiresHumanReview ? (
                    <Badge tone="accent">review</Badge>
                  ) : (
                    <Badge tone="success">clear</Badge>
                  )}
                </span>
                <span className="history__when">{new Date(entry.createdAt).toLocaleString()}</span>
              </button>
            ))}
          </div>
        )}
      </section>
      </div>
    </div>
  );
}
