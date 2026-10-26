import type { ReactElement } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { ArchDiff } from '../components/ArchDiff';

export default function Diff(): ReactElement {
  const [search] = useSearchParams();
  return (
    <main className="mx-auto max-w-6xl px-6 py-6">
      <ArchDiff factory={useParams().factory} a={search.get('a')} b={search.get('b')} />
    </main>
  );
}
