import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { Column } from '../components/Column';
import { Runs as RunsScreen } from '../components/Runs';

export default function Runs(): ReactElement {
  const { factory } = useParams();
  return (
    <Column className="grid gap-8 px-6 py-6">
      <RunsScreen factory={factory} />
    </Column>
  );
}
