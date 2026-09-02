# recording_sample

Demo bundle for a GradeSense walkthrough. Three questions, one marking scheme, one
answer script — enough to show the whole grade-and-annotate loop on real board-exam
material.

Source: CBSE Class XII **Physics (042)**, board examination **2026**, Q.P. code
**55/1/1** (Series QPSR1, Set 1), held 20 February 2026.

| File | What it is |
| --- | --- |
| `question-paper.pdf` | Section E, questions 31–33, verbatim (5 marks each, both options of each internal choice). |
| `marking-scheme.pdf` | The award list and value points for those three questions, transcribed from the official CBSE marking scheme for 55/1/1. |
| `student-answer.pdf` | A candidate script answering the main option of all three, on ruled paper in a handwriting face. |

## Why these three questions

They are the paper's three long-answer questions, and between them they cover the
two things a grader has to get right: a **derivation** marked step by step (dipole
field, lens maker's formula, self-inductance) and a **numerical** where marks hang
on substitution and units (force and torque on a dipole, a three-lens image
distance, the emf of a rotating rod).

## About the student answer

No genuine student script for the 2026 paper is published anywhere, so this one is
authored. It is deliberately imperfect — each question carries an error of a kind
the marking scheme actually penalises, so a grading pass has something to find:

| Question | What the candidate did | Marking-scheme consequence |
| --- | --- | --- |
| 31 (a) | Derives the equatorial field correctly but never states that **E** is antiparallel to **p**. | Loses the ½ for direction. |
| 31 (b) | Net force 0 N is right; then reads "placed in x-y plane" as **p** ⟂ **E** and takes θ = 90°, giving τ = 2q(b − a) N m instead of 0. | Keeps ½ for the formula, loses the rest of the torque mark. |
| 32 (a) | Full derivation, but jumps to 1/f without the "object at infinity" justification. | Loses ½. |
| 32 (b) | v₁, v₂, v₃ all correct; then adds 120 + 20 + 40 and drops the 80 cm object distance — 180 cm instead of 260 cm. | Loses the final ½. |
| 33 (a), (b) | Faraday's law and L = μ₀N²A/l both fully correct. | Full 3. |
| 33 (c) | Right formula, but uses ω = 60 rad/s without converting 60 rpm to 2π rad/s — 30 mV instead of 3.14 mV. | Keeps ½ for the formula, loses the substitution and answer marks. |

Marked against the scheme, the script comes to roughly **11½ / 15**.

## Regenerating

```
npm run seed:recording
```

Runs [`scripts/generate-recording-sample.ts`](../scripts/generate-recording-sample.ts),
which rebuilds all three PDFs in place. The handwriting jitter is seeded, so the
output is byte-stable across runs. The script embeds Times New Roman and Bradley
Hand from `/System/Library/Fonts/Supplemental`, so it needs macOS.
