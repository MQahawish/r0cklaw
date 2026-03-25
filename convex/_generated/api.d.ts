/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import type * as agent_conversation from "../agent/conversation.js";
import type * as agent_embeddingsCache from "../agent/embeddingsCache.js";
import type * as agent_memory from "../agent/memory.js";
import type * as aiTown_agent from "../aiTown/agent.js";
import type * as aiTown_agentDescription from "../aiTown/agentDescription.js";
import type * as aiTown_agentInputs from "../aiTown/agentInputs.js";
import type * as aiTown_agentOperations from "../aiTown/agentOperations.js";
import type * as aiTown_conversation from "../aiTown/conversation.js";
import type * as aiTown_conversationMembership from "../aiTown/conversationMembership.js";
import type * as aiTown_game from "../aiTown/game.js";
import type * as aiTown_ids from "../aiTown/ids.js";
import type * as aiTown_inputHandler from "../aiTown/inputHandler.js";
import type * as aiTown_inputs from "../aiTown/inputs.js";
import type * as aiTown_insertInput from "../aiTown/insertInput.js";
import type * as aiTown_location from "../aiTown/location.js";
import type * as aiTown_main from "../aiTown/main.js";
import type * as aiTown_movement from "../aiTown/movement.js";
import type * as aiTown_player from "../aiTown/player.js";
import type * as aiTown_playerDescription from "../aiTown/playerDescription.js";
import type * as aiTown_world from "../aiTown/world.js";
import type * as aiTown_worldMap from "../aiTown/worldMap.js";
import type * as constants from "../constants.js";
import type * as crons from "../crons.js";
import type * as engine_abstractGame from "../engine/abstractGame.js";
import type * as engine_historicalObject from "../engine/historicalObject.js";
import type * as http from "../http.js";
import type * as init from "../init.js";
import type * as messages from "../messages.js";
import type * as music from "../music.js";
import type * as rocklaw_bridge from "../rocklaw/bridge.js";
import type * as rocklaw_bridgeNode from "../rocklaw/bridgeNode.js";
import type * as rocklaw_compact from "../rocklaw/compact.js";
import type * as rocklaw_compactNode from "../rocklaw/compactNode.js";
import type * as rocklaw_engine from "../rocklaw/engine.js";
import type * as rocklaw_god from "../rocklaw/god.js";
import type * as rocklaw_godNode from "../rocklaw/godNode.js";
import type * as rocklaw_init from "../rocklaw/init.js";
import type * as rocklaw_observe from "../rocklaw/observe.js";
import type * as rocklaw_observeNode from "../rocklaw/observeNode.js";
import type * as rocklaw_priceEngine from "../rocklaw/priceEngine.js";
import type * as rocklaw_reputation from "../rocklaw/reputation.js";
import type * as rocklaw_systems from "../rocklaw/systems.js";
import type * as rocklaw_visualBridge from "../rocklaw/visualBridge.js";
import type * as rocklaw_worldRefresh from "../rocklaw/worldRefresh.js";
import type * as rocklaw_worldRefreshNode from "../rocklaw/worldRefreshNode.js";
import type * as testing from "../testing.js";
import type * as util_FastIntegerCompression from "../util/FastIntegerCompression.js";
import type * as util_assertNever from "../util/assertNever.js";
import type * as util_asyncMap from "../util/asyncMap.js";
import type * as util_compression from "../util/compression.js";
import type * as util_geometry from "../util/geometry.js";
import type * as util_isSimpleObject from "../util/isSimpleObject.js";
import type * as util_llm from "../util/llm.js";
import type * as util_minheap from "../util/minheap.js";
import type * as util_object from "../util/object.js";
import type * as util_sleep from "../util/sleep.js";
import type * as util_types from "../util/types.js";
import type * as util_xxhash from "../util/xxhash.js";
import type * as world from "../world.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  "agent/conversation": typeof agent_conversation;
  "agent/embeddingsCache": typeof agent_embeddingsCache;
  "agent/memory": typeof agent_memory;
  "aiTown/agent": typeof aiTown_agent;
  "aiTown/agentDescription": typeof aiTown_agentDescription;
  "aiTown/agentInputs": typeof aiTown_agentInputs;
  "aiTown/agentOperations": typeof aiTown_agentOperations;
  "aiTown/conversation": typeof aiTown_conversation;
  "aiTown/conversationMembership": typeof aiTown_conversationMembership;
  "aiTown/game": typeof aiTown_game;
  "aiTown/ids": typeof aiTown_ids;
  "aiTown/inputHandler": typeof aiTown_inputHandler;
  "aiTown/inputs": typeof aiTown_inputs;
  "aiTown/insertInput": typeof aiTown_insertInput;
  "aiTown/location": typeof aiTown_location;
  "aiTown/main": typeof aiTown_main;
  "aiTown/movement": typeof aiTown_movement;
  "aiTown/player": typeof aiTown_player;
  "aiTown/playerDescription": typeof aiTown_playerDescription;
  "aiTown/world": typeof aiTown_world;
  "aiTown/worldMap": typeof aiTown_worldMap;
  constants: typeof constants;
  crons: typeof crons;
  "engine/abstractGame": typeof engine_abstractGame;
  "engine/historicalObject": typeof engine_historicalObject;
  http: typeof http;
  init: typeof init;
  messages: typeof messages;
  music: typeof music;
  "rocklaw/bridge": typeof rocklaw_bridge;
  "rocklaw/bridgeNode": typeof rocklaw_bridgeNode;
  "rocklaw/compact": typeof rocklaw_compact;
  "rocklaw/compactNode": typeof rocklaw_compactNode;
  "rocklaw/engine": typeof rocklaw_engine;
  "rocklaw/god": typeof rocklaw_god;
  "rocklaw/godNode": typeof rocklaw_godNode;
  "rocklaw/init": typeof rocklaw_init;
  "rocklaw/observe": typeof rocklaw_observe;
  "rocklaw/observeNode": typeof rocklaw_observeNode;
  "rocklaw/priceEngine": typeof rocklaw_priceEngine;
  "rocklaw/reputation": typeof rocklaw_reputation;
  "rocklaw/systems": typeof rocklaw_systems;
  "rocklaw/visualBridge": typeof rocklaw_visualBridge;
  "rocklaw/worldRefresh": typeof rocklaw_worldRefresh;
  "rocklaw/worldRefreshNode": typeof rocklaw_worldRefreshNode;
  testing: typeof testing;
  "util/FastIntegerCompression": typeof util_FastIntegerCompression;
  "util/assertNever": typeof util_assertNever;
  "util/asyncMap": typeof util_asyncMap;
  "util/compression": typeof util_compression;
  "util/geometry": typeof util_geometry;
  "util/isSimpleObject": typeof util_isSimpleObject;
  "util/llm": typeof util_llm;
  "util/minheap": typeof util_minheap;
  "util/object": typeof util_object;
  "util/sleep": typeof util_sleep;
  "util/types": typeof util_types;
  "util/xxhash": typeof util_xxhash;
  world: typeof world;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
