import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { OwnerQueue } from '../components/OwnerQueue';

export default function Owner(): ReactElement {
  return (
    <main className="mx-auto max-w-6xl px-6 py-6">
      <OwnerQueue factory={useParams().factory} />
    </main>
  );
}
