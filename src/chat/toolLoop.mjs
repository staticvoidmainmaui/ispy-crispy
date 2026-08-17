// The agentic tool loop — turns one LLM call into a chain.
// https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview
//
// Contract: stop_reason "tool_use" = run something. Push assistant content back
// verbatim. All tool_results in ONE user message. Failures go back as
// is_error:true, never thrown.

import { toAnthropicTools, runTool } from "../tools/registry.mjs";

const MAX_ITERATIONS = 3; // demo 1 needs 2 (geocode -> weather), 1 spare for a retry

// ─── runToolTurn({ ... }) → final text ───
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
    // Concurrent: sequential would double latency on a 2-tool chain.
    const results = await Promise.all(
      toolBlocks.map(block => runTool(block.name, block.input, ctx))
    );

    // Debug trace — the eval's toolchain stage asserts on `input`.
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
