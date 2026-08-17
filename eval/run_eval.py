# run_eval.py — a hand-rolled eval harness for the Go Gators planner.
#
# No framework. Four parts, kept separate on purpose:
#   load_cases()  -> data in           (reads cases.json)
#   run_case()    -> the "curl"        (POST to your running /chat server)
#   score()       -> YOUR judgment     (did the reply match expected?)
#   report()      -> the table         (prints the scorecard)
#
# The loop at the bottom chains them: input -> RUN -> SCORE -> COLLECT, then REPORT.
#
# HOW TO RUN (two terminals):
#   Terminal 1:  docker up -> seed -> node --env-file=.env src/server.mjs
#   Terminal 2:  python eval/run_eval.py
#
# Requires the `requests` library:  pip install requests
# Docs: https://requests.readthedocs.io/en/latest/user/quickstart/

import json
import re         # toolchain cases assert a reply does NOT match a pattern
import argparse   # parse --stage so you can score one pipeline stage at a time
import uuid       # unique per-case userId, so cases can't pollute each other's recall
from datetime import datetime, timedelta, timezone   # backdate seeded memories for recency tests
import requests   # our "curl in a loop"

# ─── Config ──────────────────────────────────────────────────────────────────
# The server contract you already built (src/server.mjs):
#   POST /chat   body: {"message": "...", "userId": "..."}   -> {"reply": "..."}
BASE_URL = "http://localhost:3000" # matches PORT in src/config.mjs
CHAT_ROUTE = "/chat"
CASES_PATH = "eval/cases.json"
DEV_USER = "00000000-0000-0000-0000-000000000001"  # matches DEV_USER in src/config.mjs


# ─── PART 1: load the case bank ──────────────────────────────────────────────
def load_cases(path):
    """Read cases.json into a list of dicts. Pure data in, no logic."""
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ─── PART 2: run one case against the live server (the "curl") ───────────────
def run_case(message, user=DEV_USER, debug=False, created_at=None, force_fail=None):
    """
    Send one planner message to the running server and return its parsed reply.

    This is the only place the harness touches your system. Everything on the
    other side of this HTTP call is your Node server (today) or your Python
    server (after the port) — the harness never knows which.

    user  — which userId to send as. Retrieval cases pass a fresh per-case id so
            one case's seeded memories can't leak into another's recall.
    debug — when True, append ?debug=1 so the server also returns the recalled
            `hits` set (the trace side-channel we added to server.mjs).

    Returns the parsed JSON: {"reply": ...} normally, {"reply": ..., "hits": [...]} when debug.
    """
    body = {"message": message, "userId": user}
    if created_at is not None:
        body["created_at"] = created_at   # eval-only: backdate this write (recency tests)
    # force_fail — deterministic tool failure for the degradation case (debug=1 only).
    headers = {"X-Tools-Force-Fail": force_fail} if force_fail else None
    resp = requests.post(
        BASE_URL + CHAT_ROUTE + ("?debug=1" if debug else ""),
        json=body,
        headers=headers,
        timeout=30,
    )
    resp.raise_for_status()   # a 500 from the server should fail loudly, not silently pass
    return resp.json()


# ─── PART 3: score one reply against what we expected ────────────────────────


#HELPERS FOR SCORING
def extract_eval(case, actual):
    """Evaluate extraction stage cases."""
    expected = case["expected"]
    reply = actual["reply"]
    booked = reply.startswith("Booked") 
    
    #if booked then is true , there should be no time and no write,
    #if there is returned time or write then it is a fail
    if expected.get("should_write") is not None and expected["should_write"] != booked:
        return False
    
    #eventually have time extraction logic to verify how clean time is 
    #chrono extraction logic to check if time is present in actual_reply
    #check various part of the reply for time patterns (e.g., "tomorrow at 9am", "next Friday", etc.)
    
    if expected.get("time_not_null") is not None and expected["time_not_null"] != booked:
        return False
    
    #title /location are visible on the booked path
    if expected.get("title") and expected["title"].lower() not in reply.lower():
        return False
    
    #PARKED LOCATION FOR SOFT TOLERANCE
    
    #if expected.get("location") and expected["location"].lower() not in reply.lower():
    #    return False
    
    return True
    
    # # Check if the title matches (case-insensitive)
    # if expected.get("title") is not None:
    #     title_matches = expected["title"].lower() in actual_reply.lower()
    
    # # time evaluation
    # if expected.get("time_not_null") is not None:
    #     #chrono extraction logic to check if time is present in actual_reply
    #     #check various part of the reply for time patterns (e.g., "tomorrow at 9am", "next Friday", etc.)
    #     time_present = "time" in actual_reply.lower()  # Placeholder logic; replace with
    
    # #location evaluation
    # if expected.get("location") is not None:
    #     location_matches = expected["location"].lower() in actual_reply.lower()
        
    # if expected.get("should_write") is not None:
    #         should_write_matches = True
    #         didwrite = False
    #     if actual_reply.contains("Booked") or actual_reply.contains("Got it") or actual_reply.contains("Already noted"):
    #         didwrite = True
    #     should_write = expected.get("should_write")
    #     if should_write != didwrite:
    #         shouldwrite_matches = False
    
    # if title_matches and time_present and location_matches and should_write_matches:
    #     return True
    # else:
    #     return False
    
    




