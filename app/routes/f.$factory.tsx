import type { ReactElement } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router';
import { WaitingOnYou } from '../components/Decisions';
import { placeAddress } from '../lib/places';
import { homeAddressTarget } from '../routing';

/** Attention, or the map when the address is an old map link (`at`, `view` or `from`). */
export default function Attention(): ReactElement {
  const { factory = '' } = useParams();
  const [search] = useSearchParams();
  const target = homeAddressTarget(factory, search);
  if (target !== placeAddress(factory, '')) return <Navigate replace to={target} />;
  return (
    <main className="mx-auto grid max-w-6xl gap-8 px-6 py-6">
      <WaitingOnYou factory={factory} />
    </main>
  );
}
