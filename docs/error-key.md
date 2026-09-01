# Error key — `fixtures/answers/student-answer.pdf`

Every mistake in the flagship student answer is deliberate. This is the key: what
was planted, where it is, what the student should have written, and which rubric
point it is designed to hit.

The paper is written to be **difficult but believable**. It is not randomly wrong.
It gets a fair amount right, and the errors are the kind a real Class-X student
makes — a meter connected the wrong way, a formula transcribed backwards while the
reasoning behind it is sound, an opposing viewpoint acknowledged in one line and
then abandoned, shortage and surplus swapped.

**Expected total: 7.5 / 15.** `pipeline.test.ts` asserts this exact figure and each
criterion below, so the key and the system cannot silently drift apart.

Author: "Aarav Menon", Roll No X-B / 24. Source: [`scripts/answer-content.ts`](../scripts/answer-content.ts).

---

## Question 1 — Science (2.5 / 5)

| # | Planted mistake | Where | Should have been | Criterion | Mark |
|---|---|---|---|---|---|
| 1.1 | **Voltmeter described as connected *in series* with the bulb**, and the diagram wires it that way too. | Para 2, last sentence + circuit diagram | The voltmeter is connected **in parallel across the bulb**, so it measures the potential difference between the bulb's two ends. | q1c2 | 1 → **0** |
| 1.2 | **Ohm's law written as `V = I/R`** — but the surrounding sentence reasons *correctly* that raising resistance lowers current. | Para 3 | `V = IR`, which rearranges to `I = V / R`. | q1c4 | 1 → **0.5** |
| 1.3 | **No conventional current direction** anywhere — no arrow on the diagram, no mention in the prose. | Diagram | Arrow from the battery's positive terminal around the external circuit. | q1c5 | 1 → **0** |
| 1.4 | **Diagram overflows the right margin**, and the "ameter" label collides with the wire. | Diagram | Keep the drawing and its labels inside the margins. | q1c5 (same mark) | — |
| 1.5 | Third paragraph is **indented out of alignment** with the rest. | Para 3 | Consistent left alignment. | presentation only | — |

**Correct, and credited:** closed-path definition, battery as the source of potential
difference, switch opening and closing the circuit, and the series arrangement of
battery / switch / resistor / bulb (q1c1 = 1, q1c3 = 1).

Spelling planted: `circut` → circuit, `potencial` → potential, `ameter` → ammeter,
`resistence` → resistance. **These cost no marks** — no Q1 criterion awards marks for
spelling — but each is annotated separately.

## Question 2 — English (3 / 5)

This answer deliberately argues the **opposite** of the model answer: that technology
makes students dependent. The marking scheme is explicit that a student "does not have
to reach the same conclusion" and can still score 5/5. So the marks lost here are lost
on **quality of reasoning**, never on disagreement — which is the point of the question
as a test of the grading system.

| # | Planted mistake | Where | Should have been | Criterion | Mark |
|---|---|---|---|---|---|
| 2.1 | **Opposing viewpoint reduced to one bare line** — "Some people say that technology is helpful." — then dropped. | Para 3 | Two or three sentences engaging with the strongest version of that view, then why the student still disagrees. | q2c3 | 1 → **0** |
| 2.2 | **Sweeping unsupported claim** in place of an example: "Everybody knows that students just copy from the internet…", "every single school". | Para 2 | A specific example: a student copies a worked solution, passes the homework, then cannot attempt a similar problem in a test. | q2c4 | 1 → **0** |
| 2.3 | Grammar: **"Students is"** | Para 2 | "Students are" | none | — |
| 2.4 | Grammar: **"alot"** | Para 2 | "a lot" | none | — |
| 2.5 | Grammar: **"there phone"**, **"there brain"** | Para 1 | "their phone", "their brain" | none | — |
| 2.6 | **Run-on sentence** spanning most of paragraph 2. | Para 2 | Split into two or three sentences. | none | — |

**Correct, and credited:** a clear position stated up front, a developed argument
(the library-versus-search contrast), and a conclusion that follows from it
(q2c1 = 1, q2c2 = 1, q2c5 = 1).

## Question 3 — Economics (2 / 5)

| # | Planted mistake | Where | Should have been | Criterion | Mark |
|---|---|---|---|---|---|
| 3.1 | **Graph axes swapped** — price on the horizontal axis, quantity on the vertical — and **neither axis labelled**. | Graph, page 2 | Quantity horizontal, price vertical, both labelled. | q3c1 | 1 → **0** |
| 3.2 | **Shortage and surplus reversed**: "below the equilibrium price there is a surplus… above the equilibrium price there is a shortage". | Para 3 | Below equilibrium: demand exceeds supply → **shortage**, pushing price up. Above: supply exceeds demand → **surplus**, pushing price down. | q3c3 | 1 → **0** |
| 3.3 | **New equilibrium never stated.** The answer stops at "the supply curve will shift towards the left side". | Para 4 | The new supply curve meets unchanged demand at a **higher price and lower quantity**; show the new intersection. | q3c5 | 1 → **0** |
| 3.4 | Final paragraph **indented out of alignment**. | Para 4 | Consistent alignment. | presentation only | — |

**Correct, and credited:** equilibrium correctly identified at ₹30 / 60 units with the
right reason, and the leftward supply shift from higher production costs
(q3c2 = 1, q3c4 = 1).

---

## Summary

| Question | Awarded | Available |
|---|---|---|
| Q1 Science | 2.5 | 5 |
| Q2 English | 3 | 5 |
| Q3 Economics | 2 | 5 |
| **Total** | **7.5** | **15** |

Three mistakes are deliberately **judgement calls** rather than clear-cut errors, and
they are the ones worth watching when the system runs against a real model:

- **1.2** — notation wrong, reasoning right. Half credit is defensible; so is full or
  zero. A grader that gives zero here is marking form over understanding.
- **2.1** — the opposing view *is* mentioned. Whether one sentence counts as
  "meaningfully addresses" is exactly the kind of call a human examiner makes.
- **2.2** — the paragraph is genuinely argued, just not evidenced. Losing only the
  examples mark, and not the arguments mark, is the fine distinction being tested.

## The other test papers

| File | Purpose | Expected |
|---|---|---|
| `fully-correct.pdf` | Every rubric point met | 15 / 15, no annotations, no review flag |
| `incorrect.pdf` | Confidently wrong throughout | 0 / 15, every deduction still quote-backed |
| `blank.pdf` | Headings written, nothing answered | 0 / 15, **no model call at all**, review flagged |
| `ocr-errors.pdf` | Correct content through a bad scan | 15 / 15, misspellings annotated but not deducted |

`ocr-errors.pdf` is the same content as `fully-correct.pdf` with single-character OCR
confusions applied — `m` read as `rn`, `l` as `1` or `I`. It exists to prove the grader
credits meaning rather than surface form, and that quote anchoring survives the damage.
