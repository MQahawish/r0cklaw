#!/usr/bin/env node

const topN = Number.parseInt(process.argv[2] ?? '8', 10);
const response = await fetch('https://openrouter.ai/api/v1/models');
if (!response.ok) {
  throw new Error(`OpenRouter model fetch failed: ${response.status} ${response.statusText}`);
}

const payload = await response.json();
const models = Array.isArray(payload?.data) ? payload.data : [];

const ranked = models
  .filter((model) =>
    model?.pricing?.prompt === '0'
    && model?.pricing?.completion === '0'
    && Array.isArray(model?.supported_parameters)
    && model.supported_parameters.includes('tools'))
  .map((model) => ({
    id: model.id,
    name: model.name,
    contextLength: model?.top_provider?.context_length ?? model?.context_length ?? 0,
  }))
  .sort((a, b) => b.contextLength - a.contextLength || a.id.localeCompare(b.id))
  .slice(0, Number.isFinite(topN) && topN > 0 ? topN : 8);

if (ranked.length === 0) {
  throw new Error('No free OpenRouter models with tool support were found.');
}

process.stdout.write(JSON.stringify({
  selected: ranked[0]?.id,
  candidates: ranked.map((entry) => entry.id),
  ranked,
}));
