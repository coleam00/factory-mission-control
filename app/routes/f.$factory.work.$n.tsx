import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { NoWorkItem, WorkItem } from '../components/WorkItem';
import { WORK_ITEM_NUMBER } from '../lib/work-item';
import { useFactory } from '../live/FactoryProvider';

/** One work item: every run on it, as a timeline. */
export default function Work(): ReactElement {
  const factory = useFactory();
  const { n = '' } = useParams();
  if (!WORK_ITEM_NUMBER.test(n)) {
    return (
      <main className="mx-auto grid max-w-4xl gap-4 px-6 py-6">
        <NoWorkItem number={n} />
      </main>
    );
  }
  return <WorkItem factory={factory} number={n} />;
}