_SAVE_ACKS = (
    "Got it — I'll remember that.",     # writeMemory inserted
    "Already noted — I had that one.",  # duplicate, no-op
)

def detect_branch(reply):
 
    if reply.startswith("Booked"):
        return "add_event"
    if reply.startswith("What's the event?") or reply.startswith("When should I schedule"):
        return "add_event"                # routed to add_event; just missing a field
    if reply in _SAVE_ACKS:
        return "save_preference"
    return "question"

def retrieval_eval(case, actual):
    """
    Direct retrieval scoring (Option B). actual["hits"] is the recalled memory set
    exposed by ?debug=1. We assert on the CONTENT of what was recalled, not on the
    LLM's prose — 'did the right memory get retrieved / stay excluded?'

    must_include — every substring must appear in SOME recalled hit's text.
    must_exclude — no substring may appear in ANY recalled hit's text (the absence
                   test: e.g. the sister's-preference must never enter recall).
    A hit's text lives in `content` (preferences) or `title` (hydrated events).
    """
    exp = case["expected"]
    hits = actual.get("hits") or []
    texts = [(h.get("content") or h.get("title") or "").lower() for h in hits]

    for needle in (s.lower() for s in exp.get("must_include", [])):
        if not any(needle in t for t in texts):
            return False
    for needle in (s.lower() for s in exp.get("must_exclude", [])):
        if any(needle in t for t in texts):
            return False
    return True



def ranking_eval(case, actual):
    """
    Ordering scoring for Stage 4. `hits` comes back already ranked by the composite
    score (0.7*relevance + 0.3*recency + 0.1*importance) the RPC computes. We assert
    a RELATIVE order — the 'ranks_higher' memory must appear before 'than' in the
    ranked list. Both must be recalled, or there's no order to compare.
    """
    exp = case["expected"]
    hits = actual.get("hits") or []
    texts = [(h.get("content") or h.get("title") or "").lower() for h in hits]

    def rank_of(needle):
        needle = needle.lower()
        for i, t in enumerate(texts):
            if needle in t:
                return i
        return None                        # not recalled at all

    higher = rank_of(exp["ranks_higher"])
    lower = rank_of(exp["than"])
    if higher is None or lower is None:    # can't compare an order if one is missing
        return False
    return higher < lower                  # smaller index = nearer the top


def toolchain_eval(case, actual):
    """
    Tool-chain scoring. actual["tools"] = [{name, input, ok, ms, error?}] from ?debug=1.
    Asserts WHICH tools ran and WHAT ARGUMENTS they got — the argument is the proof the
    memory was load-bearing.

    tools_called        — these ran, in this relative order (subset, not exact)
    tools_absent        — these must NOT have run
    tool_input_contains — {tool: {field: substring}}
    tool_ok             — {tool: bool}
    reply_must_not_match— regex that must NOT match the reply
    reply_contains_any  — at least one substring appears in the reply
    """
    exp = case["expected"]
    tools = actual.get("tools") or []
    names = [t.get("name") for t in tools]
    reply = (actual.get("reply") or "").lower()

    # ordered subset: each expected name appears after the previous one
    pos = -1
    for want in exp.get("tools_called", []):
        try:
            pos = names.index(want, pos + 1)
        except ValueError:
            return False

    for banned in exp.get("tools_absent", []):
        if banned in names:
            return False

    for tool, fields in exp.get("tool_input_contains", {}).items():
        call = next((t for t in tools if t.get("name") == tool), None)
        if call is None:
            return False
        for field, needle in fields.items():
            got = str((call.get("input") or {}).get(field, "")).lower()
            if needle.lower() not in got:
                return False

    for tool, want_ok in exp.get("tool_ok", {}).items():
        call = next((t for t in tools if t.get("name") == tool), None)
        if call is None or bool(call.get("ok")) != want_ok:
            return False

    pattern = exp.get("reply_must_not_match")
    if pattern and re.search(pattern, actual.get("reply") or ""):
        return False

    any_of = exp.get("reply_contains_any")
    if any_of and not any(s.lower() in reply for s in any_of):
        return False

    return True


