import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import Editor from "@monaco-editor/react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import {
  API_BASE_URL,
  getLeaderboard,
  getMe,
  getTournaments,
  login,
  register,
} from "./api";
import type {
  BattleFinishedPayload,
  BattleReadyPayload,
  LeaderboardUser,
  Tournament,
  User,
} from "./api";
import {
  authBootstrapFailureState,
  bootstrapFromStoredToken,
  describeQueueStatus,
  formatSocketError,
  phaseToPath,
} from "./appFlow";
import type { Difficulty, Phase, SocketErrorPayload } from "./appFlow";
import "./App.css";

type SubmissionMessage = {
  userId: string;
  passed: boolean;
  engine?: string;
  status?: string;
  stderr?: string;
  runtime?: string | number | null;
  memory?: string | number | null;
  submittedAt?: number;
};

type ChatMessage = {
  userId: string;
  username: string;
  message: string;
  timestamp: number;
};

type BattleStatePayload = {
  roomId: string;
  difficulty: Difficulty;
  startedAt: number;
  endsAt: number;
  problem: BattleReadyPayload["problem"];
  players: BattleReadyPayload["players"];
  chats: ChatMessage[];
  submissions: SubmissionMessage[];
};

const TOKEN_KEY = "devarena-token";

function getInitialToken(): string {
  if (typeof window === "undefined") {
    return "";
  }

  return localStorage.getItem(TOKEN_KEY) || "";
}

const initialBootstrap = bootstrapFromStoredToken(getInitialToken());

