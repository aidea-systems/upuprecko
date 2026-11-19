import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import maplibregl from 'maplibre-gl';
import { strings as t } from '../i18n/strings';

interface Props {
  map: maplibregl.Map;
  lngLat: [number, number];
  /** phone or narrow window: show the content as a sheet from the bottom instead of a popup on the map */
  sheet?: boolean;
  onClose: () => void;
  children: ReactNode;
}

/** Plot / zone details: a MapLibre popup at the place on the map, or a bottom sheet on a phone. */
export function MapPopup(props: Props) {
  if (props.sheet)
    return (
      <div className="sheet popup-sheet">
        <button className="icon sheet-close" onClick={props.onClose} title={t.app.close} aria-label={t.app.close}>
          ×
        </button>
        {props.children}
      </div>
    );
  return <Anchored {...props} />;
}

/** A MapLibre popup whose content is rendered by React. */
function Anchored(props: Props) {
  const [el] = useState(() => document.createElement('div'));
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  const [lng, lat] = props.lngLat;

  useEffect(() => {
    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: '400px', className: 'dark-popup', focusAfterOpen: false })
      .setLngLat([lng, lat])
      .setDOMContent(el)
      .addTo(props.map);
    const close = () => onClose.current();
    popup.on('close', close);

    // Keep the whole popup on screen, below the search bar: when it opens and whenever its content
    // grows (notes opened, the edit form), the map moves just enough.
    const keepInView = () => {
      const box = popup.getElement()?.getBoundingClientRect();
      if (!box) return;
      const top = 72;
      const bottom = window.innerHeight - 12;
      const dy = box.top < top ? box.top - top : box.bottom > bottom ? Math.min(box.bottom - bottom, box.top - top) : 0;
      if (Math.abs(dy) > 1) props.map.panBy([0, dy], { duration: 250 });
    };
    const watch = new ResizeObserver(keepInView);
    watch.observe(el);
    const first = requestAnimationFrame(keepInView);
    return () => {
      cancelAnimationFrame(first);
      watch.disconnect();
      popup.off('close', close);
      popup.remove();
    };
  }, [props.map, el, lng, lat]);

  return createPortal(props.children, el);
}
