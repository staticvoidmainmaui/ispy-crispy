# Pre-eval journal

Gathering example cases from every stage we built, before turning them into a real eval
bank. Each stage: the input, and what SHOULD come out. Order follows the request pipeline:
classify intent → (extract fields | write preference) → recall → rank → answer.

Our current system prompt:

const system =
    "You label a single planner message with exactly one intent. Definitions:\n" +
    "- add_event: an instruction to put something on the calendar (\"book the dentist Friday\", " +
    "\"move my 3pm to 4\"). A command that changes calendar data.\n" +
    "- save_preference: the user states a durable fact ABOUT THEMSELF in the first person " +
    "(\"I hate Monday meetings\", \"I'm a morning person\"). A third-person statement " +
    "(\"my sister loves mornings\") is NOT save_preference — it's a question/other.\n" +
    "- question: anything else — asking about the schedule, chit-chat, or a statement that " +
    "isn't a first-person standing preference.\n" +
    "When unsure between save_preference/add_event and question, choose question.";



---

# Stage 1a — Intent, Tier-1 (regex)
Cheap regex.  
Question biased, so we have our question_match first in a if statement first, then write_match keywords are tested for .
The reason is that a wrong question answers chattily , but a wrong write can corrupt 2 datastores. 
Returns UNCERTAIN when no signal fires (→ Tier-2).  - defaulting to our claude cheap intent classifier

//handlemessage.js
Question-> Event Add -> Save Preference // they cannot fire at the same time.

1. 4 TESTS
add_event (leading imperative verb):

- "book dentist Friday 3pm"                                         :   (add_event)

- "schedule study session tomorrow at 9am at the library"           :   (add_event)

- "please add gym session tonight"                                  :   (add_event)   (tolerates leading "please")

- "remind me I like mornings"      
(add_event)  (imperative WINS over the preference words)

2. 4 TESTS
save_preference (first-person + habit verb, BOTH required):

- "I hate Monday meetings"         
(save_preference)

- "I prefer studying at night"     
(save_preference)

- "I always study late"            
(save_preference)

- "I can't stand early standups"   
(save_preference)

3. 3 TESTS
question (question marker, or "?" at end, or default):


- "what's on my schedule Friday?"                                   :   question   ("?" and leading "what" both fire)

- "when is my dentist appointment"                                  :   question
- "my favorite is late-night coding"                                :   question   (no habit verb from the list, falls through)

4. 2 TESTS
UNCERTAIN (no signal, escalate to Tier-2):

- "my sister loves mornings"                                        :   UNCERTAIN  (has "my" + "loves" but... see Tier-2)

- "dentist Friday 3pm"                                              :   UNCERTAIN  (a booking with NO leading verb)

---------------------------------------------------------------------------------------------------------------

# Stage 1b — Intent, Tier-2 (Claude, claude-haiku-4-5, structured output)
Only runs on UNCERTAIN. Fixes what regex structurally can't. Fails safe to "question". 


- "my sister loves mornings"      

:   question      (THIRD-person — not the USER's preference)


- "dentist Friday 3pm"   

:   add_event     (a booking even without an imperative verb)

- "coffee with mom next Tuesday"   

:   add_event  (no verb, clear event)

- (network/rate-limit/off-schema failure) 

:  question        (never guess a write on failure)

---

# Stage 2 — Event field extraction (chrono-node)

Message → { title, time (ISO string), location }. Title = strip verb + date + location.
Location matched AFTER the date is removed, so "at 3pm" (a time) can't become a place.

5 TESTS 

- "book dentist Friday 3pm"                                     :       { dentist, <Fri 3pm ISO>, null }
- "schedule study session tomorrow at 9am at the library"       :       { study session, <tmrw 9am>, "the library" }
- "remind me to call mom next Monday"                           :       { call mom, <Mon>, null }
- "add groceries"                                               :       { groceries, null, null }  → planner ASKS for a time, does NOT write a null-time row
- (title comes back empty)                                      : planner ASKS what the event is, does NOT write

---

---------------------------------------------------------------------------------------------------------------------------------------------------------

# Stage 3 — Segmented / faceted retrieval

Two typed recalls per question — episodic (query-driven, noise-gated) + semantic (ambient,
always injected). The whole point: a preference shapes the answer even when it isn't
similar to the question.

1. Context:
"I hate mornings"  stored as a preference/memory, should prepare to structure the day.

"What should I do on Friday?" 

:  semantic facet injects the preference even though it's not
   similar to "Friday"; episodic facet pulls Friday's actual events.
   EXPECTED: the plan avoids morning slots.

2. Context:
"My sister loves mornings" 

:  must NOT be stored as the user's preference (Tier-2 catches it
   as third-person). If it never becomes a semantic memory, it never pollutes recall.

3. Context:
"I prefer studying at night" saved last week, then:

"when should I study tomorrow?" 

:  the night preference should surface even though "study"
   events might rank higher by pure similarity.

---

# Stage 4 — Composite ranking (recency inside the facet)

Score = 0.7·relevance + 0.3·recency + 0.1·importance. Recency is the tie-breaker that a
pure-distance search can't do.

1. 

- "I prefer mornings" (3 weeks old) 
vs 
  "I prefer afternoons now" (yesterday), 

query:

  "when should I study?"

:  near-identical vectors; the FRESH one should rank higher.

- (edge) a semantically-perfect but stale event vs a slightly-less-relevant recent one:
  eyeball where tau (1 week) lands the crossover.

---

# Notes for building the real eval
- Each bullet above is a case: (input, expected label/output). Tier-1 and Tier-2 are pure
  functions → cheap to assert in a loop (already did 11/11 on the Tier-1 table).
- Stages 3–4 need the stack live (Supabase db/04 + seeded DynamoDB) — those are
  integration cases, run after the unit ones pass.
