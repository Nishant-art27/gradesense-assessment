import type { FindingKind } from '@gradesense/shared';

/**
 * Marking rules for the mock grader, one per rubric criterion.
 *
 * A string matcher is compared fuzzily (see `text-match.ts`), so OCR damage such
 * as "vo1tmeter" or "quantlty" still matches. A RegExp matcher is applied to the
 * raw text, for the cases normalisation would erase — "V = IR" and "V = I/R"
 * are indistinguishable once punctuation is stripped, and that distinction is
 * exactly what one of the planted mistakes turns on.
 */

export type Matcher = string | RegExp;

export interface Signal {
  match: Matcher;
  comment: string;
  correction: string;
}

export interface MockRule {
  criterionId: string;
  /**
   * The criterion this rule was written for, verbatim.
   *
   * Rules used to be looked up by id alone, which was a real bug: every
   * extracted rubric numbers its criteria q1c1, q1c2, … so a history paper's
   * first criterion picked up the physics rule and a correct answer about the
   * Treaty of Versailles came back marked "the answer never establishes that the
   * circuit is a closed series path". Matching on the wording as well means a
   * rule can only ever fire on the criterion it actually describes.
   */
  criterionDescription: string;
  /** A substantive error. Forces zero and an anchored annotation. */
  faults: Signal[];
  /** Evidence the criterion is met. */
  awards: Matcher[];
  /** Present alongside credit: right idea, specific flaw. Halves the marks. */
  partials: Signal[];
  /** An attempt too thin to earn the mark. Zero, but still anchored. */
  weak: Signal[];
  awardReasoning: string;
  /** Optional note shown when the criterion is fully met. */
  praise?: string;
  missing: {
    comment: string;
    correction: string;
    /**
     * For diagram criteria: where to draw the annotation when there is no text
     * to quote.
     *
     * `caption` is the heading the student wrote above the drawing. The region
     * is measured from where that caption and the drawing's own labels actually
     * sit on the page — hardcoded coordinates were wrong on both diagrams here,
     * missing the top of one and running into the next answer.
     *
     * `fallback` is used only when the caption cannot be found. `on` says which
     * page it applies to, described relative to the answer rather than as an
     * absolute index, so a paper of a different length still lands right.
     */
    diagramRegion?: {
      caption: string;
      fallback: {
        on: 'answer-start' | 'document-end';
        x: number;
        y: number;
        width: number;
        height: number;
      };
    };
  };
}

