// Event creation — the WRITE half of the fusion. One eventId, two writes:
// the authoritative record goes to DynamoDB (putEvent), and an episodic memory
// row goes to Postgres/pgvector (writeMemory) with the SAME id, so recall's
// Stage 2 hydration can look it back up later.

import { randomUUID } from "node:crypto";
import { putEvent } from "./eventsTable.mjs";
import { writeMemory } from "../memory/writeMemory.mjs";

export async function createEvent(title, time, location, userId) {
    const eventId = randomUUID(); // Generate a unique ID for the event
    // Store the event in DynamoDB
    await putEvent({ id: eventId, title, time, location, status: "scheduled" });
    await writeMemory(`${title} on ${time}`, { userId, memoryType: "episodic", id: eventId });
    console.log(`Event created with ID: ${eventId}`);
    return eventId;
}


//would call the function and write memory when user creates event
//outputs a UUID that can be used to match the memory and event records in their respective tables.