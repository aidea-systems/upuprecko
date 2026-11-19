import type { ReactNode } from 'react';
import { strings as t } from '../i18n/strings';

/**
 * Where plot / zone details are shown: a panel fixed at the right of the screen,
 * or a sheet from the bottom on a phone. The place does not depend on where the plot is on the map.
 */
export function DetailsPanel({ sheet, onClose, children }: { sheet?: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <div className={sheet ? 'popup-sheet' : 'details-panel'}>
      <button className="icon sheet-close" onClick={onClose} title={t.app.close} aria-label={t.app.close}>
        ×
      </button>
      {children}
    </div>
  );
}