export const MOCK_RULES: Record<string, MockRule> = {
  /* ------------------------------- Q1 Science ------------------------------ */

  q1c1: {
    criterionId: 'q1c1',
    criterionDescription:
      'Correctly represents the main circuit with battery, switch, bulb and resistor connected in a closed series path',
    faults: [
      {
        match: 'an electric circuit is an open path',
        comment: 'A circuit must be a closed path. Current cannot jump across a gap in the wire.',
        correction:
          'An electric circuit is a closed conducting path; current only flows when the path is complete.',
      },
      {
        match: 'All the components must be connected in parallel',
        comment:
          'The main circuit is a series loop, not a parallel one. Connecting in parallel does not make the current "stronger".',
        correction:
          'The battery, switch, resistor, bulb and ammeter are connected in series in one closed loop.',
      },
    ],
    awards: [
      'closed conducting path along which electric current can flow',
      'closed path which allows the electric current to flow',
      'joined one after another in series in the main circuit',
      'connected in series in the main circuit',
    ],
    partials: [],
    weak: [],
    awardReasoning:
      'The main circuit is correctly described as a closed series loop containing the battery, switch, resistor and bulb.',
    missing: {
      comment: 'The answer never establishes that the circuit is a closed series path.',
      correction:
        'State that the battery, switch, resistor and bulb form a single closed loop, so the same current passes through each.',
    },
  },

  q1c2: {
    criterionId: 'q1c2',
    criterionDescription:
      'Correct placement of ammeter in series and voltmeter in parallel across the bulb',
    faults: [
      {
        match: 'The ammeter is connected in parallel across the bulb',
        comment:
          'The meters are the wrong way round. An ammeter measures the current through the circuit, so it goes in series; a voltmeter measures potential difference across a component, so it goes in parallel.',
        correction:
          'Connect the ammeter in series in the main loop, and the voltmeter in parallel across the bulb.',
      },
      {
        match: 'The voltmeter is also connected in series with the bulb',
        comment:
          'A voltmeter must be connected in parallel across the bulb, not in series with it. In series it would carry the circuit current and could not measure the potential difference across the bulb. The diagram repeats this error.',
        correction:
          'Connect the voltmeter in parallel across the bulb, so it measures the potential difference between the bulb\'s two ends.',
      },
    ],
    awards: ['voltmeter is connected in parallel across the bulb'],
    partials: [],
    weak: [],
    awardReasoning:
      'The ammeter is correctly placed in series and the voltmeter in parallel across the bulb, with the reason for each given.',
    missing: {
      comment: 'The answer does not say where the ammeter and voltmeter are connected.',
      correction:
        'Say that the ammeter goes in series because it measures current, and the voltmeter in parallel across the bulb because it measures potential difference.',
    },
  },

  q1c3: {
    criterionId: 'q1c3',
    criterionDescription:
      'Correct explanation of current flow and the function of the main components',
    faults: [
      {
        match: 'The battery stores the current inside it',
        comment:
          'A battery does not store current and release it. It provides the potential difference that drives a current around the circuit.',
        correction:
          'The battery supplies the potential difference that drives the current; the switch completes or breaks the path.',
      },
    ],
    awards: [
      'battery supplies the potential difference that drives the current',
      'battery is the source which gives the potential difference',
      'switch is used to make the circuit open or close',
      'switch is used to open or close that path',
    ],
    partials: [],
    weak: [],
    awardReasoning:
      'The functions of the battery and switch, and the path the current follows when the switch is closed, are correctly explained.',
    missing: {
      comment: 'The roles of the battery and the switch in driving and interrupting the current are not explained.',
      correction:
        'Explain that the battery provides the potential difference and the switch opens or closes the conducting path.',
    },
  },

  q1c4: {
    criterionId: 'q1c4',
    criterionDescription:
      'Correctly explains the relationship between resistance and current, including the relevant principle/Ohm\'s law',
    faults: [
      {
        match: 'If we increase the resistance then the current also increases',
        comment:
          'This is the wrong way round. Resistance opposes current, so increasing it at a constant voltage reduces the current.',
        correction:
          'If resistance increases while the voltage stays constant, the current decreases — by Ohm\'s law, I = V / R.',
      },
      {
        match: /V\s*=\s*I\s*\+\s*R/i,
        comment: "Ohm's law is not V = I + R. Voltage is the product of current and resistance, not their sum.",
        correction: "Ohm's law is V = IR.",
      },
    ],
    awards: [
      'the current flowing through the circuit decreases',
      'less current will flow through the circuit',
      'less current will flow',
    ],
    partials: [
      {
        // Raw regex: "V = I/R" and "V = IR" normalise identically once
        // punctuation is stripped, so only a literal match can tell them apart.
        match: /V\s*=\s*I\s*\/\s*R/i,
        comment:
          "The reasoning is right — increasing resistance does reduce the current — but Ohm's law is written incorrectly. V = I/R would mean voltage falls as current rises.",
        correction: "Ohm's law is V = IR, which rearranges to I = V / R.",
      },
    ],
    weak: [],
    awardReasoning:
      "The relationship between resistance and current is correctly explained and tied to Ohm's law.",
    missing: {
      comment: 'The answer does not explain how changing the resistance affects the current.',
      correction:
        'State that at a constant voltage, increasing the resistance decreases the current, because V = IR.',
    },
  },

  q1c5: {
    criterionId: 'q1c5',
    criterionDescription:
      'Clear, logically structured explanation with appropriate labels and current direction in the diagram',
    faults: [],
    awards: ['conventional current direction is marked with an arrow', 'conventional current direction'],
    partials: [],
    weak: [],
    awardReasoning:
      'The explanation is clearly structured, the diagram is labelled, and the conventional current direction is shown.',
    missing: {
      comment:
        'The diagram does not show the conventional current direction, and the answer never mentions it. The diagram also runs past the right-hand margin, with the ammeter label overlapping the wire.',
      correction:
        'Mark an arrow showing conventional current flowing from the positive terminal of the battery around the external circuit, and keep the diagram and its labels inside the margins.',
      diagramRegion: {
        caption: 'Circuit diagram',
        fallback: { on: 'answer-start', x: 0.08, y: 0.33, width: 0.88, height: 0.24 },
      },
    },
  },

  /* ------------------------------- Q2 English ------------------------------ */

  q2c1: {
    criterionId: 'q2c1',
    criterionDescription:
      'Presents a clear position on whether/how technology affects learning',
    faults: [],
    awards: [
      'In my opinion technology has made students very dependent',
      'In my view technology does not automatically make students better or worse learners',
      'In my opinion',
      'In my view',
    ],
    partials: [],
    weak: [
      {
        match: 'Technology is a machine',
        comment:
          'This describes what technology is but never takes a position on whether it helps or harms learning, which is what the question asks.',
        correction:
          'Open with a clear position, for example: "In my view technology helps learning only when it is used to build understanding rather than to replace it."',
      },
    ],
    awardReasoning: 'A clear position on the effect of technology on learning is stated up front.',
    missing: {
      comment: 'The answer never states a position on whether technology helps or harms learning.',
      correction: 'Begin by stating your view clearly, then argue for it.',
    },
  },

  q2c2: {
    criterionId: 'q2c2',
    criterionDescription:
      'Provides relevant and logically developed arguments supporting the position',
    faults: [],
    awards: [
      'Earlier a student had to go to the library and search through many different books',
      'Technology genuinely helps when it is used to build understanding',
    ],
    partials: [],
    weak: [
      {
        match: 'Some students use technology and some students do not use technology',
        comment:
          'This is not an argument — it states that people differ without explaining why that matters or what follows from it.',
        correction:
          'Develop one reason properly: say what technology changes about how students learn, and why that change has the effect you claim.',
      },
    ],
    awardReasoning: 'The position is supported with a developed line of reasoning rather than assertion alone.',
    missing: {
      comment: 'No developed argument is offered in support of a position.',
      correction: 'Give at least one reason for your view and explain the mechanism behind it.',
    },
  },

  q2c3: {
    criterionId: 'q2c3',
    criterionDescription:
      'Recognises and meaningfully addresses an opposing viewpoint or limitation',
    faults: [],
    awards: [
      'However, easy access creates a real risk of dependence',
      'There is also a risk that students may accept inaccurate information',
      'However, having easy access to information can also create a problem',
    ],
    partials: [],
    weak: [
      {
        match: 'Some people say that technology is helpful',
        comment:
          'The opposing viewpoint is mentioned in a single sentence and then dropped. To earn this mark it has to be engaged with — what is the strongest version of that view, and why do you still disagree?',
        correction:
          'Expand this into two or three sentences: acknowledge that technology genuinely helps students who use it to understand rather than to copy, then explain why you think dependence still outweighs that benefit.',
      },
    ],
    awardReasoning: 'An opposing viewpoint or limitation is raised and genuinely engaged with.',
    missing: {
      comment: 'The answer considers only one side and never addresses an opposing viewpoint or limitation.',
      correction:
        'Add a paragraph presenting the strongest case against your position, then explain why your view survives it.',
    },
  },

  q2c4: {
    criterionId: 'q2c4',
    criterionDescription:
      'Uses relevant examples and demonstrates reasoning rather than merely making unsupported claims',
    faults: [
      {
        match: 'Everybody knows that students just copy from the internet and do not learn anything',
        comment:
          'This is an unsupported sweeping claim rather than evidence. "Everybody knows" and "every single school" assert what the argument needs to demonstrate, and no concrete example is given.',
        correction:
          'Replace this with a specific example, such as a student who copies a worked solution, passes the homework, and then cannot attempt a similar problem in a test.',
      },
    ],
    awards: [
      'A student who cannot follow a particular explanation',
      'a student struggling with a difficult scientific concept',
      'For example',
    ],
    partials: [],
    weak: [],
    awardReasoning: 'Concrete examples are used to demonstrate reasoning rather than to assert a conclusion.',
    missing: {
      comment: 'No relevant example is given, so the claims are left unsupported.',
      correction: 'Support each claim with a specific, concrete example a reader could picture.',
    },
  },

  q2c5: {
    criterionId: 'q2c5',
    criterionDescription:
      'Provides a coherent conclusion that follows from the discussion, with clear overall communication',
    faults: [],
    awards: ['So in conclusion I believe that technology is making students dependent', 'I therefore conclude', 'In conclusion'],
    partials: [],
    weak: [],
    awardReasoning: 'The conclusion follows from the argument that precedes it and the answer reads clearly throughout.',
    missing: {
      comment: 'The answer stops without drawing a conclusion from the discussion.',
      correction: 'End with a short paragraph restating your position and what follows from the argument you made.',
    },
  },

  /* ------------------------------ Q3 Economics ----------------------------- */

  q3c1: {
    criterionId: 'q3c1',
    criterionDescription:
      'Correctly plots and labels the demand and supply curves, with appropriate axes and direction',
    faults: [
      {
        match: 'Both the demand curve and the supply curve slope upward',
        comment:
          'The demand curve slopes downward, not upward. Consumers buy less as the price rises, which is what gives demand its negative slope.',
        correction:
          'Draw demand sloping downward from left to right and supply sloping upward, with quantity on the horizontal axis and price on the vertical axis.',
      },
    ],
    awards: [
      'quantity on the horizontal axis and price on the vertical axis',
      'plotted with quantity on the horizontal axis',
    ],
    partials: [],
    weak: [],
    awardReasoning:
      'The axes are the right way round and labelled, and both curves slope in the correct direction.',
    missing: {
      comment:
        'The graph has price on the horizontal axis and quantity on the vertical axis, which is the wrong way round, and neither axis is labelled.',
      correction:
        'Redraw with quantity on the horizontal axis and price on the vertical axis, and label both axes including the units.',
      diagramRegion: {
        caption: 'Demand and supply graph',
        // The graph follows the prose onto the final page rather than sitting
        // where the answer began.
        fallback: { on: 'document-end', x: 0.08, y: 0.23, width: 0.58, height: 0.23 },
      },
    },
  },

  q3c2: {
    criterionId: 'q3c2',
    criterionDescription:
      'Correctly identifies the equilibrium at ₹30 and 60 units and explains why it is equilibrium',
    faults: [
      {
        match: 'The equilibrium is at the price of Rs 50 and the quantity of 100 units',
        comment:
          'Equilibrium is not the largest quantity in the table. It is the price at which quantity demanded equals quantity supplied, which the table gives as Rs 30 and 60 units.',
        correction:
          'Equilibrium is at Rs 30 and 60 units, because that is the only row where quantity demanded equals quantity supplied.',
      },
    ],
    awards: [
      'at the price of Rs 30 and the quantity of 60 units',
      'at a price of Rs 30 and a quantity of 60 units',
    ],
    partials: [],
    weak: [],
    awardReasoning:
      'The equilibrium is correctly identified at Rs 30 and 60 units, with the reason that quantity demanded equals quantity supplied.',
    missing: {
      comment: 'The equilibrium price and quantity are never identified.',
      correction: 'State that the curves intersect at Rs 30 and 60 units, where quantity demanded equals quantity supplied.',
    },
  },

  q3c3: {
    criterionId: 'q3c3',
    criterionDescription:
      'Correctly explains shortage below equilibrium and surplus above equilibrium',
    faults: [
      {
        match: 'When the price is below the equilibrium price there is a surplus in the market',
        comment:
          'Shortage and surplus are the wrong way round. Below equilibrium the price is low, so buyers want more than producers will supply — that is a shortage. A surplus happens above equilibrium.',
        correction:
          'Below equilibrium, quantity demanded exceeds quantity supplied, creating a shortage that pushes the price up. Above equilibrium, quantity supplied exceeds quantity demanded, creating a surplus that pushes the price down.',
      },
    ],
    awards: [
      'quantity demanded exceeds quantity supplied and there is a shortage',
      'This creates a shortage because consumers want to buy more than producers are willing to sell',
    ],
    partials: [],
    weak: [],
    awardReasoning:
      'Shortage below equilibrium and surplus above it are correctly explained, along with the pressure each puts on the price.',
    missing: {
      comment: 'The answer does not explain what happens when the market price moves away from equilibrium.',
      correction:
        'Explain that below equilibrium there is a shortage that pushes the price up, and above it a surplus that pushes the price down.',
    },
  },

  q3c4: {
    criterionId: 'q3c4',
    criterionDescription:
      'Correctly explains that increased production costs shift the supply curve left/upward',
    faults: [
      {
        match: 'the supply curve shifts to the right',
        comment:
          'A rise in production costs shifts supply to the left, not the right. Producers are willing to supply less at every price, not more.',
        correction: 'Higher production costs shift the supply curve to the left (upward).',
      },
    ],
    awards: ['supply curve will shift towards the left', 'supply curve shifts to the left'],
    partials: [],
    weak: [],
    awardReasoning: 'A rise in production costs is correctly shown to shift the supply curve left.',
    missing: {
      comment: 'The effect of higher production costs on the supply curve is not explained.',
      correction: 'State that higher costs make production less profitable at each price, shifting supply to the left.',
    },
  },

  q3c5: {
    criterionId: 'q3c5',
    criterionDescription:
      'Correctly explains the resulting tendency toward a higher equilibrium price and lower equilibrium quantity, with the change represented appropriately on the graph',
    faults: [
      {
        match: 'the equilibrium price becomes lower than it was before',
        comment:
          'A leftward shift in supply raises the equilibrium price, it does not lower it. With less supplied at each price and demand unchanged, the price must rise.',
        correction:
          'After a leftward supply shift the new equilibrium has a higher price and a lower quantity.',
      },
    ],
    awards: [
      'higher equilibrium price and a lower equilibrium quantity',
      'at a higher price and a lower quantity',
    ],
    partials: [],
    weak: [],
    awardReasoning:
      'The new equilibrium is correctly identified as a higher price and a lower quantity, and shown on the graph.',
    missing: {
      comment:
        'The answer stops at the supply curve shifting left and never says what happens to the equilibrium price and quantity as a result.',
      correction:
        'Add that the new supply curve meets unchanged demand at a higher equilibrium price and a lower equilibrium quantity, and show the new intersection on the graph.',
    },
  },
};

