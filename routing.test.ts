import { afterEach, describe, expect, test } from "bun:test";
import { __setFetcherForTests, globalChain, presetChain, refreshRouting, routingStatus } from "./routing";

const CONST = ["openrouter/openai/gpt-5.2"];

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function table(profile: string, chains: Record<string, string[]>) {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return ok({ profile, chains });
  };
  return { fetcher, calls: () => calls };
}

afterEach(() => __setFetcherForTests(null));

describe("presetChain", () => {
  test("uses Toscanini's chain for the key", async () => {
    const t = table("anthropic", { "podcast/episode": ["openrouter/anthropic/claude-sonnet-5.5"] });
    __setFetcherForTests(t.fetcher);
    expect(await presetChain("podcast/episode", CONST)).toEqual(["openrouter/anthropic/claude-sonnet-5.5"]);
  });

  test("falls back to the preset constant for an unknown key or empty chain", async () => {
    __setFetcherForTests(table("third-party", { other: ["x/y"], empty: [] }).fetcher);
    expect(await presetChain("podcast/episode", CONST)).toEqual(CONST);
    expect(await presetChain("empty", CONST)).toEqual(CONST);
  });

  test("falls back to the constant when Toscanini is down and there is no previous table", async () => {
    __setFetcherForTests(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await presetChain("podcast/episode", CONST)).toEqual(CONST);
    expect((await routingStatus()).source).toBe("preset-constants");
  });

  test("non-200 and malformed bodies count as down", async () => {
    __setFetcherForTests(async () => new Response("boom", { status: 502 }));
    expect(await presetChain("k", CONST)).toEqual(CONST);
    __setFetcherForTests(async () => ok({ nope: true }));
    expect(await presetChain("k", CONST)).toEqual(CONST);
  });

  test("keeps the last good table when Toscanini goes down", async () => {
    let up = true;
    __setFetcherForTests(async () => {
      if (!up) throw new Error("down");
      return ok({ profile: "anthropic", chains: { k: ["openrouter/anthropic/claude-opus-5.5"] } });
    });
    expect(await presetChain("k", CONST)).toEqual(["openrouter/anthropic/claude-opus-5.5"]);
    up = false;
    refreshRouting();
    expect(await presetChain("k", CONST)).toEqual(["openrouter/anthropic/claude-opus-5.5"]);
  });

  test("caches: many calls, one fetch; refresh forces a new fetch", async () => {
    const t = table("third-party", { k: ["a/b"] });
    __setFetcherForTests(t.fetcher);
    await Promise.all([presetChain("k", CONST), presetChain("k", CONST), presetChain("j", CONST)]);
    await presetChain("k", CONST);
    expect(t.calls()).toBe(1);
    refreshRouting();
    await presetChain("k", CONST);
    expect(t.calls()).toBe(2);
  });

  test("returned chains are copies (callers may mutate)", async () => {
    __setFetcherForTests(table("p", { k: ["a/b"] }).fetcher);
    const first = await presetChain("k", CONST);
    first.push("mutated/x");
    expect(await presetChain("k", CONST)).toEqual(["a/b"]);
  });
});

describe("globalChain", () => {
  test("reads the 'default' key", async () => {
    __setFetcherForTests(table("p", { default: ["openrouter/deepseek/deepseek-v3.2"] }).fetcher);
    expect(await globalChain(CONST)).toEqual(["openrouter/deepseek/deepseek-v3.2"]);
  });
});

describe("routingStatus", () => {
  test("reports source and profile", async () => {
    __setFetcherForTests(table("anthropic", { k: ["a/b"] }).fetcher);
    expect(await routingStatus()).toEqual({ source: "toscanini", profile: "anthropic", chains: { k: ["a/b"] } });
  });
});

