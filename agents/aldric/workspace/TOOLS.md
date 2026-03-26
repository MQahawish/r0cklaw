# How to Interact with Rocklaw

## Runtime rule

These notes describe the kinds of actions that exist in Rocklaw.
In ZeroClaw session mode, do NOT run shell commands like move.sh, craft.sh, talk.sh, or pray.sh to perform them.
Use your available tools only to inspect files, recall memory, and update your private notes.
When you are ready to act in the world, return the final Rocklaw JSON action instead.


All interaction with the world happens through JSON actions that the Rocklaw engine executes.
The legacy `.sh` names in older notes are conceptual labels only, not commands you should run.

Your world/ files are always up to date when you wake up.
You do not need to refresh them -- they were updated before your tick.

## Search your deep memory

Use your available memory recall tool when something feels familiar but is not in your current files.
Use it to search your full memory for relevant past events.

## Core action schema

Return one JSON object when you are ready to act. Use only the fields that matter.

```json
{
  "action": "...",
  "duration_ticks": 1,
  "target": "optional agent name",
  "location": "optional location name",
  "text": "optional spoken or written content",
  "topic": "optional observation topic",
  "item": "optional item name",
  "quantity": 1,
  "amount": 0,
  "consumes": [],
  "produces": [],
  "offer": [],
  "request": [],
  "thought": "optional why you chose this action now",
  "message": "optional outward wording or visible framing",
  "memory_note": "optional private takeaway to remember later"
}
```

## Economic actions right now

### Available now
- `buy`: Available now because a trade partner is here.
- `sell`: Available now because a trade partner is here.
- `trade`: Available now because a trade partner is here.

### Unavailable here
  (none)
## Act in the world

- `talk`: use `target` and `text`; this creates an active local interaction if the other person is here
  Example JSON: `{"action":"talk","target":"Marcus Hale","text":"I need coal by Day 9.","duration_ticks":1}`
- `move`: use `location` and choose only from `Reachable places now` in `world/location.md`
  Example JSON: `{"action":"move","location":"market","duration_ticks":1}`
- `eat`: use `item`, optional `quantity`
  Example JSON: `{"action":"eat","item":"bread","quantity":1,"duration_ticks":1}`

## Speaking into the world

If you want to pray, return a final JSON action with `"action": "pray"` and put the prayer text in `text`.

## Priest skills

`bless`
  Offer a blessing. Boosts morale. No material cost.
  Example JSON: use the `bless` action with the typed fields for this verb.

`counsel`
  Offer private counsel to someone who needs it.
  They must be at the shrine. This is confidential.
  Example JSON: use the `counsel` action with the typed fields for this verb.

`preach`
  Speak to the village from the shrine steps.
  What you say becomes village news.
  Example JSON: use the `preach` action with the typed fields for this verb.

`officiate`
  Preside over a rite: naming, wedding, funeral.
  Example JSON: use the `officiate` action with the typed fields for this verb.
