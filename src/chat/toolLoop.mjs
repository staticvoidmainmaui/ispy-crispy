// The agentic tool loop — turns one LLM call into a chain.
// https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview
//
// Contract: stop_reason "tool_use" = run something. Push assistant content back
// verbatim. All tool_results in ONE user message. Failures go back as
// is_error:true, never thrown.

import { toAnthropicTools, runTool } from "../tools/registry.mjs";

// Demo 1 chains get_calendar -> geocode -> forecast -> travel_time -> propose. That is
// four passes minimum; 6 leaves room for one retry without unbounding the turn.
const MAX_ITERATIONS = 6;

// 400 truncated a multi-event day plan mid-sentence.
const MAX_TOKENS = 1024;

// ─── runToolTurn({ ... }) → { text, toolCalls, usage } ───
// onEvent is the streaming seam: called with protocol-shaped events as they happen, so
// the SSE route can forward them and the buffered route can ignore them.
export async function runToolTurn({
  anthropic,
  model,
  system,
  userMessage,
  trace = null,
  ctx = {},
  maxIters = MAX_ITERATIONS,
  onEvent = null,
}) {

  const messages = [{ role: "user", content: userMessage }];

  // The ledger's record of the chain. seq is monotonic ACROSS iterations — it is the
  // chain order — while `iteration` records which tools ran concurrently.
  const toolCalls = [];
  const usage = { input: 0, output: 0 };
  let seq = 0;

  for (let iteration = 0; iteration < maxIters; iteration++) {
    const response = await send({
      anthropic, model, system, messages, onEvent,
      tools: toAnthropicTools(),
    });

    usage.input  += response.usage?.input_tokens  ?? 0;
    usage.output += response.usage?.output_tokens ?? 0;

    // If stop_reason isn't tool_use, the model answered in prose — the chain is done.
    if (response.stop_reason !== "tool_use") {
      return { text: textOf(response), toolCalls, usage };
    }

    const toolBlocks = response.content.filter(b => b.type === "tool_use");
    if (toolBlocks.length === 0) {
      // stop_reason says tool_use but nothing to run. Return what prose we have rather
      // than falling through to a second billed call that would add nothing.
      console.warn("runToolTurn(): stop_reason=tool_use but no tool_use blocks found");
      return { text: textOf(response), toolCalls, usage };
    }

    // Concurrent: sequential would double latency on a 2-tool chain.
    const startSeq = seq;
    seq += toolBlocks.length;

    for (const [i, block] of toolBlocks.entries()) {
      onEvent?.({ type: "tool_start", seq: startSeq + i, iteration, name: block.name, input: block.input });
    }

    const results = await Promise.all(
      toolBlocks.map(block => runTool(block.name, block.input, ctx))
    );

    results.forEach((result, i) => {
      const record = {
        seq: startSeq + i,
        iteration,
        tool_name: result.name,
        input: result.input ?? null,
        output: result.ok ? (result.result ?? null) : null,
        ok: result.ok,
        error: result.ok ? null : result.error,
        latency_ms: result.ms,
      };
      toolCalls.push(record);

      onEvent?.({
        type: "tool_end",
        seq: record.seq,
        ok: record.ok,
        ms: record.latency_ms,
        ...(record.ok ? { output: record.output } : { error: record.error }),
      });

      // Debug trace — the eval's toolchain stage asserts on `input`.
      if (trace) {
        trace.tools ??= [];
        trace.tools.push({
          name: result.name,
          input: result.input,
          ok: result.ok,
          ms: result.ms,
          ...(result.ok ? {} : { error: result.error }),
        });
      }
    });

    messages.push({ role: "assistant", content: response.content }); // verbatim — orphaned ids 400

    // All tool_results in ONE user message: splitting them trains the model out of
    // parallel calls.
    messages.push({
      role: "user",
      content: toolBlocks.map((block, i) => results[i].ok
        ? { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(results[i].result) }
        : { type: "tool_result", tool_use_id: block.id, content: results[i].error, is_error: true }),
    });
  }

  // Iterations exhausted. Re-ask with tools OMITTED, which forces prose.
  console.warn("runToolTurn(): max iterations exceeded — forcing a prose answer");
  const final = await send({ anthropic, model, system, messages, onEvent, tools: null });
  usage.input  += final.usage?.input_tokens  ?? 0;
  usage.output += final.usage?.output_tokens ?? 0;

  return { text: textOf(final), toolCalls, usage };
}

// ─── send(...) → the finished message ───
// Streams when someone is listening, buffers when nobody is. Either way the caller gets
// the same shape, so the loop above doesn't branch on it.
async function send({ anthropic, model, system, messages, tools, onEvent }) {
  const request = {
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages,
    ...(tools ? { tools } : {}),
  };

  if (!onEvent) {
    return anthropic.messages.create(request);
  }

  const stream = anthropic.messages.stream(request);
  stream.on("text", delta => onEvent({ type: "text", delta }));
  return stream.finalMessage();
}

const textOf = (response) => response.content.find(b => b.type === "text")?.text ?? "";
