import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { createApp, createDefaultRepository } from './app.js';
import { loadRubric } from './rubric-source.js';

async function main(): Promise<void> {
  await fs.mkdir(config.paths.uploads, { recursive: true });

  // Fail at startup rather than on the first grading request: a rubric whose
  // marks do not add up means nothing downstream can be trusted.
  const rubric = await loadRubric();

  // `npm run build` produces the web app; in development Vite serves it instead.
  const webDist = existsSync(path.join(config.paths.webDist, 'index.html')) ? config.paths.webDist : undefined;

  const app = createApp({ repository: createDefaultRepository(), webDist });

  app.listen(config.port, () => {
    console.log(`\n  GradeSense ${webDist ? 'app + API' : 'API'}   http://localhost:${config.port}`);
    // The suffix used to be hardcoded to "deterministic, no API key needed" for
    // anything that was not Anthropic, which told a Gemini user the opposite of
    // the truth about where their marks were coming from.
    const how =
      config.provider === 'mock'
        ? 'deterministic rules, no API key needed'
        : `live model · ${config.model}`;
    console.log(`  Provider         ${config.provider} (${how})`);
    console.log(`  Rubric           ${rubric.title} — ${rubric.totalMarks} marks, ${rubric.questions.length} questions`);
    console.log(`  Data             ${config.paths.data}\n`);
  });
}

main().catch((error: unknown) => {
  console.error('Failed to start the GradeSense server:\n', error);
  process.exit(1);
});
