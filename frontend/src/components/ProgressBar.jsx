export default function ProgressBar({ progress = 0, dark = false, label }) {
  const clamped = Math.max(0, Math.min(100, progress));
  return (
    <div>
      {label && (
        <div
          className="nb-mono"
          style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.35em", fontSize: "0.75rem" }}
        >
          <span>{label}</span>
          <span>{clamped.toFixed(0)}%</span>
        </div>
      )}
      <div className={`nb-progress ${dark ? "nb-progress--dark" : ""}`}>
        <div className="nb-progress__fill" style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}
