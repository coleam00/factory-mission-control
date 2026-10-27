import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { Health as HealthPanels } from '../components/Health';

export default function Health(): ReactElement {
  return (
    <main className="mx-auto max-w-6xl px-6 py-6">
      <HealthPanels factory={useParams().factory} />
    </main>
  );
}
