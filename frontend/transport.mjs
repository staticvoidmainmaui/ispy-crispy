// ─── The swap seam ─── two producers, one callback signature.
//
// Both push { event, data } into onFrame. That is the ONLY thing render knows about,
// so connecting to the real backend is a one-line change in main.mjs:
//
//     replayFixture(fx.frames, onFrame)   →   streamTurn(message, userId, onFrame)
//
// Note POST: /chat/stream takes a JSON body (src/server.mjs:81), so EventSource is
// out — it can only GET. fetch + a reader is the only way in.

// ─── replayFixture(frames, onFrame, { delay }) ───
// delay 0 = already-streamed, rendered in one pass. delay > 0 replays it in time,
// which is what proves the context rail fills before the first word of prose.
export async function replayFixture(frames, onFrame, { delay = 0, signal } = {}) {
  for (const frame of frames) {
    if (signal?.aborted) return "aborted";
    if (delay > 0) await sleep(pace(frame, delay), signal);
    onFrame(frame);
  }
  return frames.some(f => f.event === "done") ? "closed" : "dropped";
}

// Frames don't arrive evenly. Tool ends wait on the tool; text deltas trickle.
function pace(frame, delay) {
  if (frame.event === "text")     return delay * 0.15;
  if (frame.event === "tool_end") return delay * (frame.data.ms > 1000 ? 2.5 : 1);
  return delay;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
});

// ─── streamTurn(message, userId, onFrame) ───
// The real one. Unreachable until the server is up, but written now so there is
// nothing to invent later.
export async function streamTurn(message, userId, onFrame, { base = "", signal } = {}) {
  const res = await fetch(`${base}/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, userId }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // A blank line terminates a frame. Anything after the last \n\n is a partial.
    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const frame = parseFrame(chunk);
      if (!frame) continue;
      if (frame.event === "done") sawDone = true;
      onFrame(frame);
    }
  }
  // No `done` means a dropped connection, not a slow turn.
  return sawDone ? "closed" : "dropped";
}

function parseFrame(chunk) {
  let event = "message";
  const dataLines = [];
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    console.warn("unparseable data line, skipped");
    return null;
  }
}
