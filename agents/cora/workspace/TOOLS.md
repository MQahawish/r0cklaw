# How to Interact with Rocklaw

## Runtime rule

These notes describe the kinds of actions that exist in Rocklaw.
In ZeroClaw session mode, do NOT run shell commands like move.sh, craft.sh, talk.sh, leave_message.sh, or pray.sh to perform them.
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

## Economic actions

- `pay`: use `target` and `amount`
  Example JSON: `{"action":"pay","target":"Marcus Hale","amount":10,"duration_ticks":1}`
- `buy`: use `target`, `item`, `quantity`, and `amount` to create an in-person offer
  Example JSON: `{"action":"buy","target":"Marcus Hale","item":"coal","quantity":3,"amount":12,"duration_ticks":1,"thought":"Make Marcus an offer while we are both here."}`
- `sell`: use `target`, `item`, `quantity`, and `amount` to create an in-person offer
  Example JSON: `{"action":"sell","target":"Finn","item":"horseshoe","quantity":2,"amount":62,"duration_ticks":1,"thought":"Offer finished goods while Finn is here."}`
- `give`: use `target`, `item`, `quantity`
  Example JSON: `{"action":"give","target":"Cora","item":"bread","quantity":1,"duration_ticks":1}`
- `trade`: use `target`, `offer`, and `request` to create an in-person offer
  Example JSON: `{"action":"trade","target":"Marcus Hale","offer":[{"item":"horseshoe","quantity":1}],"request":[{"item":"coal","quantity":2}],"duration_ticks":1,"thought":"Propose a direct swap while Marcus is here."}`
- `accept_transaction`: use `target` as the pending offer reference from `world/location.md` (for example `offer-1`) to accept a pending local offer
  Example JSON: `{"action":"accept_transaction","target":"offer-1","duration_ticks":1,"thought":"The offer is fair and we are still together here."}`
- `reject_transaction`: use `target` as the pending offer reference from `world/location.md` (for example `offer-1`) to reject a pending local offer
  Example JSON: `{"action":"reject_transaction","target":"offer-1","duration_ticks":1,"thought":"The offer is poor or no longer works.","message":"No deal."}`

## Act in the world

- `talk`: use `target` and `text`; this creates an active local interaction if the other person is here
  Example JSON: `{"action":"talk","target":"Marcus Hale","text":"I need coal by Day 9.","duration_ticks":1}`
- `move`: use `location` and choose only from `Reachable places now` in `world/location.md`
  Example JSON: `{"action":"move","location":"market","duration_ticks":1}`
- `eat`: use `item`, optional `quantity`
  Example JSON: `{"action":"eat","item":"bread","quantity":1,"duration_ticks":1}`

## Speaking into the world

If you want to pray, return a final JSON action with `"action": "pray"` and put the prayer text in `text`.

## Messages

Use `leave_message` with `target` and `text`.
Example JSON: `{"action":"leave_message","target":"Marcus Hale","text":"Marcus, I need 3 coal before Day 8. I can pay 12 coin. -- Elena","duration_ticks":1,"thought":"Leave terms Marcus can act on later."}`
## Child skills

`run_errand`
  Deliver an item for someone. They must pay you.
  Example JSON: use the `run_errand` action with the typed fields for this verb.

`play`
  Spend time at play. Restores energy completely. Takes time.
  Example JSON: use the `play` action with the typed fields for this verb.

