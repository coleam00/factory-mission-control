import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { VersionStrip } from '../components/VersionStrip';

export default function Versions(): ReactElement {
  return (
    <main data-v1-screen="versions" className="mx-auto max-w-6xl px-6 py-6">
      <VersionStrip factory={useParams().factory} />
    </main>
  );
}
