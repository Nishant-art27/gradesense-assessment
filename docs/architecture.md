# Architecture

## The problem this shape solves

Producing a score is the easy part. The hard part is producing a score a teacher can
*check* — where every mark traces to a rubric point, every rubric point traces to a
quote, and every quote traces to a rectangle on the page. Almost every decision below
follows from that, plus one more: **a language model is an untrusted input.** It is
good at judgement and bad at arithmetic, and it will occasionally invent a quote. So
the pipeline treats its output the way a web server treats a request body — parse,
validate, clamp, and never trust a number it could have computed itself.

## Layout

```
packages/
  shared/   Zod schemas + types. One contract, imported by both sides.
  server/   Express API, ingest, grading pipeline, persistence, PDF export.
  web/      React viewer, annotation overlay, rubric panel.
scripts/    Authors the five student answer PDFs (pdfkit).
fixtures/   rubric.json + the generated answer papers.
```

`packages/shared` matters more than its size suggests. The model output schema, the
result schema and the API request/response shapes all live there, so the server
validates against exactly the types the client consumes. A field renamed in one place
fails to compile in the other.

## The path a paper takes

```
 upload (raw PDF bytes)
        │
        ▼
 ingest ──────────  pdf.js text layer → per-run rectangles + char offsets
        │           (this index is what makes annotation anchoring possible)
        ▼
 segment ─────────  split on "Answer 1 / 2 / 3" headings
        │
        ▼
 blank check ─────  empty question? → 0 marks, flagged, NO model call
        │
        ▼
 grade, per question ── model sees: rubric + guidance + model answer
        │              + the student's text + the whole PDF (so it can
        │              see the diagram)
        ▼
 ┌─────────────────────────────────────────────────┐
 │  VALIDATE — the part that makes it trustworthy  │
 │   · Zod parse, one repair retry on failure      │
 │   · clamp every mark into [0, max]              │
 │   · recompute the total; never take the model's │
 │   · verify every quote exists in the answer     │
 │   · derive confidence arithmetically            │
 └─────────────────────────────────────────────────┘
        │
        ▼
 anchor ──────────  quote → char range → rectangles
        │
        ▼
 persist ─────────  result + annotations (separate collections)
```

## Five decisions worth explaining

### 1. Grade one question at a time

Three model calls instead of one. It costs more, and it buys three things: the prompt
carries a single rubric so attention is not split; an unanswered question skips the
model entirely; and malformed output for Q2 cannot corrupt Q1 and Q3. The shared parts
of the prompt sit behind a cache breakpoint, so the answer PDF is paid for once rather
than three times.

### 2. Anchoring is a three-tier fallback that degrades honestly

The model returns evidence as a quote. Turning that back into a box on the page is the
hardest part of the build:

1. **Text** — pdf.js gives every run of text a rectangle. At ingest we build a
   character-offset → rectangle index. A quote is located in the page text (exactly,
   then fuzzily) and its character range is converted back to boxes. Because PDF
   producers emit a whole *line* as one positioned run, a phrase inside a line has no
   rectangle of its own — its box is interpolated across the line using per-character
   widths, so underlining six words of a line highlights six words, not the line.
2. **Region** — a diagram has no text to quote. The model can return a normalised
   bounding box instead, which is clamped to the page and marked `region`. Vision
   bounding boxes are approximate, so these carry a confidence penalty and say
   "check the position" in the UI.
3. **Unresolved** — if a quote matches nothing, the annotation becomes a margin note
   and is flagged. **We never guess a position.** A box drawn on the wrong words is
   worse for a teacher than an honest note in the margin.

### 3. Fuzzy matching needs a per-token floor, not just an average

This was the subtlest bug in the build and it is worth recording. Matching a phrase by
*mean* token similarity tolerates OCR damage nicely — but it also matched
"the ammeter is connected in parallel across the bulb" against the **correct** sentence
"the voltmeter is connected in parallel across the bulb", because one substituted word
out of nine still averages 0.96. The grader marked a correct answer wrong.

The fix has two parts, in `text-match.ts`:

- **OCR folding** normalises the confusions a scanner actually makes (`rn`→`m`,
  the `i`/`l`/`1`/`I` family) *before* comparing, so scan damage costs nothing.
- **A per-token floor** rejects the whole window if any single token falls below it.

Together they separate the two cases cleanly: "arnmeter" still matches "ammeter",
while "voltmeter" no longer matches "ammeter" and "left" no longer matches "right".
Meaning does not average out. `text-match.test.ts` pins both directions down.

### 4. Confidence is arithmetic, not the model's opinion

`confidence.ts` starts from the model's self-reported certainty and then **caps it by
what was actually verified**. If three quotes were cited and one exists, no amount of
self-assurance survives. Clamped marks, repair retries, unreturned criteria, very short
answers, unresolved anchors and approximate regions each subtract a documented amount.

