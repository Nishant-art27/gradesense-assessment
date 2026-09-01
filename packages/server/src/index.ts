import fs from 'node:fs/promises';
import { config } from './config.js';
import { createApp, createDefaultRepository } from './app.js';
import { loadRubric } from './rubric-source.js';

async function main(): Promise<void> {
  await fs.mkdir(config.paths.uploads, { recursive: true });

  // Fail at startup rather than on the first grading request: a rubric whose
  // marks do not add up means nothing downstream can be trusted.
  const rubric = await loadRubric();

  const app = createApp({ repository: createDefaultRepository() });

  app.listen(config.port, () => {
    console.log(`\n  GradeSense API   http://localhost:${config.port}`);
    console.log(`  Provider         ${config.provider}${config.provider === 'anthropic' ? ` (${config.model})` : ' (deterministic, no API key needed)'}`);
    console.log(`  Rubric           ${rubric.title} — ${rubric.totalMarks} marks, ${rubric.questions.length} questions`);
    console.log(`  Data             ${config.paths.data}\n`);
  });
}

main().catch((error: unknown) => {
  console.error('Failed to start the GradeSense server:\n', error);
  process.exit(1);
});