function App() {
  const navigate = useNavigate();
  const [token, setToken] = useState<string>(initialBootstrap.token);
  const [phase, setPhase] = useState<Phase>(initialBootstrap.phase);
  const [user, setUser] = useState<User | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardUser[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [error, setError] = useState<string>("");
  const [isRegisterMode, setIsRegisterMode] = useState<boolean>(false);

  const [username, setUsername] = useState<string>("");
  const [password, setPassword] = useState<string>("");

  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const [queueStatus, setQueueStatus] = useState<string>("idle");
  const [connectionStatus, setConnectionStatus] = useState<string>("");

  const [socket, setSocket] = useState<Socket | null>(null);
  const [battle, setBattle] = useState<BattleReadyPayload | null>(null);
  const [result, setResult] = useState<BattleFinishedPayload | null>(null);
  const [submissions, setSubmissions] = useState<SubmissionMessage[]>([]);
  const [code, setCode] = useState<string>(
    "function solve(input) {\n  // write your solution\n  return input\n}",
  );
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [opponentChars, setOpponentChars] = useState<number>(0);
  const [language, setLanguage] = useState<"javascript" | "python" | "java">(
    "javascript",
  );
  const [chatInput, setChatInput] = useState<string>("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  const currentOpponent = useMemo(() => {
    if (!battle || !user) {
      return null;
    }

    return battle.players.find((player) => player.userId !== user.id) ?? null;
  }, [battle, user]);

  useEffect(() => {
    if (phase === "loading") {
      return;
    }

    navigate(phaseToPath(phase), { replace: true });
  }, [phase, navigate]);

  useEffect(() => {
    if (!token) {
      return;
    }

    getMe(token)
      .then((me) => {
        setUser(me);
        setPhase("dashboard");
      })
      .catch(() => {
        const fallbackState = authBootstrapFailureState();
        localStorage.removeItem(TOKEN_KEY);
        setToken(fallbackState.token);
        setUser(null);
        setPhase(fallbackState.phase);
      });
  }, [token]);

  useEffect(() => {
    if (phase !== "dashboard" && phase !== "result") {
      return;
    }

    getLeaderboard()
      .then(setLeaderboard)
      .catch(() => undefined);
    getTournaments()
      .then(setTournaments)
      .catch(() => undefined);
  }, [phase]);

  useEffect(() => {
    if (!battle) {
      return;
    }

    const timer = window.setInterval(() => {
      const next = Math.max(0, Math.floor((battle.endsAt - Date.now()) / 1000));
      setTimeLeft(next);
    }, 250);

    return () => window.clearInterval(timer);
  }, [battle]);

  useEffect(() => {
    if (!socket || !battle) {
      return;
    }

    socket.emit("battle:typing", {
      roomId: battle.roomId,
      chars: code.length,
    });
  }, [socket, battle, code]);

  function resetBattleState() {
    setBattle(null);
    setResult(null);
    setSubmissions([]);
    setOpponentChars(0);
    setCode(
      "function solve(input) {\n  // write your solution\n  return input\n}",
    );
    setTimeLeft(0);
    setLanguage("javascript");
    setChatInput("");
    setChatMessages([]);
    setConnectionStatus("");
  }

  function disconnectSocket() {
    if (!socket) {
      return;
    }

    socket.emit("queue:leave");
    socket.disconnect();
    setSocket(null);
    setConnectionStatus("");
  }

  function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const action = isRegisterMode ? register : login;
    action(username.trim(), password)
      .then((response) => {
        localStorage.setItem(TOKEN_KEY, response.token);
        setToken(response.token);
        setUser(response.user);
        setUsername("");
        setPassword("");
        setPhase("dashboard");
      })
      .catch((authError: Error) => {
        setError(authError.message);
      });
  }

  function startQueue() {
    if (!token) {
      return;
    }

    if (socket) {
      disconnectSocket();
    }

    setError("");
    resetBattleState();

    const socketConnection = io(API_BASE_URL, {
      auth: { token },
      transports: ["websocket"],
    });

    socketConnection.on("connect", () => {
      setConnectionStatus("Connected");
      setError("");
      socketConnection.emit("queue:join", { difficulty });
      setQueueStatus(
        describeQueueStatus({ status: "waiting", difficulty, queueSize: 1 }),
      );
      setPhase("queue");
    });

    socketConnection.on(
      "queue:status",
      (payload: { status: string; queueSize?: number }) => {
        setQueueStatus(
          describeQueueStatus({
            status: payload.status,
            difficulty,
            queueSize: payload.queueSize,
          }),
        );
        if (payload.status === "waiting") {
          setConnectionStatus("Connected to queue");
        }
      },
    );

    socketConnection.on("queue:error", (payload: SocketErrorPayload) => {
      setError(formatSocketError(payload, "Queue request failed"));
      setConnectionStatus("Queue error. Review request and retry.");
    });

    socketConnection.on("battle:ready", (payload: BattleReadyPayload) => {
      setQueueStatus("Match found");
      setBattle(payload);
      setTimeLeft(
        Math.max(0, Math.floor((payload.endsAt - Date.now()) / 1000)),
      );
      setConnectionStatus("Live battle connected");
      setPhase("battle");
    });

    socketConnection.on("battle:state", (payload: BattleStatePayload) => {
      setBattle((prev) => {
        if (!prev) {
          return {
            roomId: payload.roomId,
            difficulty: payload.difficulty,
            startedAt: payload.startedAt,
            endsAt: payload.endsAt,
            problem: payload.problem,
            players: payload.players,
          };
        }

        return {
          ...prev,
          players: payload.players,
          startedAt: payload.startedAt,
          endsAt: payload.endsAt,
        };
      });
      setChatMessages(payload.chats || []);
      setSubmissions(payload.submissions || []);
      setTimeLeft(
        Math.max(0, Math.floor((payload.endsAt - Date.now()) / 1000)),
      );
      setConnectionStatus("Reconnected to battle and restored state");
      setPhase("battle");
    });

    socketConnection.on(
      "battle:presence",
      (payload: { userId: string; connected: boolean }) => {
        setBattle((prev) => {
          if (!prev) {
            return prev;
          }

          return {
            ...prev,
            players: prev.players.map((player) =>
              player.userId === payload.userId
                ? { ...player, connected: payload.connected }
                : player,
            ),
          };
        });
      },
    );

    socketConnection.on(
      "battle:opponent-typing",
      (payload: { chars: number }) => {
        setOpponentChars(payload.chars);
      },
    );

    socketConnection.on(
      "battle:submission-result",
      (payload: SubmissionMessage) => {
        setSubmissions((prev) => [...prev, payload]);
      },
    );

    socketConnection.on("battle:finished", (payload: BattleFinishedPayload) => {
      setResult(payload);
      setConnectionStatus("");
      setPhase("result");
      if (token) {
        getMe(token)
          .then(setUser)
          .catch(() => undefined);
      }
    });

    socketConnection.on("disconnect", (reason) => {
      if (reason === "io client disconnect") {
        return;
      }

      setConnectionStatus("Connection lost, reconnecting...");
    });

    socketConnection.io.on("reconnect_attempt", () => {
      setConnectionStatus("Reconnecting...");
    });

    socketConnection.io.on("reconnect", () => {
      setConnectionStatus("Reconnected. Restoring battle state...");
    });

    socketConnection.on("connect_error", (socketError: Error) => {
      setError(socketError.message || "Unable to connect to server");
      setPhase("dashboard");
    });

    socketConnection.on("battle:error", (payload: SocketErrorPayload) => {
      setError(formatSocketError(payload, "Battle request failed"));
    });

    socketConnection.on("battle:chat", (payload: ChatMessage) => {
      setChatMessages((prev) => [...prev.slice(-19), payload]);
    });

    setSocket(socketConnection);
  }

  function leaveQueue() {
    disconnectSocket();
    setQueueStatus(describeQueueStatus({ status: "idle", difficulty }));
    setPhase("dashboard");
  }

  function submitCode() {
    if (!socket || !battle) {
      return;
    }

    socket.emit("battle:submit", {
      roomId: battle.roomId,
      code,
      language,
    });
  }

  function sendChat() {
    if (!socket || !battle || !chatInput.trim()) {
      return;
    }

    socket.emit("battle:chat", {
      roomId: battle.roomId,
      message: chatInput,
    });
    setChatInput("");
  }

  function playAgain() {
    leaveQueue();
    resetBattleState();
  }

  function logout() {
    disconnectSocket();
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setUser(null);
    setPhase("auth");
    resetBattleState();
  }

  if (phase === "loading") {
    return <main className="container">Booting DevArena...</main>;
  }

  const authView = (
    <main className="container auth-layout">
      <section className="brand-panel">
        <p className="eyebrow">DEVARENA</p>
        <h1>Real-time coding duels built for interview pressure.</h1>
        <p>
          Practice in live 1v1 battles, watch opponent momentum, and sharpen
          speed under clock constraints.
        </p>
        <p className="hint">Demo account: demo / password123</p>
      </section>

      <section className="card">
        <h2>{isRegisterMode ? "Create Account" : "Welcome Back"}</h2>
        <form onSubmit={handleAuth} className="stack">
          <label>
            Username
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="coder01"
              minLength={3}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="at least 6 chars"
              minLength={6}
              required
            />
          </label>
          <button type="submit" className="primary-btn">
            {isRegisterMode ? "Register" : "Login"}
          </button>
        </form>
        <button
          type="button"
          className="link-btn"
          onClick={() => setIsRegisterMode((prev) => !prev)}
        >
          {isRegisterMode
            ? "Already have an account? Login"
            : "New here? Register"}
        </button>
        {error ? <p className="error-text">{error}</p> : null}
      </section>
    </main>
  );

  const shellHeader = (
    <header className="topbar">
      <div>
        <p className="eyebrow">DevArena</p>
        <h2>
          {user?.username} • {user?.rating ?? 1200} ELO
        </h2>
      </div>
      <button type="button" className="ghost-btn" onClick={logout}>
        Logout
      </button>
    </header>
  );

  const dashboardView = (
    <main className="container app-layout">
      {shellHeader}
      <section className="dashboard-grid">
        <article className="card">
          <h3>Queue Up</h3>
          <p>Pick difficulty and search for a live opponent.</p>
          <div className="difficulty-row">
            {(["easy", "medium", "hard"] as Difficulty[]).map((level) => (
              <button
                type="button"
                key={level}
                className={difficulty === level ? "chip chip-active" : "chip"}
                onClick={() => setDifficulty(level)}
              >
                {level}
              </button>
            ))}
          </div>
          <button type="button" className="primary-btn" onClick={startQueue}>
            Find Match
          </button>
        </article>

        <article className="card">
          <h3>Your Stats</h3>
          <p>Matches: {user?.matchesPlayed ?? 0}</p>
          <p>Wins: {user?.wins ?? 0}</p>
          <p>Losses: {user?.losses ?? 0}</p>
        </article>

        <article className="card leaderboard">
          <h3>Leaderboard</h3>
          <ol>
            {leaderboard.map((entry) => (
              <li key={entry.id}>
                <span>{entry.username}</span>
                <span>{entry.rating}</span>
              </li>
            ))}
          </ol>
        </article>

        <article className="card leaderboard">
          <h3>Live Tournaments</h3>
          <ol>
            {tournaments.map((entry) => (
              <li key={entry.id}>
                <span>{entry.name}</span>
                <span>{entry.status}</span>
              </li>
            ))}
          </ol>
        </article>

        <article className="card leaderboard">
          <h3>Recent Matches</h3>
          <ol>
            {(user?.recentMatches || []).length === 0 ? (
              <li>
                <span>No matches yet</span>
                <span>-</span>
              </li>
            ) : (
              (user?.recentMatches || []).map((entry) => (
                <li key={`${entry.roomId}-${entry.endedAt}`}>
                  <span>
                    {entry.result.toUpperCase()} vs {entry.opponentUsername}
                  </span>
                  <span>
                    {entry.ratingDelta >= 0
                      ? `+${entry.ratingDelta}`
                      : entry.ratingDelta}
                  </span>
                </li>
              ))
            )}
          </ol>
        </article>
      </section>
      {error ? <p className="error-text">{error}</p> : null}
    </main>
  );

  const queueView = (
    <main className="container app-layout">
      {shellHeader}
      <section className="card queue-card">
        <h3>Searching for Opponent</h3>
        <p>Difficulty: {difficulty}</p>
        <p>Status: {queueStatus}</p>
        {connectionStatus ? <p className="hint">{connectionStatus}</p> : null}
        <button type="button" className="ghost-btn" onClick={leaveQueue}>
          Cancel Queue
        </button>
      </section>
      {error ? <p className="error-text">{error}</p> : null}
    </main>
  );

  const battleView = (
    <main className="container app-layout">
      {shellHeader}
      <section className="battle-grid">
        <article className="card">
          <h3>{battle?.problem.title}</h3>
          <p className="hint">
            Source:{" "}
            {battle?.problem.source === "ai"
              ? "AI-generated"
              : "Problem library"}
          </p>
          <p>{battle?.problem.description}</p>
          <h4>Constraints</h4>
          <ul>
            {(battle?.problem.constraints || []).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <h4>Example</h4>
          <p>
            <strong>Input:</strong> {battle?.problem.sampleInput}
          </p>
          <p>
            <strong>Output:</strong> {battle?.problem.sampleOutput}
          </p>
        </article>

        <article className="card">
          <div className="battle-head">
            <h3>Battle Room</h3>
            <span className="timer">{timeLeft}s</span>
          </div>
          <p>Opponent: {currentOpponent?.username ?? "Unknown"}</p>
          <p>
            Opponent connection:{" "}
            {currentOpponent?.connected === false ? "reconnecting" : "online"}
          </p>
          <p>Opponent activity: {opponentChars} chars</p>
          {connectionStatus ? <p className="hint">{connectionStatus}</p> : null}
          <label>
            Language
            <select
              value={language}
              onChange={(event) =>
                setLanguage(
                  event.target.value as "javascript" | "python" | "java",
                )
              }
            >
              <option value="javascript">JavaScript</option>
              <option value="python">Python</option>
              <option value="java">Java</option>
            </select>
          </label>
          <div className="editor-wrap">
            <Editor
              height="320px"
              defaultLanguage="javascript"
              language={language === "java" ? "java" : language}
              value={code}
              onChange={(value) => setCode(value || "")}
              theme="vs-dark"
              options={{
                minimap: { enabled: false },
                fontSize: 14,
                automaticLayout: true,
              }}
            />
          </div>
          <button type="button" className="primary-btn" onClick={submitCode}>
            Submit Code
          </button>
          <div className="chat-wrap">
            <div className="chat-log">
              {chatMessages.map((item, index) => (
                <p key={`${item.timestamp}-${index}`}>
                  <strong>{item.username}:</strong> {item.message}
                </p>
              ))}
            </div>
            <div className="chat-input-row">
              <input
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                placeholder="Send a quick battle message"
              />
              <button type="button" className="ghost-btn" onClick={sendChat}>
                Send
              </button>
            </div>
          </div>
          <div className="submission-log">
            {submissions.map((item, index) => (
              <p key={`${item.userId}-${index}`}>
                {item.userId === user?.id ? "You" : "Opponent"} submitted:{" "}
                {item.passed ? "Accepted" : "Wrong Answer"}
                {item.engine ? ` (${item.engine})` : ""}
                {item.runtime !== null && item.runtime !== undefined
                  ? ` • ${item.runtime}s`
                  : ""}
                {item.memory !== null && item.memory !== undefined
                  ? ` • ${item.memory}KB`
                  : ""}
              </p>
            ))}
          </div>
        </article>
      </section>
      {error ? <p className="error-text">{error}</p> : null}
    </main>
  );

  const resultTitle = result?.winnerId
    ? result.winnerId === user?.id
      ? "Victory"
      : "Defeat"
    : "Draw";

  const resultView = (
    <main className="container app-layout">
      {shellHeader}
      <section className="card result-card">
        <h3>{resultTitle}</h3>
        <p>Reason: {result?.reason}</p>
        {result?.ai ? (
          <div className="ai-feedback">
            <h4>AI Match Review</h4>
            <p>{result.ai.summary}</p>
            <p>
              <strong>Winner Analysis:</strong> {result.ai.winnerReason}
            </p>
            {result.ai.perPlayer
              .filter((entry) => entry.userId === user?.id)
              .map((entry) => (
                <div key={entry.userId}>
                  <p>
                    <strong>Strengths:</strong> {entry.strengths}
                  </p>
                  <p>
                    <strong>Weaknesses:</strong> {entry.weaknesses}
                  </p>
                  <p>
                    <strong>Suggestions:</strong> {entry.suggestions}
                  </p>
                </div>
              ))}
          </div>
        ) : null}
        <ul>
          {(result?.players || []).map((player) => (
            <li key={player.userId}>
              {player.username}: {player.rating} ELO
            </li>
          ))}
        </ul>
        <button type="button" className="primary-btn" onClick={playAgain}>
          Back to Dashboard
        </button>
      </section>
      {error ? <p className="error-text">{error}</p> : null}
    </main>
  );

  return (
    <Routes>
      <Route path="/auth" element={authView} />
      <Route path="/dashboard" element={dashboardView} />
      <Route path="/queue" element={queueView} />
      <Route path="/battle" element={battleView} />
      <Route path="/result" element={resultView} />
      <Route path="*" element={<Navigate to={phaseToPath(phase)} replace />} />
    </Routes>
  );
}

export default App;