def score(case, actual):
    """Return True if `actual` satisfies case["expected"]. Fill this in."""
    if case["stage"] == "intent":
        return detect_branch(actual["reply"]) == case["expected"]["intent"]
    
#   TODO take care of tier 2 resolvation for uncertains 
    
    if case["stage"] == "extract":
        return extract_eval(case, actual)
    
    if case["stage"] == "retrieval":
        return retrieval_eval(case, actual)
    
    if case["stage"] == "ranking":
        return ranking_eval(case, actual)

    if case["stage"] == "toolchain":
        return toolchain_eval(case, actual)

    raise NotImplementedError("score() not written yet — see TODOs above")


# ─── PART 4: turn results into a table ───────────────────────────────────────
def report(results):
    """Print a scorecard. The reporter decides NOTHING about pass/fail — it only
    displays what score() already decided."""
    for r in results:
        mark = "PASS" if r["ok"] else "FAIL"
        # ljust pads to a fixed width so columns line up. `tabulate` (pip) does
        # this for you later if you want prettier output.
        print(f'{mark:4}  {r["id"]:14}  {r["input"][:40]}')
    passed = sum(1 for r in results if r["ok"])
    print(f"\n{passed}/{len(results)} passed")


# ─── MAIN LOOP ───────────────────────────────────────────
def main():
    # (argparse docs: https://docs.python.org/3/library/argparse.html)
    # --stage scores ONE pipeline stage at a time, e.g. `--stage intent`.
    # Omit it to run every case. argparse gives us --help and bad-flag errors free.
    parser = argparse.ArgumentParser(description="Go Gators planner eval harness.")
    parser.add_argument("--stage", help="only run cases whose stage matches (e.g. intent, extract, retrieval)")
    args = parser.parse_args()

    cases = load_cases(CASES_PATH)
    if args.stage:
        cases = [c for c in cases if c["stage"] == args.stage]
        if not cases:   # a typo'd stage should say so, not silently print "0/0 passed"
            print(f'No cases with stage {args.stage!r} in {CASES_PATH}')
            return

    results = []
    for case in cases:
        # Per-case userId: a fresh namespace so one case's seeded memories can't
        # leak into another's recall. Isolation by user — no teardown needed.
        # MUST be a real UUID: memories.user_id is a uuid column and match_memories
        # takes p_user_id uuid. A non-UUID string makes Postgres reject every write
        # AND every recall — silently, since writeMemory/recall swallow the error.
        user = str(uuid.uuid4())

        # SEED through the system's own write path. A seed is a plain string, OR an
        # object {"text": ..., "age_days": N} to BACKDATE the write — the only way to
        # test recency, since a normal write is always stamped "now".
        for seed in case.get("seed", []):
            if isinstance(seed, str):  #check if seed is a string or an object 
                run_case(seed, user)
            else:
                created_at = (datetime.now(timezone.utc) - timedelta(days=seed["age_days"])).isoformat()
                run_case(seed["text"], user, created_at=created_at)

        # retrieval/ranking need `hits`, toolchain needs `tools` — ask with debug on.
        actual = run_case(
            case["input"], user,
            debug=(case["stage"] in ("retrieval", "ranking", "toolchain")),
            force_fail=case.get("force_fail"),
        )  # RUN
        ok = score(case, actual)                                # SCORE
        results.append({**case, "actual": actual, "ok": ok})    # COLLECT
    report(results)                                             # REPORT


if __name__ == "__main__":
    main()
