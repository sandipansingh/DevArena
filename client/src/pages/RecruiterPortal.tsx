import { useEffect, useState } from "react";
import { getRecruiterCandidates } from "../api";
import type { RecruiterCandidate } from "../api";

type RecruiterPortalProps = {
  token: string;
  onError: (message: string) => void;
};

function RecruiterPortal({ token, onError }: RecruiterPortalProps) {
  const [tier, setTier] = useState<
    "" | "Bronze" | "Silver" | "Gold" | "Platinum"
  >("");
  const [language, setLanguage] = useState<string>("");
  const [candidates, setCandidates] = useState<RecruiterCandidate[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    getRecruiterCandidates(token, {
      tier: tier || undefined,
      language: language.trim() || undefined,
      limit: 30,
    })
      .then((rows) => {
        if (cancelled) {
          return;
        }
        setCandidates(rows);
      })
      .catch((error: Error) => {
        if (cancelled) {
          return;
        }
        onError(error.message || "Failed to load candidates");
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [tier, language, token, onError]);

  return (
    <section className="card recruiter-card">
      <div className="recruiter-head">
        <h3>Recruiter Talent Discovery</h3>
        <p className="hint">
          Filter by tier and language to find qualified candidates quickly.
        </p>
      </div>

      <div className="recruiter-filters">
        <label>
          Tier
          <select
            value={tier}
            onChange={(event) =>
              setTier(
                event.target.value as
                  | ""
                  | "Bronze"
                  | "Silver"
                  | "Gold"
                  | "Platinum",
              )
            }
          >
            <option value="">All</option>
            <option value="Bronze">Bronze</option>
            <option value="Silver">Silver</option>
            <option value="Gold">Gold</option>
            <option value="Platinum">Platinum</option>
          </select>
        </label>

        <label>
          Language
          <input
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            placeholder="javascript, python, java"
          />
        </label>
      </div>

      {loading ? <p>Loading candidate data...</p> : null}

      <div className="candidate-grid">
        {candidates.map((candidate) => (
          <article className="candidate-item" key={candidate.id}>
            <header>
              <h4>{candidate.username}</h4>
              <span
                className={`tier-badge tier-${candidate.tier.toLowerCase()}`}
              >
                {candidate.tier}
              </span>
            </header>
            <p>
              Rating: <strong>{candidate.rating}</strong> | Win Rate:{" "}
              <strong>{candidate.winRate}%</strong>
            </p>
            <p>Matches: {candidate.matchesPlayed}</p>
            <p>
              Languages:{" "}
              {candidate.primaryLanguages.length > 0
                ? candidate.primaryLanguages.join(", ")
                : "Not set"}
            </p>
            {candidate.aiHighlight ? (
              <div className="candidate-feedback">
                <p>
                  <strong>AI Highlight:</strong> {candidate.aiHighlight.summary}
                </p>
                <p>
                  <strong>Suggestion:</strong>{" "}
                  {candidate.aiHighlight.suggestions ||
                    "No specific suggestion"}
                </p>
              </div>
            ) : (
              <p className="hint">No AI feedback yet.</p>
            )}
          </article>
        ))}
      </div>

      {!loading && candidates.length === 0 ? (
        <p className="hint">No candidates matched the current filters.</p>
      ) : null}
    </section>
  );
}

export default RecruiterPortal;
