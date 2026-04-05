#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const AGENTS = ["elena", "marcus", "finn", "lena", "sera"];
const INLINE_MESSAGE_MAX = 88;
const OUTCOME_NOTE_MAX = 52;
const SCENE_BOX_WIDTH = 60;
const SNAPSHOT_SHORTAGE_MAX = 4;
const PRICE_DELTA_THRESHOLD = 10;

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
  if (action === "chat") {
    const intent = typeof record?.parsedAction?.intent === "string" ? record.parsedAction.intent : null;
    const target = record?.parsedAction?.target ?? null;
    if (intent === "accept_transaction" || intent === "reject_transaction") {
      const ref = record?.parsedAction?.offer_ref ?? "offer";
      return `chat[${intent === "accept_transaction" ? "accept" : "reject"} ${ref}]${target ? ` -> ${target}` : ""}`;
    }
    if (intent === "buy" || intent === "sell" || intent === "give" || intent === "pay" || intent === "trade") {
      const item = record?.parsedAction?.item ?? null;
      const quantity = typeof record?.parsedAction?.quantity === "number" ? record.parsedAction.quantity : null;
      const amount = typeof record?.parsedAction?.amount === "number" ? record.parsedAction.amount : null;
      const offerBits = [];
      if (item && quantity) offerBits.push(`${item} x${quantity}`);
      if (amount) offerBits.push(`for ${amount}c`);
      return `chat[${intent}${offerBits.length > 0 ? ` ${offerBits.join(" ")}` : ""}]${target ? ` -> ${target}` : ""}`;
    }
  }
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
    ? ` | ${trimInline(record.validation.note, OUTCOME_NOTE_MAX)}`
    : "";
  return `${outcome}${note}`;
}

function formatBusyState(agentState) {
  if (!agentState?.busy) return null;
  return `busy${agentState.busyLabel ? ` | ${agentState.busyLabel}` : ""}`;
}

function trimInline(text, max = INLINE_MESSAGE_MAX) {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1).trimEnd()}…`;
}

function formatModelLabel(provider, model) {
  const safeProvider = provider ?? "default";
  const safeModel = model ?? "default";
  if (safeProvider === "openrouter") return safeModel;
  return `${safeProvider}/${safeModel}`;
}

function wrapText(text, width) {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return [""];
  const words = compact.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= width) {
      current += ` ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines;
}

function renderSceneBoxLine(text = "") {
  const safe = text.length > SCENE_BOX_WIDTH ? `${text.slice(0, SCENE_BOX_WIDTH - 1)}…` : text;
  return `  | ${safe.padEnd(SCENE_BOX_WIDTH)} |`;
}

function renderSceneMessage(message) {
  const text = typeof message === "string"
    ? message
    : `- ${message.fromAgent}: ${message.text}`;
  return wrapText(text, SCENE_BOX_WIDTH).map((line) => renderSceneBoxLine(line));
}

function formatInlineExtras(record, busyStatus, liveSceneStatus) {
  const extras = [];
  const outward = record?.parsedAction?.message ?? record?.parsedAction?.text;
  if (typeof outward === "string" && outward.trim() !== "") {
    extras.push(trimInline(outward));
  }
  if (busyStatus) extras.push(busyStatus);
  if (liveSceneStatus) extras.push(liveSceneStatus);
  return extras.length > 0 ? ` | ${extras.join(" | ")}` : "";
}

function pairKey(left, right) {
  return [left, right].sort((a, b) => a.localeCompare(b)).join("::");
}

function formatOfferLedgerLine(entry) {
  const summary = `${entry.kind} ${entry.offerSummary} for ${entry.requestSummary}`;
  if (entry.status === "pending" && entry.createdThisTick) {
    return `created ${entry.txnId}: ${entry.fromAgent} -> ${entry.toAgent} | ${summary}`;
  }
  if (entry.resolvedThisTick) {
    return `${entry.status} ${entry.txnId}: ${entry.fromAgent} -> ${entry.toAgent} | ${summary}`;
  }
  return `${entry.status} ${entry.txnId}: ${summary}`;
}

function formatPriceDeltaLine(entry) {
  const bits = [`${entry.item}: ${entry.price}c`];
  if (typeof entry.changePct === "number") bits.push(`${entry.changePct >= 0 ? "+" : ""}${entry.changePct}%`);
  if (entry.previousShortageLevel && entry.previousShortageLevel !== entry.shortageLevel) {
    bits.push(`${entry.previousShortageLevel} -> ${entry.shortageLevel}`);
  } else if (entry.shortageLevel && entry.shortageLevel !== "none") {
    bits.push(`${entry.shortageLevel} shortage`);
  }
  return bits.join(" | ");
}

