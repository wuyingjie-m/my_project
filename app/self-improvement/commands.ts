import type { ReactNode } from 'react';

export interface CommandConfig {
  id: string;
  label: string;
  description: string;
  endpoint: string;
  method: 'POST';
  variant: 'primary' | 'success' | 'danger' | 'neutral';
  icon: ReactNode;
  requiresConfirmation: boolean;
  confirmationText?: string;
  sideEffect: 'none' | 'writes' | 'external';
}

const commands: CommandConfig[] = [
  {
    id: 'dry-run',
    label: 'Dry Run',
    description: 'Preview improvement items without writing files.',
    endpoint: '/api/dry-run',
    method: 'POST',
    variant: 'neutral',
    icon: null,
    requiresConfirmation: false,
    sideEffect: 'none',
  },
  {
    id: 'proactive-real',
    label: 'Run Proactive Analysis',
    description: 'Analyze usage and write deduped R&D council + ledger records.',
    endpoint: '/api/proactive-real',
    method: 'POST',
    variant: 'primary',
    icon: null,
    requiresConfirmation: true,
    confirmationText: 'This writes deduped proactive ideas to rd-council-items.json and idea_ledger.json.',
    sideEffect: 'writes',
  },
  {
    id: 'ingest-usage',
    label: 'Ingest Usage Data',
    description: 'Run canonical usage ingestion from available session data.',
    endpoint: '/api/ingest-usage',
    method: 'POST',
    variant: 'primary',
    icon: null,
    requiresConfirmation: true,
    confirmationText: 'This updates the local R&D council and idea ledger from usage signals.',
    sideEffect: 'writes',
  },
  {
    id: 'weekly-review',
    label: 'Weekly Review',
    description: 'Summarize current council and ledger state without side effects.',
    endpoint: '/api/weekly-review',
    method: 'POST',
    variant: 'success',
    icon: null,
    requiresConfirmation: false,
    sideEffect: 'none',
  },
];

export { commands };
