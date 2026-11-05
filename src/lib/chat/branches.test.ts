// @vitest-environment node
/**
 * chat/branches — the CHAT BRANCHES pure helpers (2026-11-05). These pin
 * the walk that decides what a conversation SHOWS and what the model
 * RECEIVES as history — the highest-leverage logic of the feature.
 */
import { describe, expect, it } from "vitest";
import {
  buildBranchInfo,
  childrenMap,
  deepestLeafOf,
  resolveActiveBranch,
  siblingGroup,
  type BranchNode,
} from "./branches";

let seq = 0;
function msg(id: string, parent: string | null, ts?: string): BranchNode {
  return { id, parent_id: parent, created_at: ts ?? `2026-01-01T00:00:${String(seq++).padStart(2, "0")}` };
}

function tree(): BranchNode[] {
  seq = 0;
  // Legacy flat prefix: u1 a1 (no parents), then a fork at u2/u2':
  //   u1 → a1 → u2 → a2 → u3 → a3      (original branch)
  //              ↘ u2' → a2'           (edited branch)
  // and a regenerate fork under u3: a3 / a3'
  return [
    msg("u1", null),
    msg("a1", null),
    msg("u2", "a1"),
    msg("a2", "u2"),
    msg("u2p", "a1"),
    msg("a2p", "u2p"),
    msg("u3", "a2"),
    msg("a3", "u3"),
    msg("a3p", "u3"),
  ];
}

describe("resolveActiveBranch — the walk", () => {
  it("legacy flat conversations render verbatim (no parents, no leaf)", () => {
    const flat = [msg("m1", null), msg("m2", null), msg("m3", null)];
    expect(resolveActiveBranch(flat, null).map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(resolveActiveBranch(flat, undefined).map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("walks the parent chain from the leaf — sibling branches are excluded", () => {
    const all = tree();
    // Active leaf = a3 (original branch): u1 a1 u2 a2 u3 a3 — u2p/a2p/a3p gone.
    expect(resolveActiveBranch(all, "a3").map((m) => m.id)).toEqual([
      "u1", "a1", "u2", "a2", "u3", "a3",
    ]);
    // Switch to the edited branch (leaf a2p): prefix u1 a1 + chain u2p a2p.
    expect(resolveActiveBranch(all, "a2p").map((m) => m.id)).toEqual([
      "u1", "a1", "u2p", "a2p",
    ]);
  });

  it("a legacy prefix is prepended when the chain hits a parentless node", () => {
    const all = tree();
    // Fork mid-legacy: u1/a1 are parentless; the chain from u2p stops at a1
    // and the OLDER row u1 rides along as the prefix.
    const path = resolveActiveBranch(all, "u2p");
    expect(path.map((m) => m.id)).toEqual(["u1", "a1", "u2p"]);
  });

  it("a stale/missing leaf falls back to the NEWEST branch (what the user last saw)", () => {
    const all = tree();
    // Newest = a3p (a regeneration of u3) — its path excludes the a3 sibling.
    expect(resolveActiveBranch(all, "deleted-row").map((m) => m.id)).toEqual([
      "u1", "a1", "u2", "a2", "u3", "a3p",
    ]);
  });

  it("an empty input resolves empty", () => {
    expect(resolveActiveBranch([], "x")).toEqual([]);
  });

  it("cycles cannot loop the walk", () => {
    const cyc = [msg("x", "y"), msg("y", "x")];
    const path = resolveActiveBranch(cyc, "x");
    // Both nodes appear at most once each (seen-set guard).
    expect(path.filter((m) => m.id === "x")).toHaveLength(1);
    expect(path.filter((m) => m.id === "y")).toHaveLength(1);
  });

  it("the walk feeds the runtime's wire history — regeneration excludes the retired reply", () => {
    const all = tree();
    // Regenerate u3's reply: leaf = u3 (the reused user message) — the OLD
    // replies (a3, a3p) are children of u3, so they drop out of history.
    expect(resolveActiveBranch(all, "u3").map((m) => m.id)).toEqual([
      "u1", "a1", "u2", "a2", "u3",
    ]);
  });
});

describe("siblingGroup + deepestLeafOf — the switch machinery", () => {
  it("siblings share a parent, oldest first; legacy rows are their own group", () => {
    const all = tree();
    expect(siblingGroup(all, all[2]!).map((m) => m.id)).toEqual(["u2", "u2p"]); // forks of a1
    expect(siblingGroup(all, all[7]!).map((m) => m.id)).toEqual(["a3", "a3p"]); // regenerations of u3
    expect(siblingGroup(all, all[0]!).map((m) => m.id)).toEqual(["u1"]); // legacy, no parent
  });

  it("deepestLeafOf lands on the branch tip, preferring the newest child", () => {
    const all = tree();
    expect(deepestLeafOf(all, "u2p")?.id).toBe("a2p");
    // Switching to u2's subtree: newest child chain a2 → u3 → a3' (newest of a3/a3p)
    expect(deepestLeafOf(all, "u2")?.id).toBe("a3p");
    expect(deepestLeafOf(all, "missing")).toBeNull();
  });

  it("childrenMap groups by parent", () => {
    const map = childrenMap(tree());
    expect(map.get("a1")!.map((m) => m.id)).toEqual(["u2", "u2p"]);
    expect(map.get("u3")!.map((m) => m.id)).toEqual(["a3", "a3p"]);
    expect(map.has("u1")).toBe(false); // legacy rows have no parent
  });
});

describe("buildBranchInfo — the ‹ i/n › metadata", () => {
  it("only on-path forked messages get positions; counts and order are correct", () => {
    const all = tree();
    const path = resolveActiveBranch(all, "a3p"); // newest branch: … u3 → a3'
    const info = buildBranchInfo(all, path);
    // u2 has 2 siblings but is NOT on this path (u2's subtree leads to a3,
    // while the path reaches u3 via a2 → u3 — wait, u2 IS on the path).
    expect(info.get("u2")).toMatchObject({ index: 1, count: 2 });
    expect(info.get("a3p")).toMatchObject({ index: 2, count: 2 });
    // u1/a1/u3 have no forked siblings on the path.
    expect(info.has("u1")).toBe(false);
    expect(info.has("u3")).toBe(false);
    // Off-path forked messages never appear.
    expect(info.has("u2p")).toBe(false);
    expect(info.has("a3")).toBe(false);
  });

  it("a path with no forks yields an empty map (no pickers render)", () => {
    const flat = [msg("m1", null), msg("m2", null)];
    expect(buildBranchInfo(flat, flat).size).toBe(0);
  });
});
