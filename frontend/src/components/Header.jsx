import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

export default function Header() {
  const navigate = useNavigate();
  const [lookupId, setLookupId] = useState("");

  function handleLookup(e) {
    e.preventDefault();
    const id = lookupId.trim();
    if (!id) return;
    navigate(`/results/${id}`);
    setLookupId("");
  }

  return (
    <header className="nb-header">
      <Link to="/" className="nb-header__title">
        <span className="nb-mark" />
        Spocker
      </Link>
      <nav className="nb-header__nav">
        <form onSubmit={handleLookup} style={{ display: "flex", gap: "0.4rem" }}>
          <input
            className="nb-input nb-mono"
            style={{ width: "14rem" }}
            placeholder="LOAD JOB BY UUID..."
            value={lookupId}
            onChange={(e) => setLookupId(e.target.value)}
          />
          <button className="nb-btn nb-btn--invert nb-btn--sm" type="submit">
            Go
          </button>
        </form>
        <Link to="/compare" className="nb-btn nb-btn--invert nb-btn--sm">
          Compare
        </Link>
        <Link to="/" className="nb-btn nb-btn--invert nb-btn--sm">
          + New
        </Link>
      </nav>
    </header>
  );
}
