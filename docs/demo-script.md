# 2-minute demo script

A timed shot list for the submission video. Everything below is real behaviour — no
setup beyond the two commands.

**Before recording**

```bash
npm run seed
npm run dev
```

Open `http://localhost:5173`, browser at ~1500px wide, and clear any earlier history
(`rm -rf data`) so the screen starts clean.

---

### 0:00 – 0:15 · What it is

> "This is GradeSense. It reads a student answer, marks it against the rubric, and shows
> the mistakes on the paper itself. Everything you'll see runs with no API key — the
> default grader is deterministic, so the whole thing is reproducible."

Point at the **"deterministic mock · no API key needed"** badge in the header.

### 0:15 – 0:40 · Marking a paper

Click **student-answer**.

> "That's a paper I wrote with deliberate mistakes in it. It scores 7.5 out of 15 —
> which is exactly what the error key predicts, and what the test suite asserts."

Scroll the rubric panel.

> "Every rubric point shows the mark, the reasoning, and the quote from the student it
> rests on. This one — the voltmeter connected in series instead of parallel — loses the
> mark, and here's the exact sentence it's based on."

### 0:40 – 1:05 · Annotations in the right place

Point at the boxes on the paper.

> "Each finding is drawn where the problem actually is. That's not a guess: at upload we
> index every run of text in the PDF with its coordinates, so a quote from the model maps
> back to real rectangles — even a phrase inside a line."

Scroll to page 2, point at the graph.

> "A diagram has no text to quote, so the model gives an approximate region instead. It's
> marked as approximate and it costs confidence, because it's a rougher signal."

### 1:05 – 1:35 · Editing without re-grading

Click a box → editor opens. Drag it. Retype the correction. Click **+ Add annotation** and
draw one.

> "A teacher can move these, rewrite them, delete them, or add their own. The score never
> changes and nothing is re-graded — annotations are stored separately from the marks.
> There's a test that asserts the model is never called again during any of this."

Point at the unchanged **7.5**.

### 1:35 – 1:50 · Being honest about uncertainty

Point at the review banner.

> "Question 3 was marked at 61% confidence, so the paper is flagged. Confidence isn't the
> model's opinion of itself — it's computed from what we could verify."

Expand **Automatic corrections applied**.

> "And anywhere the system had to overrule the grader — a mark clamped into range, a
> quote that didn't check out — it's recorded here rather than hidden."

### 1:50 – 2:00 · Export, and reliability

Click **Export annotated PDF**, open it briefly to show the numbered marks and the summary
sheet.

> "The export is a copy — the original is never modified, and there's a test that hashes
> it to prove it. Blank papers, malformed model output, API outages and scores over the
> maximum are all handled and all tested: 106 tests, no API key."

---

## If there is time for a second take

Two things worth showing that don't fit in two minutes:

- **`blank`** — scores 0 and is flagged, and the model is never called at all.
- **`ocr-errors`** — the same content as the correct paper run through a bad scan.
  Still 15/15, with the character damage annotated as spelling rather than deducted.
  It's the clearest demonstration that the grader reads meaning, not surface form.
