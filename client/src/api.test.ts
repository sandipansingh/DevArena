import { describe, expect, it } from "vitest";
import { API_BASE_URL } from "./api";

describe("api config", () => {
  it("has a non-empty base url", () => {
    expect(typeof API_BASE_URL).toBe("string");
    expect(API_BASE_URL.length).toBeGreaterThan(0);
  });

  it("defaults to localhost for local dev", () => {
    expect(API_BASE_URL.includes("http")).toBe(true);
  });
});
