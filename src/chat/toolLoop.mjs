// The agentic tool loop — the seam that turns one LLM call into a chain.
//
// Before: handleMessage made ONE messages.create() and returned the text.
// After: the model can answer with a tool call instead, we run it, hand back the
// result, and let it call again. That loop is what lets "weather where I'm meeting
// Sarah" resolve in a single user turn: recall supplies the place name, geocode
// turns it into coordinates, forecast turns those into a temperature.
//
// Docs (read these two before filling in the TODOs):
//   - Tool use overview: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview
//   - Handling stop reasons: https://docs.anthropic.com/en/api/handling-stop-reasons
//
// The API contract, in four rules — the TODOs below are just these rules in order:
//   1. `stop_reason === "tool_use"` means the model is asking you to run something.
//      Anything else (`end_turn`, `max_tokens`) means it's done talking.
//   2. Push the assistant's ENTIRE `content` array back into messages, unmodified.
//      The tool_use blocks live in there; drop them and the next request 400s
//      because your tool_results reference ids that no longer exist.
//   3. One assistant turn can contain SEVERAL tool_use blocks (parallel calls are
//      on by default). Run them all, and return every tool_result in a SINGLE
//      user message. Splitting them across messages teaches the model to stop
//      calling tools in parallel.
//   4. A failed tool is `{ type: "tool_result", tool_use_id, content: <msg>, is_error: true }`
//      — NOT a thrown error. Feeding the failure back is what produces the
//      degradation answer ("can't reach weather, but you're at Ritual at 3")
//      instead of a 500. This is architectural pattern #2 in practice.

import { toAnthropicTools, runTool } from "../tools/registry.mjs";

// Bound the loop. Demo 1 needs exactly 2 rounds (geocode -> weather); 3 leaves one
// spare for a retry after a failure. Unbounded loops burn the p95 < 3s budget.
const MAX_ITERATIONS = 3;

// ─── runToolTurn({ ... }) → final text ───
// Drop-in replacement for the single messages.create() at handleMessage.mjs:349.
//   anthropic   — the module-level SDK client (passed in, not re-created)
//   model       — TOOL_MODEL; haiku for latency (2 round-trips inside a 3s budget)
//   system      — the fenced-context system prompt formatContext() already builds
//   userMessage — the raw user turn
//   trace       — ?debug=1 side-channel; append tool executions to trace.tools
//   ctx         — per-request context handed to runTool (carries forceFail)
export async function runToolTurn({
  anthropic,
  model,
  system,
  userMessage,
  trace = null,
  ctx = {},
  maxIters = MAX_ITERATIONS,
}) {

  const messages = [{ role: "user", content: userMessage }];

  for (let iteration = 0; iteration < maxIters; iteration++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 400,
      system,
      messages,
      tools: toAnthropicTools(),
    });

    //If `response.stop_reason !== "tool_use"`, the model answered in prose.
    if (response.stop_reason !== "tool_use") {
      const block = response.content.find(b => b.type === "text");
      return block?.text ?? "";
    }

    const toolBlocks = response.content.filter(b => b.type === "tool_use");
    if (toolBlocks.length === 0) {
      console.warn("runToolTurn(): stop_reason=tool_use but no tool_use blocks found");
      break;
    }
    // TODO 6: run them all, concurrently.
    //   Promise.all over the blocks, calling runTool(block.name, block.input, ctx).
    //   runTool never throws — it returns { name, input, ok, ms, result|error }.
    //   Sequential await here would double the latency on a 2-tool chain.
    //  Assign the array of results to `results`.
    const results = await Promise.all(
      toolBlocks.map(block => runTool(block.name, block.input, ctx))
    );
    // TODO 7: record for the debug trace + eval.
    //   If `trace`, push each execution onto `trace.tools` (create the array if
    //   it doesn't exist). Shape: { name, input, ok, ms, error? } — the eval's
    //   toolchain stage asserts on exactly this, especially `input`, which is
    //   the proof that the memory supplied the parameter.
    if (trace) {
      trace.tools ??= [];
      for (const r of results) {
        trace.tools.push({
          name: r.name,
          input: r.input,
          ok: r.ok,
          ms: r.ms,
        ...(r.ok ? {} : { error: r.error }),
        });
      }
    }
  
    messages.push({ role: "assistant", content: response.content }); //assitant message turn gets pushed(1st) for iteration, with requests


    const allBlocks = toolBlocks.map((block, i) => { 
      //Extract one result
      const result = results[i];
      //if result.okay is true , we map it to one block to be stored in a allBlocks array
      if (result.ok) {
        return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result.result) };
      } else {
        return { type: "tool_result", tool_use_id: block.id, content: result.error, is_error: true };
      }
    });

    messages.push({ role: "user", content: allBlocks }); //user message turn gets pushed(2nd) for iteration, with all the tool results

  }
  const response = await anthropic.messages.create({
      model,
      max_tokens: 400,
      system,
      messages,
    });
  console.warn("Max Iterations exceeded on toolLoop");
  const block = response.content.find(b => b.type === "text");
  return block?.text ?? "";
}
