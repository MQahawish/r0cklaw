#!/usr/bin/env node

import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const AGENTS = ["elena", "marcus", "finn", "lena", "sera", "aldric", "cora", "rook"];

function readLastTerminalRecord(agent) {
  const debugPath = path.join(ROOT, "agents", agent, "workspace", "state", "tick-debug.jsonl");
  if (!fs.existsSync(debugPath)) return null;
  const lines = fs.readFileSync(debugPath, "utf8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (["completed", "transport_failed", "parse_failed", "invalid_action"].includes(parsed.phase)) {
        return parsed;
      }
    } catch {
      // ignore malformed debug lines
    }
  }
  return null;
}

function formatAction(record) {
  const action = record?.parsedAction?.action;
  if (!action) return "no parsed action";
  const destination = record.parsedAction.location ?? record.parsedAction.target ?? record.parsedAction.item ?? null;
  const quantity = typeof record.parsedAction.quantity === "number" && record.parsedAction.quantity > 1
    ? ` x${record.parsedAction.quantity}`
    : "";
  const target = destination ? ` -> ${destination}` : "";
  return `${action}${target}${quantity}`;
}

function formatOutcome(record) {
  const outcome = record?.validation?.outcome ?? record?.phase ?? "unknown";
  const note = typeof record?.validation?.note === "string" && record.validation.note.trim() !== ""
    ? ` | ${record.validation.note}`
    : "";
  return `${outcome}${note}`;
}

function worldHeader(records) {
  const latest = records.find(Boolean);
  if (!latest) return "No tick records yet.";
  return `Tick ${latest.tick} | Day ${latest.day} | ${latest.timeOfDay}`;
}

const records = AGENTS.map((agent) => ({ agent, record: readLastTerminalRecord(agent) }));

console.log("Rocklaw World Step");
console.log("------------------------------------------------------------------------------");
console.log(worldHeader(records.map((entry) => entry.record)));
console.log("");

for (const { agent, record } of records) {
  if (!record) {
    console.log(`${agent.padEnd(8)} no tick record yet`);
    continue;
  }
  const outward = record?.parsedAction?.message ?? record?.parsedAction?.text;
  const message = typeof outward === "string" && outward.trim() !== ""
    ? ` | ${outward}`
    : "";
  console.log(
    `${agent.padEnd(8)} ${formatAction(record).padEnd(28)} ${formatOutcome(record)}${message}`,
  );
}

console.log("");
console.log("Detailed transcripts:");
for (const agent of AGENTS) {
  console.log(`  npm run watch:agent -- ${agent}`);
}
