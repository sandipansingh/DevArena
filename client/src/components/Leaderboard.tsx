import type { LeaderboardUser } from "../api";

function tierFromRating(
  rating: number,
): "Bronze" | "Silver" | "Gold" | "Platinum" {
  if (rating >= 1800) {
    return "Platinum";
  }
  if (rating >= 1500) {
    return "Gold";
  }
  if (rating >= 1300) {
    return "Silver";
  }
  return "Bronze";
}

type LeaderboardProps = {
  entries: LeaderboardUser[];
};

function Leaderboard({ entries }: LeaderboardProps) {
  return (
    <ol className="leaderboard-list">
      {entries.map((entry) => {
        const tier = tierFromRating(entry.rating);

        return (
          <li key={entry.id}>
            <span className="leader-name">{entry.username}</span>
            <span className={`tier-badge tier-${tier.toLowerCase()}`}>
              {tier}
            </span>
            <span className="leader-rating">{entry.rating}</span>
          </li>
        );
      })}
    </ol>
  );
}

export default Leaderboard;