function printSection(title, lines) {
  if (!Array.isArray(lines) || lines.length === 0) return;
  console.log("");
  console.log(title);
  for (const line of lines) {
    console.log(line);
  }
}

function readLiveChatSceneFallback(agent) {
  const turnPath = path.join(ROOT, "agents", agent, "workspace", "TURN.md");
  if (!fs.existsSync(turnPath)) return null;
  const content = fs.readFileSync(turnPath, "utf8");
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
      recentMessages: thread.lines.map((line) => normaliseSceneLine(line, agentDisplay)),
    });
  }
  return Array.from(sceneMap.values());
}

const records = AGENTS.map((agent) => ({
  agent,
  record: readLastTerminalRecord(agent),
}));

const summary = readStepSummaryFromConvex();
const agentStateByName = new Map(
  Array.isArray(summary?.agents) ? summary.agents.map((agent) => [agent.name, agent]) : [],
);
const liveScenes = Array.isArray(summary?.liveScenes)
  ? summary.liveScenes
  : buildFallbackSceneSummaries(records);

const sceneParticipantNames = new Set();
for (const scene of liveScenes) {
  sceneParticipantNames.add(scene.left);
  sceneParticipantNames.add(scene.right);
}

const worldActionRecords = records;
const activeAgents = process.env.ROCKLAW_ACTIVE_AGENTS
  ? process.env.ROCKLAW_ACTIVE_AGENTS.split(",").map((entry) => entry.trim()).filter(Boolean)
  : [];
const headerRecord = records.map((entry) => entry.record).find(Boolean);
const header = summary
  ? `Tick ${summary.tick} | Day ${summary.day} | ${summary.timeOfDay}`
  : headerRecord
  ? `Tick ${headerRecord.tick} | Day ${headerRecord.day} | ${headerRecord.timeOfDay}`
  : "No tick records yet.";

console.log("Rocklaw World Step");
console.log("------------------------------------------------------------------------------");
console.log(header);
if (activeAgents.length > 0) {
  console.log(`Agents this tick: ${activeAgents.join(", ")}`);
}
console.log("");

const snapshotParts = [];
if (summary) {
  snapshotParts.push(`live scenes: ${Array.isArray(summary.liveScenes) ? summary.liveScenes.length : 0}`);
  snapshotParts.push(`pending offers: ${summary.pendingOfferCount ?? 0}`);
  if (Array.isArray(summary.criticalShortages) && summary.criticalShortages.length > 0) {
    snapshotParts.push(`critical shortages: ${summary.criticalShortages.slice(0, SNAPSHOT_SHORTAGE_MAX).join(", ")}`);
  }
  if (summary.biggestPriceMover?.item) {
    snapshotParts.push(
      `biggest mover: ${summary.biggestPriceMover.item} ${summary.biggestPriceMover.changePct >= 0 ? "+" : ""}${summary.biggestPriceMover.changePct}%`,
    );
  }
}
if (snapshotParts.length > 0) {
  console.log("WORLD SNAPSHOT");
  console.log(snapshotParts.join(" | "));
  console.log("");
}

console.log("WORLD ACTIONS");
for (const { agent, record } of worldActionRecords) {
  const agentName = record?.agentName ?? agent;
  const agentState = agentStateByName.get(agentName) ?? agentStateByName.get(agent);
  const provider = agentState?.provider ?? "default";
  const model = agentState?.model ?? "default";
  const modelLabel = formatModelLabel(provider, model);
  const recordTick = typeof record?.tick === "number" ? record.tick : null;
  const summaryTick = typeof summary?.tick === "number" ? summary.tick : null;
  const staleRecord = summaryTick !== null && recordTick !== null ? recordTick < summaryTick : false;
  const busyStatus = formatBusyState(agentState);
  const liveSceneStatus = sceneParticipantNames.has(agentName) ? "in live scene" : null;

  if (busyStatus && (!record || staleRecord)) {
    const extras = [busyStatus, liveSceneStatus].filter(Boolean).join(" | ");
    console.log(`${agent.padEnd(8)} ${modelLabel.padEnd(34)} ${"(in progress)".padEnd(28)} ${extras}`);
    continue;
  }

  if (staleRecord) {
    const extras = ["idle", liveSceneStatus].filter(Boolean).join(" | ");
    console.log(`${agent.padEnd(8)} ${modelLabel.padEnd(34)} ${"(no action this tick)".padEnd(28)} ${extras}`);
    continue;
  }

  if (!record) {
    console.log(`${agent.padEnd(8)} ${modelLabel.padEnd(34)} no tick record yet`);
    continue;
  }
  const inlineExtras = formatInlineExtras(
    record,
    busyStatus && recordTick === summaryTick ? busyStatus : null,
    liveSceneStatus,
  );
  console.log(
    `${agent.padEnd(8)} ${modelLabel.padEnd(34)} ${formatAction(record).padEnd(28)} ${formatOutcome(record)}${inlineExtras}`,
  );
}

