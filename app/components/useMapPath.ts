import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { type FactoryMap, FROM_PARAM, VIEW_PARAM, viewPath, viewSearch } from '../map/factory-map';

/** The open view as the address names it, and the setter that pushes a level change onto history. */
export function useMapPath(map: FactoryMap): [string[], (to: readonly string[]) => void] {
  const [search, setSearch] = useSearchParams();
  const path = viewPath(map, search.get(VIEW_PARAM), search.get(FROM_PARAM));
  const onPath = useCallback(
    (to: readonly string[]) => setSearch((prev) => viewSearch(map, prev, to)),
    [map, setSearch],
  );
  return [path, onPath];
}