Two payoffs: it is explainable — every deduction comes back as a sentence the UI shows
under "Why the confidence is 61%" — and it is testable, because the same inputs always
give the same number. A model that says "0.99" about a paper it misread cannot talk its
way past it.

The review flag is separate and deliberately trigger-happy: below-threshold confidence,
*or* any blank question, *or* any ungraded question, *or* any clamped mark, *or* any
unverified quote, *or* a single question below threshold even when the paper average
looks fine. Every reason is recorded in plain language, because "needs review" without
a reason just moves the problem to the teacher.

### 5. Annotations are a separate collection

This is what makes "edit without re-grading" structurally true rather than a promise.
Annotations live in their own store keyed by result id. The three annotation endpoints
can move a box, retype a correction and delete a note; none of them can reach a mark,
because marks only exist inside the grading result. The API test asserts the literal
property — that the model is never called again — and the UI test confirms only one
`POST /api/grade` fires across an entire editing session.

## Reliability, case by case

| Failure | What happens |
|---|---|
| Blank answer | Detected before any model call. Zero marks, `blank` state, review flagged — a zero we could not confirm must not look like a zero the student earned. |
| Marks above the maximum | Every criterion clamped to `[0, max]`; total recomputed from the clamped values; both corrections written to the audit trail; paper flagged. |
| Malformed output | One repair retry with the validation errors fed back. Still bad → the question becomes `ungraded` (0 marks so the arithmetic stays consistent, but visibly *not* a judgement). |
| Model / API outage | Retry with exponential backoff on 429 / 5xx / connection errors, then a structured **503**. Nothing partial is persisted — a half-marked paper in the history is a trap. |
| Fabricated evidence | The quote is checked against the answer. If absent: citation marked unverified, its annotation dropped, confidence collapsed, review demanded. The mark itself stands, because silently *raising* a score would be its own failure. |
| Corrupt / non-PDF upload | Rejected at the boundary with a typed error code the UI can branch on. |

## Choices a reviewer might question

**A JSON file store, not SQLite.** The brief allows "any local database or simple
persistence method". A native database driver is the most likely thing to break
`npm install` on someone else's machine, and persistence is not what this assignment is
testing. Writes are atomic (temp file + rename) and serialised through a promise chain
so concurrent requests cannot clobber each other. It sits behind a `Repository`
interface, so swapping in SQLite is a one-file change.

**A rule-based mock as the default provider.** There is no API key in this environment,
so the app and its whole test suite must run without one. The mock is a small
*rule-based examiner* rather than a table of canned responses — it reads the answer
text, matches phrases fuzzily, and quotes the student verbatim. That distinction is
load-bearing: canned responses would make every test pass without the pipeline doing
anything, whereas this exercises clamping, evidence verification, anchoring and
confidence on real input. It is not as good as the real model. It is *deterministic*,
which is what a test suite needs.

**The student answer is a typed PDF, not a scan.** The brief asks for a realistic
written answer, not a handwriting-OCR pipeline. Generating it keeps the text layer
intact — which is what makes accurate anchoring possible — and lets all five variants
share one layout pipeline with precise, reproducible flaws. The OCR test case covers
the scanned-input concern at the level that matters here: character damage.

**Raw PDF upload instead of multipart.** The client always sends exactly one file, so
`express.raw({ type: 'application/pdf' })` removes a dependency and a class of edge
cases for no loss.

**Numbered marks on the page, full text on a summary sheet.** The first version of the
PDF export wrote each correction beside its box. On a densely marked paper that produced
overlapping red text across the student's own writing and made both unreadable. Numbering
the marks and keying them to a list is how a teacher actually annotates a script, and it
stays legible however many findings there are.

## What I would do next

- **Real-model evaluation.** The mock proves the pipeline; it cannot tell you whether
  the *marking* is good. The next step is running the five papers plus a set of human-
  marked scripts through the live model and measuring agreement per criterion — with
  particular attention to the three judgement calls flagged in the error key.
- **Better diagram grading.** Region hints from a vision model are approximate. Asking
  for a structured description of the circuit (components and their connections) and
  checking *that* against the rubric would grade the diagram on its electrical
  relationships rather than its appearance.
- **Rubric extraction from the uploaded marking scheme.** Today the rubric is a
  validated checked-in transcription, chosen so marks do not depend on how well an
  extraction step went that day. Extracting it with the model, then requiring a human
  to confirm the arithmetic before it is used, would generalise to any paper.
- **Teacher mark overrides.** Annotations are editable; marks are not. Letting a teacher
  change a criterion mark — with the original preserved and the change attributed — is
  the obvious next feature, and the audit trail already has the shape for it.
