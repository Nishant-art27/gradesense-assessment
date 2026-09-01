import type { GradingSummary } from '@gradesense/shared';

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
  tone: 'mixed' | 'good' | 'bad' | 'empty';
}

const SAMPLES: Record<string, SampleMeta> = {
  'student-answer': {
    title: 'Partially correct',
    blurb: 'The flagship paper. Real physics beside a voltmeter wired in series, a formula written backwards, and a graph with swapped axes.',
    score: '7.5 / 15',
    tone: 'mixed',
  },
  'fully-correct': {
    title: 'Fully correct',
    blurb: 'Every rubric point met. Proves the grader awards full marks instead of inventing deductions.',
    score: '15 / 15',
    tone: 'good',
  },
  incorrect: {
    title: 'Confidently wrong',
    blurb: 'Wrong throughout — yet every deduction still quotes the student verbatim.',
    score: '0 / 15',
    tone: 'bad',
  },
  blank: {
    title: 'Blank paper',
    blurb: 'Headings written, nothing answered. Scored without ever calling the model.',
    score: '0 / 15',
    tone: 'empty',
  },
  'ocr-errors': {
    title: 'Bad scan',
    blurb: 'Correct content mangled by OCR. Content still credited; character damage flagged separately.',
    score: '15 / 15',
    tone: 'good',
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

const GUARANTEES = [
  { label: 'Marks never exceed the maximum', detail: 'Every criterion is clamped, and the correction is logged.' },
  { label: 'Totals are recomputed, never trusted', detail: 'The model is never even asked for a total.' },
  { label: 'Every judgement quotes the student', detail: 'A quote that is not in the answer loses its annotation.' },
  { label: 'The original is never modified', detail: 'Export builds a copy; a test hashes the file to prove it.' },
];

export function LandingHero({
  samples,
  history,
  busy,
  onPick,
  onOpen,
  onUpload,
}: {
  samples: string[];
  history: GradingSummary[];
  busy: boolean;
  onPick: (slug: string) => void;
  onOpen: (id: string) => void;
  onUpload: (file: File) => void;
}) {
  return (
    <div className="landing">
      <div className="landing-aurora" aria-hidden="true">
        <span className="orb orb-1" />
        <span className="orb orb-2" />
        <span className="orb orb-3" />
      </div>

      <section className="hero">
        <div className="hero-badge">
          <span className="pulse-dot" />
          Runs with no API key
        </div>

        <h1 className="hero-title">
          Marking you can
          <span className="gradient-text"> actually check</span>
        </h1>

        <p className="hero-lede">
          GradeSense reads a student answer, marks it against the rubric, and draws every mistake on
          the paper itself — with the quote it based the decision on. Then it lets a teacher move,
          rewrite or delete any of it without re-grading a thing.
        </p>

        <div className="hero-actions">
          <label className={`btn btn-primary btn-lg${busy ? ' disabled' : ''}`}>
            Upload an answer PDF
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
          </label>
          <button
            type="button"
            className="btn btn-ghost btn-lg"
            disabled={busy || !samples.includes('student-answer')}
            onClick={() => onPick('student-answer')}
          >
            Mark the sample paper →
          </button>
        </div>

        <ul className="guarantees">
          {GUARANTEES.map((item, index) => (
            <li key={item.label} style={{ animationDelay: `${140 + index * 70}ms` }}>
              <svg viewBox="0 0 16 16" className="tick" aria-hidden="true">
                <path d="M3 8.5l3.2 3.2L13 5" />
              </svg>
              <div>
                <strong>{item.label}</strong>
                <span>{item.detail}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="sample-section">
        <header className="section-head">
          <h2>Pick a paper</h2>
          <p>Each one exercises a different failure the system has to handle.</p>
        </header>

        <div className="sample-grid">
          {inDemoOrder(samples).map((slug, index) => {
            const meta = SAMPLES[slug] ?? {
              title: slug,
              blurb: 'An uploaded answer paper.',
              score: '—',
              tone: 'mixed' as const,
            };
            return (
              <button
                key={slug}
                type="button"
                className={`sample-card tone-${meta.tone}`}
                disabled={busy}
                onClick={() => onPick(slug)}
                style={{ animationDelay: `${index * 80}ms` }}
              >
                <div className="sample-card-top">
                  <span className="sample-score">{meta.score}</span>
                  <span className="sample-file">{slug}.pdf</span>
                </div>
                <h3>{meta.title}</h3>
                <p>{meta.blurb}</p>
                <span className="sample-go">Mark it →</span>
              </button>
            );
          })}
        </div>
      </section>

      {history.length > 0 && (
        <section className="recent-section">
          <header className="section-head">
            <h2>Recently marked</h2>
            <p>Saved results, with the annotations exactly as they were left.</p>
          </header>
          <div className="recent-list">
            {history.slice(0, 6).map((entry) => (
              <button key={entry.id} type="button" className="recent-row" onClick={() => onOpen(entry.id)}>
                <span className="recent-name">{entry.studentAnswerFilename}</span>
                <span className="recent-score">
                  {entry.totalMarks}<em>/{entry.maxMarks}</em>
                </span>
                <span className="recent-conf">{Math.round(entry.confidence * 100)}%</span>
                {entry.requiresHumanReview && <span className="chip-review">review</span>}
                <span className="recent-when">{new Date(entry.createdAt).toLocaleString()}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
