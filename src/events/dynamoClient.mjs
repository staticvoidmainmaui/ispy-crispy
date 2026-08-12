// The DynamoDB client — shared, module-level singleton (same pattern as the
// Supabase client in recall.mjs / writeMemory.mjs).
//
// This is written the way it would look talking to REAL AWS DynamoDB — same SDK,
// same client, same calls. The only thing that changes for local dev is `endpoint`:
// pointing it at DynamoDB Local (the Docker container from docker-compose.yml)
// instead of leaving it unset (which makes the SDK talk to real AWS).
//
// Docs worth reading, in order:
//   - DynamoDB core concepts (tables/items/keys, no schema beyond the key):
//     https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.html
//   - AWS SDK v3 for JS, DynamoDB client:
//     https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/client-dynamodb/
//   - DocumentClient (`lib-dynamodb`) — lets you pass/receive plain JS objects
//     instead of DynamoDB's verbose { S: "..." } / { N: "..." } attribute-value format:
//     https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/lib-dynamodb/

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// TODO: move these to env vars before this touches real AWS (same rule as the
// Supabase keys — see the TODO above the Supabase client in writeMemory.mjs).
const REGION = process.env.AWS_REGION ?? "us-east-1";
const LOCAL_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";

// DynamoDB Local doesn't check credentials, but the SDK still requires *something*
// shaped like a key pair to construct the client. These are placeholders — they are
// never sent to a real AWS endpoint, only to your local container.
const rawClient = new DynamoDBClient({
  region: REGION,
  endpoint: LOCAL_ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});

// Wrap the low-level client so callers deal in plain objects ({ id: "...", title: "..." })
// instead of DynamoDB's attribute-value wire format.
export const docClient = DynamoDBDocumentClient.from(rawClient);

export const EVENTS_TABLE = process.env.EVENTS_TABLE_NAME ?? "events"; // what does ?? do- 

//mauimir: 
// The `??` operator is the nullish coalescing operator in JavaScript. 
// It returns the value on its left if that value is not null or undefined;
//  otherwise, it returns the value on its right. 
// In this case, if `process.env.EVENTS_TABLE_NAME` is defined (not null or undefined),
// it will be used as the value for `EVENTS_TABLE`. If it is not defined, the default value "events" will be used instead.  

//when is the name given : 
// The name of the DynamoDB table is determined by the environment variable `EVENTS_TABLE_NAME`.
// If this environment variable is set, its value will be used as the table name. 
// If it is not set, the default table name "events" will be used. 
// This allows for flexibility in specifying the table name based on different environments (e.g., development, testing, production) without changing the code.