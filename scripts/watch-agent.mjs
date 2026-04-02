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
const turnPath = path.join(workspace, "TURN.md");
const zeroClawPromptFiles = [
  "IDENTITY.md",
  "SOUL.md",
  "AGENTS.md",
  "TOOLS.md",
  "USER.md",
];
const divider = "-".repeat(78);
const zeroClawScaffolding = [
  "Known ZeroClaw system-prompt scaffolding from source:",
  "1. Anti-narration guardrail",
  "2. Tool honesty / tool protocol guidance",
  "3. Tools section",
  "4. Safety / security policy summary",
  "5. Skills section",
  "6. Workspace context",
  "7. Bootstrap file injection",
  "8. Date / time context",
  "9. Runtime / model context",
  "",
  "Known bootstrap preamble from ZeroClaw source:",
  "The following workspace files define your identity, behavior, and context. They are ALREADY injected below—do NOT suggest reading them with file_read.",
  "",
  "What is still not observable here:",
  "- Exact final assembled system prompt string",
  "- Exact tool list section text",
  "- Exact safety/security summary text",
  "- Exact skills prompt rendering",
  "- Exact prior chat history payload restored into the turn",
];

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
  const focus = action.location ?? action.target ?? action.item ?? action.topic ?? "null";
  const extras = [];
  if (typeof action.quantity === "number") extras.push(`qty=${action.quantity}`);
  if (typeof action.amount === "number") extras.push(`amount=${action.amount}`);
  if (action.thought) extras.push(`thought=${truncate(action.thought, 80)}`);
  const message = (action.message ?? action.text) ? ` | ${action.message ?? action.text}` : "";
  const extraSuffix = extras.length > 0 ? ` | ${extras.join(" ")}` : "";
  return `${action.action} -> ${focus}${extraSuffix}${message}`;
}

function summarizeTrace() {
  const lines = readFileSafe(tracePath).trim().split("\n").filter(Boolean);
  return lines.slice(-10).map((line) => truncate(line, 220));
}

function summarizeLog() {
  const lines = readFileSafe(logPath).trim().split("\n").filter(Boolean);
  return lines.slice(-10).map((line) => truncate(line, 220));
}

function buildZeroClawContext(workspaceDir) {
  const lines = [
    "This is a reconstructed approximation of the ZeroClaw prompt inputs.",
    "It combines known prompt scaffolding from the ZeroClaw source with the workspace files ZeroClaw injects.",
    "It is not the hidden runtime-assembled prompt verbatim.",
    "",
    ...zeroClawScaffolding,
    "",
  ];

  for (const file of zeroClawPromptFiles) {
    const filePath = path.join(workspaceDir, file);
    const content = readFileSafe(filePath).trim();
    lines.push(`--- ${file}${file === "USER.md" ? " (optional)" : ""} ---`);
    lines.push(content || (file === "USER.md" ? "(missing optional file)" : "(missing)"));
    lines.push("");
  }

  return lines;
}

