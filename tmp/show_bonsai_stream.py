import json
import sys

shown_thinking = False
shown_answer = False

for line in sys.stdin:
    if not line.startswith("data: "):
        continue

    payload = line[6:].strip()
    if payload == "[DONE]":
        print()
        break

    try:
        obj = json.loads(payload)
    except Exception:
        continue

    delta = obj["choices"][0]["delta"]
    reasoning = delta.get("reasoning_content")
    content = delta.get("content")

    if reasoning:
        if not shown_thinking:
            print("Thinking:\n", end="")
            shown_thinking = True
        print(reasoning, end="", flush=True)

    if content:
        if not shown_answer:
            print("\n\nAnswer:\n" if shown_thinking else "Answer:\n", end="")
            shown_answer = True
        print(content, end="", flush=True)
