# Memory-Driven Tool Use

**Topic:** agentic tool loops / grounding tool arguments in retrieved memory
**Where it lives in this project:** `src/chat/toolLoop.mjs`, `src/tools/registry.mjs`

## The idea

A retrieval system that only injects memories as *context* stops at better prose. The
step up is letting a memory supply a tool **argument** — then the memory is load-bearing,
because without it the tool call cannot be made at all.

The demo case: *"What's the weather where I'm meeting Sarah?"* The forecast API takes
coordinates. Nothing in that sentence contains a location. A memoryless agent has exactly
one move — ask "where?" — so a one-turn answer is proof the memory did real work.

```
recall -> "coffee with Sarah, Blue Bottle Oakland"
       -> geocode_place({ place: "Blue Bottle Oakland" })   <- argument came from memory
       -> get_weather({ latitude, longitude })
       -> one-turn answer, no clarifying question
```

## The loop contract

Four rules, all enforced in `runToolTurn`:

1. `stop_reason === "tool_use"` means run something; anything else means the model is done.
2. Push the assistant's **entire** `content` array back unmodified. The `tool_use` blocks
   live there — drop them and the next request 400s on orphaned `tool_use_id`s.
3. One assistant turn can hold several `tool_use` blocks. Run them concurrently and return
   every `tool_result` in a **single** user message; splitting them across messages trains
   the model to stop calling tools in parallel.
4. A failed tool is `{ tool_result, is_error: true }` fed back to the model — never a
   thrown error. This is what produces "I can't reach weather, but you're at Blue Bottle
   at 3" instead of a 500.

## Decisions worth remembering

**Validate before executing.** Tool arguments here originate in user-authored text pulled
from a datastore. The system prompt already fences recalled memories as data, not
instructions; `validate()` in the registry is that same boundary on the way *out* — the
checkpoint between "the model read a memory" and "the process made a network call with
it". Nothing executes unvalidated.

**Bound the loop.** Three iterations. Demo 1 needs two; the third absorbs one failure.
On overflow, make a final call with no `tools` so the model must answer in prose from
whatever results it has — degrade to a chat answer, never to an exception.

**Haiku, not Sonnet, for the tool turn.** The chain is three sequential model
round-trips (geocode, weather, answer), not two — the second tool can't run until the
first returns coordinates. Measured: ~600ms per Haiku round-trip warm, ~630ms for both
HTTP calls. Sonnet busts a 3s budget on the second round alone.

**Nominatim for geocoding, not Open-Meteo.** Open-Meteo's geocoder is a city gazetteer:
`"Blue Bottle Oakland"` returns no match. Memories hold venue names, so a city-only
geocoder fails on the exact input the demo depends on. Nominatim indexes points of
interest. (Policy: identify with a real User-Agent, max 1 request/second.)

## Sources

- Anthropic tool use overview — https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview
- Handling stop reasons — https://docs.anthropic.com/en/api/handling-stop-reasons
- Nominatim search API — https://nominatim.org/release-docs/develop/api/Search/
- Open-Meteo forecast — https://open-meteo.com/en/docs

## Related

- `docs/practices/pre-filtering.md` — the retrieval step that feeds this loop.
