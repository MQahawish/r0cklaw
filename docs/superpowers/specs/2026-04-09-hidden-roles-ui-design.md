# Hidden Roles UI — Design Spec

**Date:** 2026-04-09
**Scope:** God Mode dashboard only. Two additions: Elder's Day countdown in header, Hidden Roles section in Overview tab.

---

## 1. Elder's Day Countdown (Header)

**Location:** Existing header subtitle in `GodDashboard.tsx`, inline after tick info.

**Current:** `Day 5, morning — Tick 42`
**New:** `Day 5 of 30, morning — Tick 42 — 25 days until Elder's Day`

- `eldersDay` comes from `worldState.eldersDay` (already in `getDashboard` return via `worldState`)
- Countdown text: `N days until Elder's Day`
- Day 30: `Elder's Day is TODAY`
- Colour of the countdown span:
  - `> 7 days`: `#9ca3af` (muted grey, no urgency)
  - `≤ 7 days`: `#fbbf24` (amber)
  - `≤ 3 days`: `#ef4444` (red)
  - Day 0: `#ef4444` bold

No layout change — fits within the existing flex header row.

---

## 2. Hidden Roles Section (Overview Tab, Column 2)

**Location:** Top of column 2 in the Overview 3-column grid, above the existing "Active Events" block.

**Backend change — `god.ts` `getDashboard`:**
Add to the query handler:
```ts
const hiddenRoles = await ctx.db.query('rl_hidden_roles').collect();

// Saboteur: bakery grain
const bakeryStock = await ctx.db
  .query('rl_place_stocks')
  .withIndex('place_item', (q) => q.eq('placeName', 'bakery').eq('item', 'grain'))
  .unique();
const bakeryGrain = bakeryStock?.quantity ?? 0;

// Usurper: gossip hits
const gossipEvents = await ctx.db.query('rl_gossip_events').collect();
const gossipHitsByAgent: Record<string, number> = {};
for (const e of gossipEvents) {
  if (e.repPenaltyApplied) gossipHitsByAgent[e.sourceAgent] = (gossipHitsByAgent[e.sourceAgent] ?? 0) + 1;
}

// Heir: agent coin map for rival lookup
const agentCoinMap: Record<string, number> = {};
for (const a of agents) agentCoinMap[a.name] = a.coin ?? 0;
```
Return additions: `{ hiddenRoles, bakeryGrain, gossipHitsByAgent, agentCoinMap }`.

**Frontend — `GodDashboard.tsx`:**

New `HiddenRolesSection` component (inline in the same file):
- Receives `hiddenRoles`, `bakeryGrain`, `gossipHitsByAgent`, `agentCoinMap`, `agentCoin` (self)
- Renders a `SectionHeader` + up to 3 compact rows
- If no roles assigned yet: single muted line `"Roles not yet assigned"`

Each role row:
```
[SABOTEUR badge]  Elara Voss     grain: 14 ✗
[USURPER badge]   Marcus Hale    hits: 2
[HEIR badge]      Dara Finch  vs Lorn   +8c ahead
```

Role badge colours:
- `Saboteur` → red (`#ef4444`)
- `Usurper` → purple (`#a78bfa`)
- `Heir` → amber (`#fbbf24`)

Stat display per role:
- **Saboteur:** `grain: N` + `✓` if `< 10`, `✗` if `>= 10` (red if failing)
- **Usurper:** `hits: N` (gossip events that triggered rep penalty)
- **Heir:** `vs {rival} — +Nc ahead` / `−Nc behind` / `tied`

---

## Architecture

- No new files. All changes in `convex/rocklaw/god.ts` and `src/components/GodDashboard.tsx`.
- `getDashboard` grows by ~15 lines. Acceptable — it's already the god-mode omniscient query.
- No new Convex queries exposed publicly.

---

## Out of Scope

- Gossip event log (deferred)
- Non-god agents seeing roles (intentionally hidden)
- Mobile / sidebar display
