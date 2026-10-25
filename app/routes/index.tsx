import type { ReactElement } from 'react';
import { EmptyState } from '../components/EmptyState';

export default function Home(): ReactElement {
  return (
    <main className="mx-auto max-w-6xl px-6">
      <EmptyState title="No factory activity to show yet." />
    </main>
  );
}
