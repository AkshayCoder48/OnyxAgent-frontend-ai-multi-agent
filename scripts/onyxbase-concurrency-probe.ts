/** Isolate OnyxBase write durability: concurrency vs sequential. */
import { OnyxBaseKV } from "../src/lib/onyxbase/kv-client";

const KEY = process.env.ONYXBASE_KEY!;
const kv = new OnyxBaseKV(KEY);

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function trial(tag: string, concurrency: number, prefix: string) {
  const writes = Array.from({ length: 12 }, (_, i) => ({
    key: `probe:${prefix}:${String(i).padStart(2, "0")}`,
    value: `V-${tag}-${i}-`.repeat(50), // ~600 chars, mixed content
  }));
  await pool(writes, concurrency, async (w) => {
    try { await kv.set(w.key, w.value); } catch (e) { console.log(`  write err ${w.key}:`, (e as Error).message.slice(0, 80)); }
  });
  const check = async (label: string) => {
    let ok = 0;
    for (const w of writes) {
      const back = await kv.get(w.key);
      if (back === w.value) ok++;
    }
    console.log(`  [${tag}] read-back ${label}: ${ok}/12 identical`);
    return ok;
  };
  await check("immediate");
  await new Promise((r) => setTimeout(r, 5000));
  await check("@5s");
  await new Promise((r) => setTimeout(r, 15000));
  const ok = await check("@20s");
  return ok;
}

async function main() {
  console.log("== trial A: 6-concurrent writes ==");
  const a = await trial("conc6", 6, "conc");
  console.log("\n== trial B: sequential (1) writes ==");
  const b = await trial("seq", 1, "seq");
  console.log(`\nRESULT: concurrent=${a}/12, sequential=${b}/12`);
}
main();
