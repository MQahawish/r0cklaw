#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

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

function pairKey(left, right) {
  return [left, right].sort((a, b) => a.localeCompare(b)).join("::");
}

function readLiveChatSceneFallback(agent) {
  const locationPath = path.join(ROOT, "agents", agent, "workspace", "world", "location.md");
  if (!fs.existsSync(locationPath)) return null;
  const content = fs.readFileSync(locationPath, "utf8");
  const match = content.match(/Your live chat:\n\s*- With (.+?) at (.+?) \[(YOUR TURN|.+?'s turn)\]/m);
  if (!match) return null;
  return {
    partner: match[1],
    location: match[2],
  };
}

function slugifyAgentName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function readChatThreadFallback(agent, partner) {
  const threadPath = path.join(
    ROOT,
    "agents",
    agent,
    "workspace",
    "world",
    "chat",
    slugifyAgentName(partner),
    "CHAT.md",
  );
  if (!fs.existsSync(threadPath)) return { contextLines: [], lines: [] };
  const content = fs.readFileSync(threadPath, "utf8");
  const contextMatch = content.match(/SCENE CONTEXT\n([\s\S]*?)\n\nMESSAGES/m);
  const messagesMatch = content.match(/MESSAGES\n([\s\S]*?)\n?$/m);
  const contextLines = contextMatch
    ? contextMatch[1].split("\n").map((line) => line.trim()).filter((line) => line.startsWith("- "))
    : [];
  const lines = messagesMatch
    ? messagesMatch[1].split("\n").map((line) => line.trim()).filter((line) => line.startsWith("- "))
    : [];
  return { contextLines, lines };
}

function normaliseSceneLine(line, leftName) {
  if (line.startsWith("- You:")) {
    return `- ${leftName}:${line.slice("- You:".length)}`;
  }
  return line;
}

function isRenderableSceneMessage(message) {
  const text = typeof message === "string"
    ? message.replace(/^- /, "").replace(/^[^:]+:\s*/, "").trim()
    : typeof message?.text === "string"
    ? message.text.trim()
    : "";
  if (!text) return false;
  if (text === "..." || text === "(waiting)") return false;
  return true;
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

function readStepSummaryFromConvex() {
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

function buildFallbackSceneSummaries(records) {
  const sceneMap = new Map();
  for (const entry of records) {
    const liveScene = readLiveChatSceneFallback(entry.agent);
    if (!liveScene) continue;
    const agentDisplay = entry.record?.agentName ?? entry.agent;
    const key = pairKey(agentDisplay, liveScene.partner);
    if (sceneMap.has(key)) continue;
    const thread = readChatThreadFallback(entry.agent, liveScene.partner);
    sceneMap.set(key, {
      left: agentDisplay,
      right: liveScene.partner,
      location: liveScene.location,
      recentMessages: thread.lines.slice(-4).map((line) => normaliseSceneLine(line, agentDisplay)),
    });
  }
  return Array.from(sceneMap.values());
}

const records = AGENTS.map((agent) => ({
  agent,
  record: readLastTerminalRecord(agent),
}));

const summary = readStepSummaryFromConvex();
const liveScenes = Array.isArray(summary?.liveScenes)
  ? summary.liveScenes
  : buildFallbackSceneSummaries(records);

const sceneParticipantNames = new Set();
for (const scene of liveScenes) {
  sceneParticipantNames.add(scene.left);
  sceneParticipantNames.add(scene.right);
}

const worldActionRecords = records.filter((entry) => {
  const agentDisplay = entry.record?.agentName ?? entry.agent;
  return !sceneParticipantNames.has(agentDisplay);
});

const headerRecord = records.map((entry) => entry.record).find(Boolean);
const header = summary
  ? `Tick ${summary.tick} | Day ${summary.day} | ${summary.timeOfDay}`
  : headerRecord
  ? `Tick ${headerRecord.tick} | Day ${headerRecord.day} | ${headerRecord.timeOfDay}`
  : "No tick records yet.";

console.log("Rocklaw World Step");
console.log("------------------------------------------------------------------------------");
console.log(header);
console.log("");

console.log("WORLD ACTIONS");
for (const { agent, record } of worldActionRecords) {
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

if (worldActionRecords.length === 0) {
  console.log("(none)");
}

console.log("");
console.log("LIVE CHAT SCENES");
if (!Array.isArray(liveScenes) || liveScenes.length === 0) {
  console.log("(none)");
} else {
  for (const scene of liveScenes) {
    console.log("  +------------------------------------------------------------+");
    console.log(`  | ${scene.left} <-> ${scene.right} @ ${scene.location}`);
    console.log("  |");
    if (Array.isArray(scene.recentMessages) && scene.recentMessages.length > 0) {
      for (const message of scene.recentMessages.filter(isRenderableSceneMessage)) {
        if (typeof message === "string") {
          console.log(`  | ${message}`);
        } else {
          console.log(`  | - ${message.fromAgent}: ${message.text}`);
        }
      }
    } else {
      console.log("  | (no thread lines found)");
    }
    console.log("  +------------------------------------------------------------+");
  }
}

console.log("");
console.log("Detailed transcripts:");
for (const agent of AGENTS) {
  console.log(`  npm run watch:agent -- ${agent}`);
}
