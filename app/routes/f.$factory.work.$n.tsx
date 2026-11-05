import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { NoWorkItem, WorkItem } from '../components/WorkItem';
import { useFactory } from '../live/FactoryProvider';

/** The shape of `mc.run_issue_number`'s numbers: an address that is not one names no work item. */
const NUMBER = /^[1-9][0-9]{0,8}$/;

/** One work item: every run on it, as a timeline. */
export default function Work(): ReactElement {
  const factory = useFactory();
  const { n = '' } = useParams();
  if (!NUMBER.test(n)) {
    return (
      <main className="mx-auto grid max-w-4xl gap-4 px-6 py-6">
        <NoWorkItem number={n} />
      </main>
    );
  }
  return <WorkItem factory={factory} number={n} />;
}