if (worldActionRecords.length === 0) {
  console.log("(none)");
}

console.log("");
const suspiciousLines = [];
for (const { agent, record } of worldActionRecords) {
  if (!record) continue;
  const outcome = record?.validation?.outcome ?? record?.phase ?? "unknown";
  if (["parse_failed", "invalid_action", "transport_failed"].includes(outcome)) {
    suspiciousLines.push(`- ${record.agentName ?? agent}: ${trimInline(record?.validation?.note ?? outcome, 120)}`);
  }
}
if (summary) {
  for (const scene of summary.liveScenes ?? []) {
    if ((scene.stallTurns ?? 0) > 0) {
      suspiciousLines.push(`- live scene ${scene.left} <-> ${scene.right}: stalled ${scene.stallTurns} turn(s), next ${scene.nextSpeaker}`);
    }
  }
  for (const agent of summary.agents ?? []) {
    const note = typeof agent.pendingNote === "string" ? agent.pendingNote : "";
    if (note.includes("still active") || note.includes("Return exactly one JSON action")) {
      suspiciousLines.push(`- ${agent.name}: ${trimInline(note, 120)}`);
    }
  }
}
printSection("FAILED / SUSPICIOUS", suspiciousLines);

const interruptLines = Array.isArray(summary?.interrupts)
  ? summary.interrupts.map((line) => `- ${trimInline(line, 140)}`)
  : [];
printSection("INTERRUPTS / REPLANS", interruptLines);

const offerLines = Array.isArray(summary?.transactionDeltas)
  ? summary.transactionDeltas.map((entry) => `- ${formatOfferLedgerLine(entry)}`)
  : [];
printSection("OFFERS", offerLines);

const worldDeltaLines = [];
if (Array.isArray(summary?.priceDeltas)) {
  for (const entry of summary.priceDeltas) {
    const shortageChanged = entry.previousShortageLevel && entry.previousShortageLevel !== entry.shortageLevel;
    if (Math.abs(entry.changePct ?? 0) < PRICE_DELTA_THRESHOLD && !shortageChanged) continue;
    worldDeltaLines.push(`- ${formatPriceDeltaLine(entry)}`);
  }
}
if (Array.isArray(summary?.currentTickActions)) {
  for (const entry of summary.currentTickActions) {
    if (entry.action === "buy_place" || entry.action === "sell_place" || entry.action === "deliver_place") {
      worldDeltaLines.push(
        `- place trade: ${entry.agentName} ${entry.action}${entry.target ? ` @ ${entry.target}` : ""}${entry.outcomeNote ? ` | ${trimInline(entry.outcomeNote, 90)}` : ""}`,
      );
    }
  }
}
printSection("WORLD DELTAS", Array.from(new Set(worldDeltaLines)));

if (!Array.isArray(liveScenes) || liveScenes.length === 0) {
  console.log("LIVE CHAT SCENES: (none)");
} else {
  console.log("LIVE CHAT SCENES");
  for (const scene of liveScenes) {
    console.log("  +------------------------------------------------------------+");
    console.log(`  | ${scene.left} <-> ${scene.right} @ ${scene.location}`);
    const sceneMetaBits = [];
    if (scene.nextSpeaker) sceneMetaBits.push(`next: ${scene.nextSpeaker}`);
    if (scene.lastSpeaker) sceneMetaBits.push(`last: ${scene.lastSpeaker}`);
    if (typeof scene.stallTurns === "number") sceneMetaBits.push(`stall: ${scene.stallTurns}`);
    if (Array.isArray(scene.pendingOffers) && scene.pendingOffers.length > 0) {
      sceneMetaBits.push(
        `offers: ${scene.pendingOffers.map((offer) => `${offer.txnId} (${offer.kind} ${offer.offerSummary} for ${offer.requestSummary})`).join("; ")}`,
      );
    }
    if (sceneMetaBits.length > 0) {
      for (const line of wrapText(sceneMetaBits.join(" | "), SCENE_BOX_WIDTH)) {
        console.log(renderSceneBoxLine(line));
      }
    }
    console.log("  |");
    if (Array.isArray(scene.recentMessages) && scene.recentMessages.length > 0) {
      for (const message of scene.recentMessages.filter(isRenderableSceneMessage)) {
        for (const line of renderSceneMessage(message)) {
          console.log(line);
        }
      }
    } else {
      console.log(renderSceneBoxLine("(no thread lines found)"));
    }
    console.log("  +------------------------------------------------------------+");
  }
}

console.log("");
console.log(`Detailed transcripts: npm run watch:agent -- <agent>  (${AGENTS.join(", ")})`);
