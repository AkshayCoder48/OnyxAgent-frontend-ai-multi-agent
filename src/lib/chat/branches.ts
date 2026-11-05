"use client";

/**
 * chat/branches — CHAT BRANCHES (2026-11-05) pure helpers.
 *
 * The message model gains ONE optional field, `parent_id` (the predecessor
 * on the same branch), plus a per-conversation `active_leaf_id` pointer.
 * Nothing else changes: Dexie rows keep their flat `created_at` ordering,
 * legacy conversations (no parents at all) render exactly as before, and
 * the fork flows (edit user message / regenerate) now create SIBLING rows
 * instead of deleting the old timeline.
 *
 * The walk (resolveActiveBranch): follow parent links from the active leaf
 * backwards; when the chain hits a parentless node, every OLDER message
 * (created_at order) is prepended as the legacy prefix — so a fork taken
 * in a legacy conversation still shows its full history above the fork
 * point, and the pre-fork rows never need a backfill migration.
 */

/** Anything that participates in the branch tree. */
export interface BranchNode {
  id: string;
  parent_id?: string | null;
  created_at: string;
}

/** Normalized position of a message inside its sibling group. */
export interface BranchPosition {
  /** 1-based index of the ACTIVE sibling within its group. */
  index: number;
  /** Total siblings sharing this parent (>= 1). */
  count: number;
  /** The sibling ids, ordered oldest-first (index maps onto this array). */
  siblings: string[];
}

/**
 * Resolve the ACTIVE branch — the messages to paint / send as history.
 *
 * `sorted` MUST be the conversation's full message list ordered by
 * created_at (the getMessages contract). `activeLeafId` is the
 * conversation's stored leaf pointer (may be null/absent).
 *
 * Fallbacks (in order):
 *   1. leaf found → parent-chain walk + legacy prefix (see header);
 *   2. leaf id stale/missing AND any row has a parent → treat the NEWEST
 *      message as the leaf (the most recently created branch — what the
 *      user saw when the leaf was last written);
 *   3. no parents anywhere → the flat list, verbatim (legacy behavior).
 */
export function resolveActiveBranch<T extends BranchNode>(
  sorted: T[],
  activeLeafId?: string | null,
): T[] {
  if (sorted.length === 0) return sorted;

  const byId = new Map(sorted.map((m) => [m.id, m]));
  let leaf = activeLeafId ? byId.get(activeLeafId) : undefined;
  if (!leaf && sorted.some((m) => m.parent_id != null)) {
    // No (valid) leaf pointer, but the tree exists → newest branch.
    leaf = sorted[sorted.length - 1]!;
  }
  if (!leaf) return sorted; // legacy flat conversation

  // Walk the parent chain (cycle-safe).
  const chain: T[] = [];
  const seen = new Set<string>();
  let cur: T | undefined = leaf;
  let oldest: T = leaf;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    oldest = cur;
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }

  // Legacy prefix: everything strictly older than the chain's oldest node
  // (created_at order), deduped against the chain (a cycle guard can leave
  // chain nodes in the older prefix — real data never cycles, but the walk
  // must never duplicate a row). For a fully-parented chain the oldest node
  // is the root and the prefix is empty; for a fork mid-legacy-conversation
  // the prefix is the untouched pre-fork history.
  const oldestIdx = sorted.indexOf(oldest);
  const prefix =
    oldestIdx > 0 ? sorted.slice(0, oldestIdx).filter((m) => !seen.has(m.id)) : [];

  return [...prefix, ...chain.reverse()];
}

/** parent id → children, oldest-first. Used for subtree walks + siblings. */
export function childrenMap<T extends BranchNode>(all: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const m of all) {
    if (m.parent_id == null) continue;
    const list = map.get(m.parent_id);
    if (list) list.push(m);
    else map.set(m.parent_id, [m]);
  }
  return map;
}

/**
 * The sibling group of a message: every row sharing its parent, oldest
 * first. For legacy rows (parent absent) the group is just the row itself —
 * a legacy message only gains siblings when its parent was backfilled at
 * fork time.
 */
export function siblingGroup<T extends BranchNode>(all: T[], message: T): T[] {
  if (message.parent_id == null) return [message];
  return all
    .filter((m) => m.parent_id === message.parent_id)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

/**
 * The deepest message of the subtree rooted at `rootId` — the leaf a branch
 * switch lands on. Depth-first, preferring the NEWEST child at each level
 * (matches "the branch as it was last extended").
 */
export function deepestLeafOf<T extends BranchNode>(all: T[], rootId: string): T | null {
  const children = childrenMap(all);
  const byId = new Map(all.map((m) => [m.id, m]));
  const root = byId.get(rootId);
  if (!root) return null;
  let leaf: T = root;
  const seen = new Set<string>([rootId]);
  for (;;) {
    const kids = (children.get(leaf.id) ?? []).slice().sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
    );
    const next = kids.find((k) => !seen.has(k.id));
    if (!next) return leaf;
    seen.add(next.id);
    leaf = next;
  }
}

/**
 * Branch-picker metadata for every message on the ACTIVE path: which of its
 * parent's children is on this path, how many siblings exist, and the
 * ordered sibling ids. Messages without siblings are omitted from the map
 * (the picker renders only for count > 1).
 */
export function buildBranchInfo<T extends BranchNode>(
  all: T[],
  activePath: T[],
): Map<string, BranchPosition> {
  const pathIds = new Set(activePath.map((m) => m.id));
  const info = new Map<string, BranchPosition>();
  for (const msg of activePath) {
    const group = siblingGroup(all, msg);
    if (group.length < 2) continue;
    const index = group.findIndex((g) => g.id === msg.id);
    if (index < 0) continue;
    info.set(msg.id, {
      index: index + 1,
      count: group.length,
      siblings: group.map((g) => g.id),
    });
  }
  // Path membership is what makes a sibling "active" — keep the map honest
  // for messages that appear in `all` but not on the path.
  for (const id of [...info.keys()]) {
    if (!pathIds.has(id)) info.delete(id);
  }
  return info;
}
