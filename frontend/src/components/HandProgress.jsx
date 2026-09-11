/**
 * Job progress drawn as the hand from public/spinner.webp filling up from
 * the wrist to the fingertips.
 *
 * The artwork is used as a CSS mask rather than as an image, which keeps its
 * animation (the browser plays the animated WebP as the mask, all 241 frames
 * of it) while letting us paint whatever we like through it: white above the
 * fill line so only the outline shows, black below it. See .nb-hand in
 * index.css for how the outline itself is produced.
 */
export default function HandProgress({ progress = 0, label, size = "11rem" }) {
  const clamped = Math.max(0, Math.min(100, progress));
  return (
    <div className="nb-hand-progress">
      <div className="nb-hand">
        <div className="nb-hand__shape" style={{ height: size }}>
          <div className="nb-hand__fill" style={{ height: `${clamped}%` }} />
        </div>
      </div>
      <span className="nb-mono nb-hand__value">{clamped.toFixed(0)}%</span>
      {label && <span className="nb-mono nb-hand__label">{label}</span>}
    </div>
  );
}
