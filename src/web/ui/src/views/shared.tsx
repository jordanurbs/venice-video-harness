import { useState, type ReactNode } from 'react';
import { runCommand } from '../api';
import type { JobRequest } from '../types';

export function verdictClass(verdict?: string): string {
  if (!verdict) return 'none';
  if (verdict === 'PASS') return 'pass';
  if (verdict === 'FLAG-CRITICAL') return 'critical';
  if (verdict === 'FLAG-MODERATE') return 'moderate';
  return 'low';
}

export function VerdictBadge({ verdict }: { verdict?: string }) {
  return <span className={`badge ${verdictClass(verdict)}`}>{verdict ?? 'unchecked'}</span>;
}

interface RunButtonProps {
  slug: string;
  request: JobRequest;
  disabled?: boolean;
  /** Ask before running (spend-adjacent commands). */
  confirm?: string;
  children: ReactNode;
  ghost?: boolean;
}

/** Fire a whitelisted harness command; errors surface inline. */
export function RunButton({ slug, request, disabled, confirm, children, ghost }: RunButtonProps) {
  const [error, setError] = useState<string | null>(null);
  const onClick = async () => {
    if (confirm && !window.confirm(confirm)) return;
    setError(null);
    const result = await runCommand(slug, request);
    if ('error' in result) setError(result.error);
  };
  return (
    <span>
      <button className={ghost ? 'ghost' : 'action'} disabled={disabled} onClick={onClick}>
        {children}
      </button>
      {error && <span className="dim small" style={{ marginLeft: 8, color: '#e58a76' }}>{error}</span>}
    </span>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="ghost"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? 'copied' : 'copy'}
    </button>
  );
}
