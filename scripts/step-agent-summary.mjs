#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const agent = process.argv[2];

if (!agent) {
  console.error("Usage: ./scripts/step-agent-summary.mjs <agent-slug>");
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const debugPath = path.join(ROOT, "agents", agent, "workspace", "state", "tick-debug.jsonl");

function readLastTerminalRecord() {
  if (!fs.existsSync(debugPath)) return null;
  const lines = fs.readFileSync(debugPath, "utf8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (["completed", "transport_failed", "parse_failed", "invalid_action"].includes(parsed.phase)) {
        return parsed;
      }
    } catch {
      // ignore malformed lines
    }
  }
  return null;
}

function extractJsonPayload(output) {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function readStepSummary() {
  try {
    const stdout = execFileSync("npx", ["convex", "run", "rocklaw/observe:getStepSummary"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return extractJsonPayload(stdout);
  } catch {
    return null;
  }
}

function formatAction(action) {
  if (!action?.action) return "(no parsed action)";
  const target = action.location ?? action.target ?? action.item ?? null;
  const quantity = typeof action.quantity === "number" && action.quantity > 1
    ? ` x${action.quantity}`
    : "";
  const suffix = target ? ` -> ${target}` : "";
  return `${action.action}${suffix}${quantity}`;
}

const terminal = readLastTerminalRecord();
const summary = readStepSummary();
const agentState = Array.isArray(summary?.agents)
  ? summary.agents.find((entry) => entry?.name === (terminal?.agentName ?? null))
  : null;

const worldTick = typeof summary?.tick === "number" ? summary.tick : null;
const worldDay = typeof summary?.day === "number" ? summary.day : null;
const worldTimeOfDay = typeof summary?.timeOfDay === "string" ? summary.timeOfDay : null;
const terminalTick = typeof terminal?.tick === "number" ? terminal.tick : null;
const staleRecord = worldTick !== null && terminalTick !== null ? terminalTick < worldTick : false;

const headerParts = [];
if (worldTick !== null) headerParts.push(`Tick ${worldTick}`);
if (worldDay !== null) headerParts.push(`Day ${worldDay}`);
if (worldTimeOfDay) headerParts.push(worldTimeOfDay);

console.log(headerParts.join(" | ") || "No tick summary available.");

if (staleRecord && agentState?.busy && agentState?.busyLabel) {
  console.log(`decision: (no new model turn)`);
  console.log(`status: ${agentState.busyLabel}`);
  process.exit(0);
}

if (!terminal) {
  if (agentState?.busy && agentState?.busyLabel) {
    console.log(`decision: (no persisted model turn)`);
    console.log(`status: ${agentState.busyLabel}`);
    process.exit(0);
  }
  console.log("decision: (no persisted turn record)");
  process.exit(0);
}

console.log(`decision: ${formatAction(terminal.parsedAction)}`);

const outcome = terminal.validation?.outcome ?? terminal.phase ?? "unknown";
const note = terminal.validation?.note ? ` | ${terminal.validation.note}` : "";
console.log(`status: ${outcome}${note}`);

if (!staleRecord && terminal.rawResponse) {
  console.log(`raw: ${terminal.rawResponse}`);
}