function indentBlock(text, prefix = "    ") {
  return String(text ?? "")
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function buildTranscript(events = [], promptText = "") {
  const lines = [];

  if (!Array.isArray(events) || events.length === 0) {
    lines.push("[--] No streamed events recorded");
    return lines;
  }

  events.forEach((event, index) => {
    const step = String(index + 1).padStart(2, "0");
    lines.push("");

    if (event.type === "session_start") {
      lines.push(`[${step}] SESSION START`);
      lines.push(indentBlock(`name=${event.name ?? "?"}`));
      lines.push(indentBlock(`session=${event.session_id ?? "?"}`));
      lines.push(indentBlock(`resumed=${String(event.resumed ?? false)}`));
      lines.push(indentBlock(`message_count=${event.message_count ?? "?"}`));
      return;
    }

    if (event.type === "tool_call") {
      lines.push(`[${step}] TOOL CALL  ${event.name ?? "unknown"}`);
      lines.push(indentBlock(JSON.stringify(event.args ?? {}, null, 2)));
      return;
    }

    if (event.type === "tool_result") {
      lines.push(`[${step}] TOOL RESULT  ${event.name ?? "unknown"}`);
      lines.push(indentBlock(String(event.output ?? "(empty result)")));
      return;
    }

    if (event.type === "chunk") {
      lines.push(`[${step}] RESPONSE CHUNK`);
      lines.push(indentBlock(String(event.content ?? "(empty chunk)")));
      return;
    }

    if (event.type === "done") {
      lines.push(`[${step}] FINAL RESPONSE`);
      lines.push(indentBlock(String(event.full_response ?? "(empty final response)")));
      return;
    }

    if (event.type === "error") {
      lines.push(`[${step}] ERROR`);
      lines.push(indentBlock(String(event.message ?? event.code ?? "Unknown error")));
      return;
    }

    lines.push(`[${step}] ${String(event.type ?? "unknown").toUpperCase()}`);
    lines.push(indentBlock(JSON.stringify(event, null, 2)));
  });

  return lines;
}

function formatParsedAction(action, validation) {
  if (!action) return ["(no parsed action)"];
  const lines = [
    `action=${action.action}`,
  ];
  if (action.location != null) lines.push(`location=${action.location}`);
  if (action.target != null) lines.push(`target=${action.target}`);
  if (action.item != null) lines.push(`item=${action.item}`);
  if (typeof action.quantity === "number") lines.push(`quantity=${action.quantity}`);
  if (typeof action.amount === "number") lines.push(`amount=${action.amount}`);
  if (action.topic != null) lines.push(`topic=${action.topic}`);
  if (action.thought) lines.push(`thought=${action.thought}`);
  if (action.text) lines.push(`text=${action.text}`);
  if (action.message) lines.push(`message=${action.message}`);
  if (Array.isArray(action.consumes) && action.consumes.length > 0) {
    lines.push(`consumes=${JSON.stringify(action.consumes)}`);
  }
  if (Array.isArray(action.produces) && action.produces.length > 0) {
    lines.push(`produces=${JSON.stringify(action.produces)}`);
  }
  if (Array.isArray(action.offer) && action.offer.length > 0) {
    lines.push(`offer=${JSON.stringify(action.offer)}`);
  }
  if (Array.isArray(action.request) && action.request.length > 0) {
    lines.push(`request=${JSON.stringify(action.request)}`);
  }
  if (validation) {
    lines.push("");
    lines.push(`validation=${validation.outcome}${validation.note ? ` | ${validation.note}` : ""}`);
  }
  return lines;
}

function render() {
  const records = readJsonl(tickDebugPath);
  const lastRecords = lastTickRecords(records);
  const started = lastRecords.find((record) => record.phase === "started") ?? null;
  const terminal = [...lastRecords].reverse().find((record) =>
    ["completed", "parse_failed", "invalid_action", "transport_failed"].includes(record.phase),
  ) ?? null;

  const promptText = terminal?.prompt ?? started?.prompt ?? "(no prompt recorded)";
  const turnLines = compactMarkdown(readFileSafe(turnPath).trim());
  const eventStream = terminal?.events ?? started?.events ?? [];
  const resumed = eventStream.find((event) => event.type === "session_start")?.resumed ?? false;
  const messageCount = eventStream.find((event) => event.type === "session_start")?.message_count ?? 0;
  const zeroClawContextLines = buildZeroClawContext(workspace);
  zeroClawContextLines.splice(
    3,
    0,
    `Session carry-over: resumed=${String(resumed)} | prior_messages=${messageCount}`,
    resumed
      ? "ZeroClaw likely also restored prior conversation history for this session."
      : "ZeroClaw started this turn without restored prior conversation history.",
    "",
  );
  const zeroClawContext = section("ZeroClaw Prompt Inputs (Approximation)", zeroClawContextLines);
  const rocklawPrompt = section("Rocklaw Tick Prompt", promptText.split("\n"));

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

  const stateOverviewEntries = parseNamedStats(turnLines);
  const stateOverview = section("State Overview", formatKeyValues(stateOverviewEntries));
  const worldSnapshot = section("World Snapshot", turnLines);
  const prompt = section(
    "Tick Prompt",
    promptText.split("\n").map((line) => truncate(line, 140)),
  );

  const transcript = section("Tick Transcript", buildTranscript(eventStream, promptText));

  const actionLines = formatParsedAction(terminal?.parsedAction, terminal?.validation);
  const action = section("Parsed Action", actionLines);

  const response = section("Final Response", (terminal?.rawResponse ?? "(no raw response recorded)").split("\n"));

  const trace = section("Runtime Trace Tail", summarizeTrace());
  const logs = section("Gateway Log Tail", summarizeLog());

  const blocks = [
    header.join("\n"),
    "",
    stateOverview,
    "",
    worldSnapshot,
    "",
    zeroClawContext,
    "",
    rocklawPrompt,
    "",
    transcript,
    "",
    action,
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
