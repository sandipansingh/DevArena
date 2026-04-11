// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import {
  getLeaderboard,
  getMe,
  getMyAiFeedback,
  getTournaments,
  login,
} from "./api";

type Listener = (payload?: any) => void;

class FakeSocket {
  connected = true;

  listeners = new Map<string, Listener[]>();

  ioListeners = new Map<string, Listener[]>();

  io = {
    on: (event: string, listener: Listener) => {
      const current = this.ioListeners.get(event) || [];
      current.push(listener);
      this.ioListeners.set(event, current);
    },
  };

  on(event: string, listener: Listener) {
    const current = this.listeners.get(event) || [];
    current.push(listener);
    this.listeners.set(event, current);
    return this;
  }

  once(event: string, listener: Listener) {
    const wrapped = (payload?: any) => {
      this.off(event, wrapped);
      listener(payload);
    };
    return this.on(event, wrapped);
  }

  off(event: string, listener: Listener) {
    const current = this.listeners.get(event) || [];
    this.listeners.set(
      event,
      current.filter((entry) => entry !== listener),
    );
    return this;
  }

  emit = vi.fn();

  disconnect() {
    this.connected = false;
  }

  trigger(event: string, payload?: any) {
    const current = this.listeners.get(event) || [];
    for (const listener of current) {
      listener(payload);
    }
  }
}

let latestSocket: FakeSocket | null = null;

vi.mock("socket.io-client", () => ({
  io: () => {
    latestSocket = new FakeSocket();
    return latestSocket;
  },
}));

vi.mock("@monaco-editor/react", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="code-editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    login: vi.fn(),
    register: vi.fn(),
    getMe: vi.fn(),
    getLeaderboard: vi.fn(),
    getTournaments: vi.fn(),
    getMyAiFeedback: vi.fn(),
  };
});

function fakeReadyPayload() {
  return {
    roomId: "room-1",
    difficulty: "easy",
    startedAt: Date.now(),
    endsAt: Date.now() + 60_000,
    problem: {
      id: "p-1",
      title: "Sample",
      difficulty: "easy",
      description: "desc",
      constraints: ["c1"],
      sampleInput: "in",
      sampleOutput: "out",
      source: "library",
    },
    players: [
      {
        userId: "u-1",
        username: "tester",
        rating: 1200,
        connected: true,
      },
      {
        userId: "u-2",
        username: "opponent",
        rating: 1200,
        connected: true,
      },
    ],
  };
}

async function renderIntoBattle() {
  vi.mocked(login).mockResolvedValue({
    token: "token-1",
    user: {
      id: "u-1",
      username: "tester",
      role: "developer",
      rating: 1200,
      wins: 0,
      losses: 0,
      matchesPlayed: 0,
    },
  });
  vi.mocked(getMe).mockResolvedValue({
    id: "u-1",
    username: "tester",
    role: "developer",
    rating: 1200,
    wins: 0,
    losses: 0,
    matchesPlayed: 0,
  });
  vi.mocked(getLeaderboard).mockResolvedValue([]);
  vi.mocked(getTournaments).mockResolvedValue([]);
  vi.mocked(getMyAiFeedback).mockResolvedValue([]);

  render(
    <MemoryRouter initialEntries={["/auth"]}>
      <App />
    </MemoryRouter>,
  );

  await userEvent.type(screen.getByPlaceholderText("coder01"), "tester");
  await userEvent.type(
    screen.getByPlaceholderText("at least 6 chars"),
    "password123",
  );
  await userEvent.click(screen.getByRole("button", { name: "Login" }));

  await screen.findByText("Queue Up");
  await userEvent.click(screen.getByRole("button", { name: "Find Match" }));

  const socket = latestSocket;
  if (!socket) {
    throw new Error("socket not initialized");
  }

  act(() => {
    socket.trigger("connect");
    socket.trigger("battle:ready", fakeReadyPayload());
  });

  await screen.findByText("Battle Room");
  return socket;
}

describe("battle client behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    latestSocket = null;
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("disables submit while pending and re-enables after verdict", async () => {
    const socket = await renderIntoBattle();

    const submitButton = screen.getByRole("button", { name: "Submit Code" });
    expect(submitButton).toBeEnabled();

    await userEvent.click(submitButton);
    expect(
      screen.getByRole("button", { name: "Submitting..." }),
    ).toBeDisabled();

    act(() => {
      socket.trigger("battle:submission-result", {
        userId: "u-1",
        passed: false,
        verdict: "compile-error",
        status: "Compilation Error",
        stderr: "Unexpected token",
      });
    });

    expect(await screen.findByText(/Compile error:/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit Code" })).toBeEnabled();
  });

  it("renders actionable room inactive error", async () => {
    const socket = await renderIntoBattle();

    act(() => {
      socket.trigger("battle:error", {
        code: "ROOM_NOT_ACTIVE",
        message: "Battle room is not active",
      });
    });

    expect(
      await screen.findByText(/Battle room is not active/),
    ).toBeInTheDocument();
  });

  it("transitions to result view immediately after finalization event", async () => {
    const socket = await renderIntoBattle();

    act(() => {
      socket.trigger("battle:finished", {
        roomId: "room-1",
        reason: "early-accepted",
        winnerId: "u-1",
        players: [
          { userId: "u-1", username: "tester", rating: 1212 },
          { userId: "u-2", username: "opponent", rating: 1188 },
        ],
      });
    });

    expect(await screen.findByText("Victory")).toBeInTheDocument();
    expect(screen.getByText(/Reason:/)).toBeInTheDocument();
  });
});
