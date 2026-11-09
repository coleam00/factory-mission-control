import type { ReactElement } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router';
import { Attention as AttentionPage } from '../components/Attention';
import { placeAddress } from '../lib/places';
import { homeAddressTarget } from '../routing';

/** Attention, or the map when the address is an old map link (`at`, `view` or `from`). */
export default function Attention(): ReactElement {
  const { factory = '' } = useParams();
  const [search] = useSearchParams();
  const target = homeAddressTarget(factory, search);
  if (target !== placeAddress(factory, '')) return <Navigate replace to={target} />;
  return (
    <main>
      <AttentionPage factory={factory} />
    </main>
  );
}
