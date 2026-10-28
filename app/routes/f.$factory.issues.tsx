import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { IssueGraph } from '../components/IssueGraph';

export default function Issues(): ReactElement {
  return (
    <main className="mx-auto max-w-[1840px] px-6 py-6">
      <IssueGraph factory={useParams().factory} />
    </main>
  );
}
