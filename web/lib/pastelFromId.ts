function hueFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(31, h) + id.charCodeAt(i);
  return (h >>> 0) % 360;
}

/** Stable pastel fill from an id (sidebar / query swatches). */
export function pastelFromId(id: string): string {
  const hue = hueFromId(id);
  return `hsl(${hue} 48% 68%)`;
}

/** Slightly darker accent for borders on map tiles. */
export function pastelStrokeFromId(id: string): string {
  const hue = hueFromId(id);
  return `hsl(${hue} 42% 48%)`;
}
