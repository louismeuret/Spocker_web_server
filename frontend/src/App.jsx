import { Route, Routes } from "react-router-dom";
import StarBackground from "./components/StarBackground";
import Header from "./components/Header";
import InputPage from "./pages/InputPage";
import ResultsPage from "./pages/ResultsPage";
import ComparePage from "./pages/ComparePage";

function NotFound() {
  return (
    <main style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem" }}>
      <div className="nb-panel" style={{ padding: "1.5rem 2rem", textAlign: "center" }}>
        <h2>404</h2>
        <p>Nothing here.</p>
      </div>
    </main>
  );
}

export default function App() {
  return (
    <>
      <StarBackground />
      <div className="nb-page">
        <Header />
        <Routes>
          <Route path="/" element={<InputPage />} />
          <Route path="/results/:jobId" element={<ResultsPage />} />
          {/* Both forms mount the same page: the bare /compare shows an empty
              form, the two-UUID form makes a given comparison a shareable link. */}
          <Route path="/compare" element={<ComparePage />} />
          <Route path="/compare/:jobIdA/:jobIdB" element={<ComparePage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
    </>
  );
}
