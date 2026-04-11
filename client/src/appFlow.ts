export type Difficulty = "easy" | "medium" | "hard";

export type Phase =
  | "loading"
  | "auth"
  | "dashboard"
  | "recruiter"
  | "queue"
  | "battle"
  | "result";

export type SocketErrorPayload = {
  code?: string;
  message?: string;
  retryable?: boolean;
  details?: unknown;
};

export function phaseToPath(phase: Phase): string {
  if (phase === "auth") return "/auth";
  if (phase === "dashboard") return "/dashboard";
  if (phase === "recruiter") return "/recruiter";
  if (phase === "queue") return "/queue";
  if (phase === "battle") return "/battle";
  if (phase === "result") return "/result";
  return "/auth";
}

export function bootstrapFromStoredToken(storedToken: string | null): {
  token: string;
  phase: Phase;
} {
  const token = String(storedToken || "");
  if (!token) {
    return {
      token: "",
      phase: "auth",
    };
  }

  return {
    token,
    phase: "loading",
  };
}

export function authBootstrapFailureState(): { token: string; phase: Phase } {
  return {
    token: "",
    phase: "auth",
  };
}

export function describeQueueStatus(payload: {
  status: string;
  difficulty?: Difficulty;
  queueSize?: number;
}): string {
  const difficulty = payload.difficulty || "easy";

  if (payload.status === "waiting") {
    const sizeText =
      typeof payload.queueSize === "number"
        ? ` (${payload.queueSize} in queue)`
        : "";
    return `Searching ${difficulty} queue${sizeText}`;
  }

  if (payload.status === "idle") {
    return "Queue idle";
  }

  if (payload.status === "matched") {
    return "Match found";
  }

  if (payload.status === "invalid-request") {
    return "Queue request invalid";
  }

  return payload.status || "Queue update received";
}

export function formatSocketError(
  payload: SocketErrorPayload | null | undefined,
  fallbackMessage: string,
): string {
  if (payload?.message && payload.code) {
    return `${payload.message} (${payload.code})`;
  }

  if (payload?.message) {
    return payload.message;
  }

  return fallbackMessage;
}
