export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

export type User = {
  id: string;
  username: string;
  rating: number;
  wins: number;
  losses: number;
  matchesPlayed: number;
};

export type AuthResponse = {
  token: string;
  user: User;
};

export type LeaderboardUser = {
  id: string;
  username: string;
  rating: number;
  wins: number;
  losses: number;
};

export type Problem = {
  id: string;
  title: string;
  difficulty: "easy" | "medium" | "hard";
  description: string;
  constraints: string[];
  sampleInput: string;
  sampleOutput: string;
  source?: string;
};

export type BattlePlayer = {
  userId: string;
  username: string;
};

export type BattleReadyPayload = {
  roomId: string;
  difficulty: "easy" | "medium" | "hard";
  startedAt: number;
  endsAt: number;
  problem: Problem;
  players: BattlePlayer[];
};

export type BattleFinishedPayload = {
  roomId: string;
  reason: string;
  winnerId: string;
  ai?: {
    summary: string;
    winnerReason: string;
    qualityScores: Record<string, number>;
    perPlayer: Array<{
      userId: string;
      strengths: string;
      weaknesses: string;
      suggestions: string;
    }>;
  } | null;
  players: Array<{
    userId: string;
    username: string;
    rating: number;
  }>;
};

export type Tournament = {
  id: string;
  name: string;
  status: "upcoming" | "live" | "completed";
  players: number;
};

async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  const data = await response.json();

  if (!response.ok) {
    const message = typeof data?.message === "string" ? data.message : "Request failed";
    throw new Error(message);
  }

  return data as T;
}

export function login(username: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function register(username: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function getMe(token: string): Promise<User> {
  return request<User>("/users/me", { method: "GET" }, token);
}

export function getLeaderboard(): Promise<LeaderboardUser[]> {
  return request<LeaderboardUser[]>("/leaderboard", { method: "GET" });
}

export function getTournaments(): Promise<Tournament[]> {
  return request<Tournament[]>("/tournaments", { method: "GET" });
}
