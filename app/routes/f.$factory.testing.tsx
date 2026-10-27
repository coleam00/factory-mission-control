import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { Testing } from '../components/Testing';

export default function TestingScreen(): ReactElement {
  return (
    <main className="mx-auto max-w-6xl px-6 py-6">
      <Testing factory={useParams().factory} />
    </main>
  );
}
