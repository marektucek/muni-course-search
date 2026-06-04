"use client";

import { useState } from "react";
import "./globals.css";

const COMPLETION_LABELS = {
  zk: "Zkouška",
  k: "Kolokvium",
  z: "Zápočet",
};

function CompletionBadge({ value }) {
  const label = COMPLETION_LABELS[value?.toLowerCase()] ?? value;
  return <span className="badge">{label}</span>;
}

function ScoreBadge({ score }) {
  if (score == null) return null;
  const pct = Math.round(score * 100);
  const color = pct >= 65 ? "var(--score-high)" : pct >= 55 ? "var(--score-mid)" : "var(--score-low)";
  return (
    <span className="badge score-badge" style={{ color, borderColor: color }}>
      {pct}% shoda
    </span>
  );
}

function AccessBadge({ otevreny }) {
  if (otevreny === true)
    return <span className="badge access-open" title="Předmět je otevřen i mimo mateřský obor">✓ Otevřený</span>;
  if (otevreny === false)
    return <span className="badge access-closed" title="Předmět je určen pouze studentům mateřského oboru">⚠ Pouze pro mateřský obor</span>;
  return null;
}

function LanguageBadge({ jazyk }) {
  if (!jazyk) return null;
  // Capitalise first letter for display
  const label = jazyk.charAt(0).toUpperCase() + jazyk.slice(1);
  return <span className="badge lang-badge" title="Jazyk výuky">{label}</span>;
}

function LowMatchWarning({ score }) {
  if (score == null || score >= 0.50) return null;
  return <span className="badge low-match" title="Nízká míra shody s dotazem">⚠ Nízká shoda</span>;
}

function DetailRow({ label, text }) {
  if (!text) return null;
  return (
    <div className="detail-row">
      <div className="detail-label">{label}</div>
      <p className="detail-text">{text}</p>
    </div>
  );
}

function CourseCard({ course, rank }) {
  const [open, setOpen] = useState(false);

  return (
    <article className="card">
      {/* ── top row: title + score chips ── */}
      <div className="card-top">
        <h2 className="card-name">
          {rank}.{" "}
          <a className="card-link" href={course.url} target="_blank" rel="noopener noreferrer">
            {course.name}
          </a>
        </h2>
        <div className="card-score-chips">
          <ScoreBadge score={course.score} />
          <LowMatchWarning score={course.score} />
        </div>
      </div>

      {/* ── meta badges ── */}
      <div className="card-meta">
        <span className="badge code">{course.code}</span>
        {course.credits && <span className="badge">{course.credits} kr.</span>}
        {course.completion && <CompletionBadge value={course.completion} />}
        {course.semester && <span className="badge">{course.semester}</span>}
        <AccessBadge otevreny={course.otevreny} />
        <LanguageBadge jazyk={course.jazyk} />
      </div>

      {/* ── AI reasoning ── */}
      {course.reasoning && (
        <div className="reasoning-block">
          <div className="reasoning-label">Proč tento předmět?</div>
          <p className="reasoning">{course.reasoning}</p>
        </div>
      )}

      {/* ── collapsible course details ── */}
      {(course.anotace || course.vystupy || course.temata) && (
        <div className="details-section">
          <button
            className="details-toggle"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            {open ? "▲ Skrýt podrobnosti" : "▼ Zobrazit podrobnosti předmětu"}
          </button>

          {open && (
            <div className="details-body">
              <DetailRow label="Anotace" text={course.anotace} />
              <DetailRow label="Výstupy z učení" text={course.vystupy} />
              <DetailRow label="Klíčová témata" text={course.temata} />
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("idle");
  const [results, setResults] = useState([]);
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;

    setStatus("searching");
    setResults([]);
    setErrorMsg("");

    try {
      const searchRes = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });
      if (!searchRes.ok) throw new Error("Hledání selhalo.");
      const { candidates } = await searchRes.json();

      setStatus("recommending");

      const recRes = await fetch("/api/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed, candidates }),
      });
      if (!recRes.ok) throw new Error("Generování doporučení selhalo.");
      const { recommendations } = await recRes.json();

      setResults(recommendations);
      setStatus("done");
    } catch (err) {
      setErrorMsg(err.message || "Neočekávaná chyba.");
      setStatus("error");
    }
  }

  const loading = status === "searching" || status === "recommending";

  return (
    <>
      <header className="header">
        <div className="container">
          <h1>Najdi si volitelné předměty na FF MUNI</h1>
          <p>Povinné předměty máš dané. Ale čím zaplnit zbytek kreditů? Místo hledání podle kódů a názvů — popiš, co tě zajímá, co chceš umět, nebo k čemu se to hodí. My najdeme předměty, které to splňují.</p>
        </div>
      </header>

      <main className="container">
        <section className="search-section">
          <form className="search-form" onSubmit={handleSubmit}>
            <textarea
              className="search-input"
              placeholder={'Např. „Chci rozumět tomu, jak fungují média" nebo „Potřebuji něco praktického k žurnalistice"'}
              value={query}
              rows={2}
              onChange={(e) => {
                setQuery(e.target.value);
                // Auto-grow: reset height first so shrinking also works
                e.target.style.height = "auto";
                e.target.style.height = e.target.scrollHeight + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!loading && query.trim()) handleSubmit(e);
                }
              }}
              disabled={loading}
              aria-label="Vzdělávací cíl"
              style={{ resize: "none", overflow: "hidden" }}
            />
            <button className="search-btn" type="submit" disabled={loading || !query.trim()}>
              {loading ? "Hledám…" : "Najít předměty"}
            </button>
          </form>
        </section>

        {status === "searching" && (
          <div className="status">
            <span className="spinner" aria-hidden="true" />
            Hledám nejbližší předměty…
          </div>
        )}

        {status === "recommending" && (
          <div className="status">
            <span className="spinner" aria-hidden="true" />
            Generuji zdůvodnění…
          </div>
        )}

        {status === "error" && (
          <div className="status error">{errorMsg}</div>
        )}

        {status === "done" && results.length > 0 && (
          <>
            <p className="results-header">5 doporučených předmětů</p>
            <div className="cards">
              {results.map((course, i) => (
                <CourseCard key={`${course.code}-${course.semester}`} course={course} rank={i + 1} />
              ))}
            </div>
          </>
        )}

        {status === "done" && results.length === 0 && (
          <div className="status">Žádné předměty nenalezeny.</div>
        )}
      </main>
    </>
  );
}
