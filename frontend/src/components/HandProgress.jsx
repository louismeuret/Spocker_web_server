/**
 * Job progress drawn as the hand from public/spinner.webp filling up from
 * the wrist to the fingertips.
 *
 * The artwork is used as a CSS mask rather than as an image, which keeps its
 * animation (the browser plays the animated WebP as the mask, all 241 frames
 * of it) while letting us paint whatever we like through it: white above the
 * fill line so only the outline shows, a galaxy below it. The galaxy is drawn
 * at full size and uncovered from the bottom (clip-path), so it doesn't
 * stretch as the job progresses. See .nb-hand in index.css for how the
 * outline itself is produced.
 */

// In the artwork's own 552x683 coordinates, centred on the palm.
const CX = 276;
const CY = 400;

// Two logarithmic-spiral arms, half a turn apart.
const ARMS = [0, Math.PI].map((phase) => {
  const points = [];
  for (let t = 0; t <= 3.2 * Math.PI; t += 0.1) {
    const r = 12 * Math.exp(0.28 * t);
    points.push(`${(CX + r * Math.cos(t + phase)).toFixed(1)},${(CY + r * Math.sin(t + phase)).toFixed(1)}`);
  }
  return `M${points.join(" L")}`;
});

// Fixed pseudo-random scatter (same stars on every render).
const STARS = Array.from({ length: 70 }, (_, i) => ({
  x: (i * 197.3) % 552,
  y: (i * 263.7 + 41) % 683,
  r: 0.8 + ((i * 7) % 5) * 0.35,
  delay: `${((i * 0.37) % 3).toFixed(2)}s`,
}));

export default function HandProgress({ progress = 0, label, size = "11rem" }) {
  const clamped = Math.max(0, Math.min(100, progress));
  return (
    <div className="nb-hand-progress">
      <div className="nb-hand">
        <div className="nb-hand__shape" style={{ height: size }}>
          <svg
            className="nb-hand__fill"
            viewBox="0 0 552 683"
            preserveAspectRatio="xMidYMid slice"
            style={{ clipPath: `inset(${100 - clamped}% 0 0 0)` }}
            aria-hidden="true"
          >
            <defs>
              <radialGradient id="nb-galaxy-sky" cx={CX} cy={CY} r="420" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#3b1a6e" />
                <stop offset="0.5" stopColor="#140a33" />
                <stop offset="1" stopColor="#05030f" />
              </radialGradient>
              <linearGradient id="nb-galaxy-arm" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#ff6ec7" />
                <stop offset="0.5" stopColor="#8a5cff" />
                <stop offset="1" stopColor="#3ad7ff" />
              </linearGradient>
              <filter id="nb-galaxy-glow">
                <feGaussianBlur stdDeviation="6" />
              </filter>
            </defs>
            <rect width="552" height="683" fill="url(#nb-galaxy-sky)" />
            {STARS.map((s, i) => (
              <circle
                key={i}
                className="nb-hand__star"
                cx={s.x}
                cy={s.y}
                r={s.r}
                style={{ animationDelay: s.delay }}
              />
            ))}
            <g className="nb-hand__spiral" style={{ transformOrigin: `${CX}px ${CY}px` }}>
              {ARMS.map((d) => (
                <g key={d}>
                  <path d={d} stroke="url(#nb-galaxy-arm)" strokeWidth="26" fill="none" opacity="0.55" filter="url(#nb-galaxy-glow)" />
                  <path d={d} stroke="url(#nb-galaxy-arm)" strokeWidth="5" fill="none" strokeLinecap="round" />
                </g>
              ))}
              <circle cx={CX} cy={CY} r="30" fill="#fff4d6" filter="url(#nb-galaxy-glow)" />
              <circle cx={CX} cy={CY} r="10" fill="#fff" />
            </g>
          </svg>
        </div>
      </div>
      <span className="nb-mono nb-hand__value">{clamped.toFixed(0)}%</span>
      {label && <span className="nb-mono nb-hand__label">{label}</span>}
    </div>
  );
}
