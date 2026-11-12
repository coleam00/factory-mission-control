import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { Column } from '../components/Column';
import { NoWorkItem, WorkItem } from '../components/WorkItem';
import { WORK_ITEM_NUMBER } from '../lib/work-item';
import { useFactory } from '../live/FactoryProvider';

/** One work item: every run on it, as a timeline. */
export default function Work(): ReactElement {
  const factory = useFactory();
  const { n = '' } = useParams();
  if (!WORK_ITEM_NUMBER.test(n)) {
    return (
      <Column width="max-w-4xl" className="grid gap-4 px-6 py-6">
        <NoWorkItem number={n} />
      </Column>
    );
  }
  return <WorkItem factory={factory} number={n} />;
}