export interface SurfaceError {
  wrong: string;
  right: string;
  kind: FindingKind;
}

/**
 * Surface errors are annotated but never deducted. Marks come only from rubric
 * criteria, and none of these criteria award marks for spelling — so flagging a
 * misspelling here tells the student something useful without quietly
 * double-penalising them for it.
 */
export const SURFACE_ERRORS: SurfaceError[] = [
  // Ordinary misspellings.
  { wrong: 'circut', right: 'circuit', kind: 'spelling' },
  { wrong: 'potencial', right: 'potential', kind: 'spelling' },
  { wrong: 'ameter', right: 'ammeter', kind: 'spelling' },
  { wrong: 'resistence', right: 'resistance', kind: 'spelling' },
  { wrong: 'alot', right: 'a lot', kind: 'spelling' },
  // Grammar.
  { wrong: 'there brain', right: 'their brain', kind: 'grammar' },
  { wrong: 'there phone', right: 'their phone', kind: 'grammar' },
  { wrong: 'Students is', right: 'Students are', kind: 'grammar' },
  // OCR-style character confusions.
  { wrong: 'circuil', right: 'circuit', kind: 'spelling' },
  { wrong: 'currenl', right: 'current', kind: 'spelling' },
  { wrong: 'ballery', right: 'battery', kind: 'spelling' },
  { wrong: 'arnmeter', right: 'ammeter', kind: 'spelling' },
  { wrong: 'vo1tmeter', right: 'voltmeter', kind: 'spelling' },
  { wrong: 'paralIel', right: 'parallel', kind: 'spelling' },
  { wrong: 'resistarice', right: 'resistance', kind: 'spelling' },
  { wrong: 'dernand', right: 'demand', kind: 'spelling' },
  { wrong: 'quantlty', right: 'quantity', kind: 'spelling' },
  { wrong: 'suppIy', right: 'supply', kind: 'spelling' },
  { wrong: 'equiIibriurn', right: 'equilibrium', kind: 'spelling' },
];
