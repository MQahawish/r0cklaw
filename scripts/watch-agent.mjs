#!/usr/bin/env node

import fs from "fs";
import path from "path";

const agent = process.argv[2];
const mode = process.argv.includes("--once") ? "once" : "watch";

if (!agent) {
  console.error("Usage: ./scripts/watch-agent.mjs <agent-slug> [--once]");
  process.exit(1);
}

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const workspace = path.join(rootDir, "agents", agent, "workspace");
const tickDebugPath = path.join(workspace, "state", "tick-debug.jsonl");
const tracePath = path.join(workspace, "state", "runtime-trace.jsonl");
const logPath = path.join("/tmp", `zeroclaw-${agent}.log`);
const statusPath = path.join(workspace, "world", "status.md");
const locationPath = path.join(workspace, "world", "location.md");
const inventoryPath = path.join(workspace, "world", "inventory.md");
const divider = "-".repeat(78);

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function readJsonl(filePath) {
  const raw = readFileSafe(filePath).trim();
  if (!raw) return [];
  const lines = raw.split("\n");
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ phase: "unparseable", raw: line });
    }
  }
  return out;
}

function lastTickRecords(records) {
  if (records.length === 0) return [];
  const completedIndex = [...records].reverse().findIndex((record) =>
    ["completed", "parse_failed", "invalid_action", "transport_failed"].includes(record.phase),
  );
  if (completedIndex === -1) {
    const last = records[records.length - 1];
    return records.filter((record) => record.tick === last.tick && record.agentName === last.agentName);
  }
  const terminal = records[records.length - 1 - completedIndex];
  return records.filter((record) => record.tick === terminal.tick && record.agentName === terminal.agentName);
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function truncate(text, max = 300) {
  const clean = stripAnsi(String(text ?? ""));
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 3)}...`;
}

function section(title, bodyLines = []) {
  const lines = [];
  lines.push(title);
  lines.push(divider);
  if (bodyLines.length === 0) {
    lines.push("(empty)");
  } else {
    lines.push(...bodyLines);
  }
  return lines.join("\n");
}

function summarizeEvents(events = []) {
  if (!Array.isArray(events) || events.length === 0) {
    return ["(no streamed events recorded)"];
  }
  return events.map((event, index) => {
    if (event.type === "session_start") {
      return `${index + 1}. session_start session=${event.session_id ?? "?"} resumed=${String(event.resumed ?? false)} messages=${event.message_count ?? "?"}`;
    }
    if (event.type === "tool_call") {
      return `${index + 1}. tool_call ${event.name ?? "unknown"} ${truncate(JSON.stringify(event.args ?? {}), 140)}`;
    }
    if (event.type === "tool_result") {
      return `${index + 1}. tool_result ${event.name ?? "unknown"} ${truncate(event.output ?? "", 180)}`;
    }
    if (event.type === "chunk") {
      return `${index + 1}. chunk ${truncate(event.content ?? "", 180)}`;
    }
    if (event.type === "done") {
      return `${index + 1}. done ${truncate(event.full_response ?? "", 180)}`;
    }
    if (event.type === "error") {
      return `${index + 1}. error ${truncate(event.message ?? event.code ?? "", 180)}`;
    }
    return `${index + 1}. ${event.type ?? "unknown"} ${truncate(JSON.stringify(event), 180)}`;
  });
}

function formatKeyValues(entries) {
  const width = Math.max(...entries.map(([key]) => key.length), 0);
  return entries.map(([key, value]) => `${key.padEnd(width)} : ${value}`);
}

function compactMarkdown(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/^#\s+/, "").trimEnd())
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""));
}

function parseNamedStats(lines) {
  const stats = [];
  for (const line of lines) {
    const match = line.match(/^([A-Za-z ]+):\s+(.*)$/);
    if (match) {
      stats.push([match[1].trim(), match[2].trim()]);
    }
  }
  return stats;
}

function parseActionSummary(action) {
  if (!action) return "No parsed action";
  const target = action.target ?? "null";
  const message = action.message ? ` | ${action.message}` : "";
  return `${action.action} -> ${target} | duration=${action.duration_ticks}${message}`;
}

function splitEvents(events = []) {
  return {
    sessions: events.filter((event) => event.type === "session_start"),
    toolCalls: events.filter((event) => event.type === "tool_call"),
    toolResults: events.filter((event) => event.type === "tool_result"),
    chunks: events.filter((event) => event.type === "chunk"),
    done: events.find((event) => event.type === "done") ?? null,
    errors: events.filter((event) => event.type === "error"),
    other: events.filter(
      (event) => !["session_start", "tool_call", "tool_result", "chunk", "done", "error"].includes(event.type),
    ),
  };
}

function summarizeTrace() {
  const lines = readFileSafe(tracePath).trim().split("\n").filter(Boolean);
  return lines.slice(-10).map((line) => truncate(line, 220));
}

function summarizeLog() {
  const lines = readFileSafe(logPath).trim().split("\n").filter(Boolean);
  return lines.slice(-10).map((line) => truncate(line, 220));
}

function render() {
  const records = readJsonl(tickDebugPath);
  const lastRecords = lastTickRecords(records);
  const started = lastRecords.find((record) => record.phase === "started") ?? null;
  const terminal = [...lastRecords].reverse().find((record) =>
    ["completed", "parse_failed", "invalid_action", "transport_failed"].includes(record.phase),
  ) ?? null;

  const promptText = terminal?.prompt ?? started?.prompt ?? "(no prompt recorded)";
  const statusLines = compactMarkdown(readFileSafe(statusPath).trim());
  const locationLines = compactMarkdown(readFileSafe(locationPath).trim());
  const inventoryLines = compactMarkdown(readFileSafe(inventoryPath).trim());
  const split = splitEvents(terminal?.events ?? started?.events ?? []);

  const headerMeta = terminal
    ? [
        ["Agent", agent],
        ["Tick", String(terminal.tick)],
        ["Day", String(terminal.day)],
        ["Time", String(terminal.timeOfDay)],
        ["Phase", String(terminal.phase)],
        ["Session", String(terminal.sessionId ?? started?.sessionId ?? "?")],
      ]
    : started
      ? [
          ["Agent", agent],
          ["Tick", String(started.tick)],
          ["Day", String(started.day)],
          ["Time", String(started.timeOfDay)],
          ["Phase", "started"],
          ["Session", String(started.sessionId ?? "?")],
        ]
      : [["Agent", agent], ["Phase", "no tick records"]];

  const header = [
    "Rocklaw Agent Watch",
    divider,
    ...formatKeyValues(headerMeta),
    "",
    `Action     : ${parseActionSummary(terminal?.parsedAction)}`,
    `Validation : ${terminal?.validation?.outcome ?? "pending"}${terminal?.validation?.note ? ` | ${terminal.validation.note}` : ""}`,
    `Workspace  : ${workspace}`,
  ];

  const stateOverviewEntries = [
    ...parseNamedStats(statusLines),
    ...parseNamedStats(locationLines.filter((line) => ["Current", "Nearby", "Message board", "Letters waiting for you here"].some((prefix) => line.startsWith(`${prefix}:`)))),
  ];
  const stateOverview = section("State Overview", formatKeyValues(stateOverviewEntries));
  const inventory = section("Inventory", inventoryLines.slice(1));
  const prompt = section(
    "Tick Prompt",
    promptText.split("\n").map((line) => truncate(line, 140)),
  );

  const sessionLines = [];
  if (split.sessions.length > 0) {
    for (const event of split.sessions) {
      sessionLines.push(`name=${event.name ?? "?"} | resumed=${String(event.resumed ?? false)} | messages=${event.message_count ?? "?"} | session=${event.session_id ?? "?"}`);
    }
  }
  if (split.errors.length > 0) {
    sessionLines.push(...split.errors.map((event) => `error: ${truncate(event.message ?? event.code ?? "", 160)}`));
  }
  const session = section("Session", sessionLines);

  const toolCalls = section(
    "Tool Calls",
    split.toolCalls.length > 0
      ? split.toolCalls.map((event, index) => `${index + 1}. ${event.name ?? "unknown"} ${truncate(JSON.stringify(event.args ?? {}), 140)}`)
      : ["(no tool calls)"],
  );
  const toolResults = section(
    "Tool Results",
    split.toolResults.length > 0
      ? split.toolResults.map((event, index) => `${index + 1}. ${event.name ?? "unknown"} -> ${truncate(event.output ?? "", 160)}`)
      : ["(no tool results)"],
  );

  const responseSummary = section(
    "Agent Response Summary",
    split.chunks.length > 0
      ? split.chunks.map((event, index) => `${index + 1}. ${truncate(event.content ?? "", 220)}`)
      : split.done
        ? [truncate(split.done.full_response ?? "", 220)]
        : ["(no response chunks)"],
  );

  const actionLines = terminal?.parsedAction
    ? JSON.stringify(terminal.parsedAction, null, 2).split("\n")
    : ["(no parsed action)"];
  if (terminal?.validation) {
    actionLines.push("");
    actionLines.push(`validation=${terminal.validation.outcome}${terminal.validation.note ? ` | ${terminal.validation.note}` : ""}`);
  }
  const action = section("Parsed Action", actionLines);

  const response = section("Final Response", (terminal?.rawResponse ?? "(no raw response recorded)").split("\n"));

  const trace = section("Runtime Trace Tail", summarizeTrace());
  const logs = section("Gateway Log Tail", summarizeLog());

  const blocks = [
    header.join("\n"),
    "",
    stateOverview,
    "",
    inventory,
    "",
    session,
    "",
    toolCalls,
    "",
    toolResults,
    "",
    responseSummary,
    "",
    action,
    "",
    prompt,
    "",
    response,
    "",
    trace,
    "",
    logs,
  ];
  const out = blocks.join("\n");

  if (mode === "watch") {
    process.stdout.write("\x1bc");
  }
  process.stdout.write(`${out}\n`);
}

render();

if (mode === "watch") {
  setInterval(render, 1000);
}
