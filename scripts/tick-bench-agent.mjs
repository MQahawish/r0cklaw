#!/usr/bin/env node

import fs from "fs";
import path from "path";

const args = process.argv.slice(2);
const agent = args[0];

if (!agent) {
  console.error("Usage: node ./scripts/tick-bench-agent.mjs <agent-slug> [--limit N] [--json]");
  process.exit(1);
}

let limit = 20;
let json = false;

for (let i = 1; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--json") {
    json = true;
    continue;
  }
  if (arg === "--limit") {
    const value = Number(args[i + 1]);
    if (!Number.isFinite(value) || value <= 0) {
      console.error("Error: --limit must be a positive number.");
      process.exit(1);
    }
    limit = Math.floor(value);
    i += 1;
    continue;
  }
}

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const debugPath = path.join(rootDir, "agents", agent, "workspace", "state", "tick-debug.jsonl");

if (!fs.existsSync(debugPath)) {
  console.error(`Error: tick debug file not found at ${debugPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(debugPath, "utf8").trim();
if (!raw) {
  console.error(`Error: tick debug file is empty at ${debugPath}`);
  process.exit(1);
}

const terminalPhases = new Set(["completed", "transport_failed", "parse_failed", "invalid_action"]);
const startPhases = new Set(["started", "planned"]);
const records = raw
  .split("\n")
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const ticks = new Map();

for (const record of records) {
  if (typeof record.tick !== "number") continue;
  const key = `${record.agentName ?? agent}:${record.tick}`;
  const current = ticks.get(key) ?? {
    agentName: record.agentName ?? agent,
    tick: record.tick,
    day: record.day ?? null,
    timeOfDay: record.timeOfDay ?? null,
    startTimestamp: null,
    endTimestamp: null,
    phase: null,
    action: null,
    note: null,
    gatewayHost: null,
  };

  if (typeof record.timestamp === "string") {
    if (startPhases.has(record.phase) && current.startTimestamp === null) {
      current.startTimestamp = record.timestamp;
    }
    if (terminalPhases.has(record.phase)) {
      current.endTimestamp = record.timestamp;
      current.phase = record.phase;
      current.action = record.parsedAction?.action ?? null;
      current.note = record.validation?.note ?? record.error ?? null;
      current.gatewayHost = record.gatewayHost ?? current.gatewayHost;
    }
  }

  ticks.set(key, current);
}

const rows = Array.from(ticks.values())
  .filter((row) => row.startTimestamp && row.endTimestamp)
  .map((row) => {
    const durationMs = Date.parse(row.endTimestamp) - Date.parse(row.startTimestamp);
    return {
      ...row,
      durationMs,
    };
  })
  .filter((row) => Number.isFinite(row.durationMs) && row.durationMs >= 0)
  .sort((a, b) => b.tick - a.tick)
  .slice(0, limit);

if (rows.length === 0) {
  console.error(`Error: no completed ticks with measurable duration found in ${debugPath}`);
  process.exit(1);
}

if (json) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const width = {
  tick: Math.max(...rows.map((row) => String(row.tick).length), 4),
  day: Math.max(...rows.map((row) => String(row.day ?? "").length), 3),
  tod: Math.max(...rows.map((row) => String(row.timeOfDay ?? "").length), 10),
  phase: Math.max(...rows.map((row) => String(row.phase ?? "").length), 5),
  action: Math.max(...rows.map((row) => String(row.action ?? "").length), 6),
  ms: Math.max(...rows.map((row) => String(row.durationMs).length), 2),
};

const header = [
  "tick".padEnd(width.tick),
  "day".padEnd(width.day),
  "time".padEnd(width.tod),
  "phase".padEnd(width.phase),
  "action".padEnd(width.action),
  "ms".padStart(width.ms),
  "note",
].join("  ");

console.log(header);
console.log("-".repeat(header.length));

for (const row of rows) {
  console.log(
    [
      String(row.tick).padEnd(width.tick),
      String(row.day ?? "").padEnd(width.day),
      String(row.timeOfDay ?? "").padEnd(width.tod),
      String(row.phase ?? "").padEnd(width.phase),
      String(row.action ?? "").padEnd(width.action),
      String(row.durationMs).padStart(width.ms),
      String(row.note ?? ""),
    ].join("  "),
  );
}

const durations = rows.map((row) => row.durationMs);
const avg = durations.reduce((sum, value) => sum + value, 0) / durations.length;
const min = Math.min(...durations);
const max = Math.max(...durations);

console.log("");
console.log(`ticks=${rows.length} avg_ms=${avg.toFixed(1)} min_ms=${min} max_ms=${max}`);
