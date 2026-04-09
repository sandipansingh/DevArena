import { describe, expect, it } from "vitest";
import { API_BASE_URL } from "./api";
import {
  authBootstrapFailureState,
  bootstrapFromStoredToken,
  phaseToPath,
} from "./appFlow";

describe("api config", () => {
  it("has a non-empty base url", () => {
    expect(typeof API_BASE_URL).toBe("string");
    expect(API_BASE_URL.length).toBeGreaterThan(0);
  });

  it("defaults to localhost for local dev", () => {
    expect(API_BASE_URL.includes("http")).toBe(true);
  });
});

describe("app flow bootstrap", () => {
  it("uses loading phase when token is present", () => {
    const state = bootstrapFromStoredToken("valid-token");
    expect(state.token).toBe("valid-token");
    expect(state.phase).toBe("loading");
  });

  it("uses auth phase when token is missing", () => {
    const state = bootstrapFromStoredToken("");
    expect(state.token).toBe("");
    expect(state.phase).toBe("auth");
  });

  it("resets to auth state for invalid token recovery", () => {
    const state = authBootstrapFailureState();
    expect(state.token).toBe("");
    expect(state.phase).toBe("auth");
  });
});

describe("phase routing", () => {
  it("maps battle phase to battle route", () => {
    expect(phaseToPath("battle")).toBe("/battle");
  });

  it("maps result phase to result route", () => {
    expect(phaseToPath("result")).toBe("/result");
  });
});
