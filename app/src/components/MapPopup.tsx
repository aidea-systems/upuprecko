import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import maplibregl from 'maplibre-gl';

/** A MapLibre popup whose content is rendered by React. */
export function MapPopup(props: { map: maplibregl.Map; lngLat: [number, number]; onClose: () => void; children: ReactNode }) {
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
    return () => {
      popup.off('close', close);
      popup.remove();
    };
  }, [props.map, el, lng, lat]);

  return createPortal(props.children, el);
}
