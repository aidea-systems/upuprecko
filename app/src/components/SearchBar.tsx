import { useMemo, useState } from 'react';
import { strings as t } from '../i18n/strings';

export interface SearchItem {
  key: string;
  label: string;
  sub: string;
  /** text matched against the query */
  haystack: string;
  target: { type: 'plot'; plotNumber: string } | { type: 'review'; featureId: string };
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();

export function SearchBar({ items, onSelect }: { items: SearchItem[]; onSelect: (i: SearchItem) => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [focus, setFocus] = useState(false);

  const results = useMemo(() => {
    const n = norm(q.trim());
    if (!n) return [];
    const scored = items
      .map((i) => {
        const h = norm(i.haystack);
        const pos = h.indexOf(n);
        return { i, score: pos < 0 ? -1 : norm(i.label) === n ? 0 : pos === 0 ? 1 : 2 };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || a.i.label.localeCompare(b.i.label, undefined, { numeric: true }));
    return scored.slice(0, 12).map((x) => x.i);
  }, [q, items]);

  const choose = (i: SearchItem) => {
    onSelect(i);
    setQ(i.label);
    setFocus(false);
  };

  return (
    <div className="search">
      <span className="search-icon">⌕</span>
      <input
        value={q}
        placeholder={t.search.placeholder}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setFocus(true);
        }}
        onFocus={() => setFocus(true)}
        onBlur={() => setTimeout(() => setFocus(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, results.length - 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
          else if (e.key === 'Enter' && results[active]) choose(results[active]);
          else if (e.key === 'Escape') setFocus(false);
        }}
      />
      {q && (
        <button className="icon clear" title={t.search.clear} onClick={() => setQ('')}>
          ×
        </button>
      )}
      {focus && q.trim() && (
        <ul className="search-results">
          {results.length === 0 && <li className="muted empty">{t.search.noResults}</li>}
          {results.map((r, k) => (
            <li key={r.key}>
              <button className={k === active ? 'active' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(r)}>
                <span className="strong">{r.label}</span>
                <span className="muted small">{r.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
