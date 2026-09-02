import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ANNOTATION_COLOURS } from '@gradesense/shared';
import { App } from './App.js';
import './styles.css';

/*
 * The annotation palette is written onto :root here rather than declared in the
 * stylesheet, because the PDF export reads the same table from
 * packages/shared/src/annotation-palette.ts. One source, two renderers — so a
 * red box on screen cannot drift from the red in the downloaded file.
 */
for (const [kind, hex] of Object.entries(ANNOTATION_COLOURS)) {
  document.documentElement.style.setProperty(`--kind-${kind}`, hex);
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
