import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { fetchSearch } from "../api";
import type { SearchResponse } from "../api";

/**
 * Debounce a rapidly-changing value: the returned value only settles to the
 * latest input after `ms` of quiet, so as-you-type keystrokes coalesce into a
 * single fetch instead of one request per character.
 */
export function useDebounced<T>(value: T, ms = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/**
 * As-you-type search: debounce the query, then fetch it via TanStack Query with
 * the debounced string as the cache key. `keepPreviousData` holds the prior
 * results on screen while the next query is in flight, so typeahead never
 * flickers to empty. The empty query still fires — the API answers with the
 * recent-updates landing.
 */
export function useSearch(query: string) {
  const debounced = useDebounced(query, 200);
  return useQuery<SearchResponse>({
    queryKey: ["search", debounced],
    queryFn: () => fetchSearch(debounced),
    placeholderData: keepPreviousData,
  });
}
