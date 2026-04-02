# How to Interact with Rocklaw

## Runtime rule

These notes describe the kinds of actions that exist in Rocklaw.
In ZeroClaw session mode, do NOT run shell commands like move.sh, work.sh, talk.sh, or pray.sh to perform them.
Use your available tools only to inspect files before your final action.
When you are ready to act in the world, return the final Rocklaw JSON action instead.

All interaction with the world happens through JSON actions that the Rocklaw engine executes.
The legacy `.sh` names in older notes are conceptual labels only, not commands you should run.

Your world/ files are always up to date when you wake up.
You do not need to refresh them -- they were updated before your tick.

## Core action schema

Return one JSON object when you are ready to act. Use only the fields that matter.

```json
{
  "action": "...",
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
  "message": "optional outward wording or visible framing"
}
```

## Economic actions right now

### Available now
  (none)

### Unavailable here
  (none)
## Act in the world

- Do not use `observe`, `inspect`, `look`, or `survey` as a final world action. Observation is done through file reads and notes during tool use.
- Do not invent placeholder values in JSON. Never put strings like `"None"`, `"null"`, `"unknown"`, or `<placeholder>` into `target`, `offer_ref`, `item`, or other optional fields. Omit the field instead.
- Only use `chat` with `intent:"accept_transaction"` or `intent:"reject_transaction"` when `TURN.md` shows a real pending offer with a concrete `offer_ref`.
- If no actionable `offer_ref` is shown, do not invent one and do not use `offer_id`, `offer`, or `request` with `accept_transaction`.
- If you want to agree to the partner's proposed terms but no actionable `offer_ref` is shown, restate the deal as a fresh structured `buy`, `sell`, or `trade` offer instead.
- If `ONLINE`, live scenes, and known thread contacts are empty, do not target a person. Choose a non-chat action instead.
- Do not infer a person from a role need alone. Needing a blacksmith, farmer, merchant, or healer does not make someone a valid target unless `TURN.md` currently shows them as a real contact.
- Do not repeat the same quantity-and-price counteroffer twice in a row. If your last spoken deal already matches your current position, either accept, reject, leave, or make a meaningfully different counteroffer.
- Social progress also counts as progress in chat. It is valid to ask what someone is doing, how things are going, what they think of a shortage, or what impression they made on you, as long as you stay grounded in the current scene.
- People in hard situations do not reveal everything for free and they do not accept pressure without pushing back. Use `chat` with `intent:"lie"` when hiding the truth protects your position. Use `chat` with `intent:"threaten"` when someone needs to feel that refusal has consequences. Use `say` with `intent:"gossip"` when shaping what nearby people hear helps you.

- `chat`: use `target` and `text`; if the other person is here it becomes a live chat, otherwise it becomes a deferred chat in their CHAT thread.
  Example JSON: `{"action":"chat","target":"<known contact from TURN.md>","text":"Do you still have coal?"}`
- `chat` may also carry `intent:"lie"` or `intent:"threaten"` when concealment or pressure fits the scene.
  Example JSON: `{"action":"chat","target":"<known contact from TURN.md>","text":"That is all the grain I have left.","intent":"lie"}`
  Example JSON: `{"action":"chat","target":"<known contact from TURN.md>","text":"Keep pressing me and I will remember it.","intent":"threaten"}`
- For `intent:"trade"`, natural-language text alone is invalid. You must include both `offer` and `request` arrays.
  Example JSON: `{"action":"chat","target":"<current live chat partner>","text":"Would you trade three bread for one medicine?","intent":"trade","offer":[{"item":"bread","quantity":3}],"request":[{"item":"medicine","quantity":1}]}`
- `move`: use `location` and choose only from `Reachable places now` in `TURN.md`.
  Example JSON: `{"action":"move","location":"market"}`
- `buy_place`: buy stock directly from the place you are standing in at the local price shown in `TURN.md`.
  Example JSON: `{"action":"buy_place","target":"market","item":"coal","quantity":3}`
- `sell_place`: sell stock directly into the place you are standing in at the local price shown in `TURN.md`.
  Example JSON: `{"action":"sell_place","target":"bakery","item":"grain","quantity":4}`
- `deliver_place`: move your own stock into a place without immediate payment. This is storage or supply, not a sale.
  Example JSON: `{"action":"deliver_place","target":"warehouse","item":"coal","quantity":5}`
- `use`: directly use a usable item from your own inventory.
  Example JSON: `{"action":"use","item":"medicine","thought":"I need to recover health before harder work."}`
- `sleep`: include a short `journal` paragraph. Keep it private and reflective, not just economic bookkeeping; mention people, feelings, surprises, worries, or changing impressions when they matter.
  Example JSON: `{"action":"sleep","journal":"Long day. Sera seemed more practical than I expected, and I should keep an eye on the meal shortage tomorrow.","thought":"I need proper sleep before morning."}`

## Speaking into the world

- `say`: use `text` to speak out loud in your current location. This is local speech, not a thread, and it does not take a target.
  Example JSON: `{"action":"say","text":"Fresh bread at the inn if anyone wants some."}`
- `say` may also carry `intent:"gossip"` when you want to spread rumor or shape what nearby people hear in public.

If you want to pray, return a final JSON action with `"action": "pray"` and put the prayer text in `text`.
