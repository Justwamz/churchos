/**
 * Skeleton: shimmering placeholder while data loads. <Skeleton /> is one line; `lines={3}` stacks lines; `height` makes a block (a card or a tile);
 * `rows` is a convenience for a list of equal rows. Prefer this to a spinner on any page or card that has a known shape.
 */
export function Skeleton({ lines = 1, height, width, rows }: { lines?: number; height?: number | string; width?: number | string; rows?: number }) {
  if (rows) return <div className="u-skel-stack" role="status" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <span key={i} className="u-skel block" style={{ height: height ?? 52 }} />)}</div>;
  if (height) return <span className="u-skel block" style={{ height, width }} role="status" aria-label="Loading" />;
  return (
    <div className="u-skel-stack" role="status" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => <span key={i} className="u-skel" style={{ width: width ?? (i === lines - 1 && lines > 1 ? '60%' : '100%') }} />)}
    </div>
  );
}

/** PageSkeleton: the loading shape of a whole page (header, tiles, a card). Used as the Suspense fallback while a page's code loads. */
export function PageSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="u-skel-page">
      <span className="u-skel" style={{ width: 220, height: 30 }} />
      <span className="u-skel" style={{ width: 340, maxWidth: '80%', height: 14, marginTop: 10 }} />
      <div className="u-stats" style={{ marginTop: 24 }}>{[0, 1, 2, 3].map((i) => <span key={i} className="u-skel block" style={{ height: 92 }} />)}</div>
      <span className="u-skel block" style={{ height: 260, marginTop: 16 }} />
    </div>
  );
}
