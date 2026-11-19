import { useEffect, useState } from 'react';

/** Phones and narrow windows: panels and plot details open as sheets from the bottom instead of beside the map. */
export const COMPACT_QUERY = '(max-width: 900px)';

export const isCompactNow = () => typeof window !== 'undefined' && window.matchMedia(COMPACT_QUERY).matches;

/** true while the window is narrow; follows resizing and turning the phone. */
export function useCompact(): boolean {
  const [compact, setCompact] = useState(isCompactNow);
  useEffect(() => {
    const m = window.matchMedia(COMPACT_QUERY);
    const on = () => setCompact(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return compact;
}
