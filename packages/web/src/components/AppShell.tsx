import type { ReactNode } from 'react';
import type { HealthInfo } from '../api.js';
import { Badge } from './ui/Badge.js';
import { Button } from './ui/Button.js';
import { Callout } from './ui/Callout.js';
import { Logo } from './ui/Logo.js';

/**
 * The persistent frame: brand, provider badge, the workspace toolbar, and the
 * status banner.
 *
 * Lifted out of `App.tsx`, which was carrying 150 lines of inline chrome JSX
 * around its actual job of orchestrating the grading flow.
 */

export type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'error'; message: string; details: string[]; retryable: boolean };

export function AppShell({
  health,
  status,
  onHome,
  showBack,
  toolbar,
  onRetry,
  children,
}: {
  health: HealthInfo | null;
  status: Status;
  onHome: () => void;
  showBack: boolean;
  /** Workspace-only action row, rendered beneath the header. */
  toolbar?: ReactNode;
  onRetry?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="app">
      <header className="app-header">
        <button type="button" className="brand" onClick={onHome} title="Back to the start">
          <span className="brand__mark">
            <Logo title="GradeSense" />
          </span>
          <span className="brand__text">
            <span className="brand__name">GradeSense</span>
            <span className="brand__sub">explainable marking</span>
          </span>
        </button>

        <div className="header-right">
          {showBack && (
            <Button variant="ghost" size="sm" onClick={onHome}>
              ← All papers
            </Button>
          )}
          {health && (
            <Badge pill dot live={health.live} tone={health.live ? 'success' : 'neutral'}>
              {health.live ? 'live' : 'mock'}
              {/* Which provider is running is load-bearing information, so the
                  badge never disappears — only its detail does, on a narrow
                  screen where the header would otherwise overflow. */}
              <span className="hide-sm">
                {health.live ? ` · ${health.model}` : ' · deterministic, no API key'}
              </span>
            </Badge>
          )}
        </div>
      </header>

      {toolbar}

      {status.kind === 'busy' && (
        <Callout tone="busy" className="banner">
          {status.message}
        </Callout>
      )}

      {status.kind === 'error' && (
        <Callout tone="error" className="banner" title={status.message}>
          {status.details.length > 0 && (
            <ul>
              {status.details.map((detail, index) => (
                <li key={index}>{detail}</li>
              ))}
            </ul>
          )}
          {status.retryable && onRetry && (
            <Button size="sm" onClick={onRetry} className="banner__retry">
              Try again
            </Button>
          )}
        </Callout>
      )}

      {children}
    </div>
  );
}
