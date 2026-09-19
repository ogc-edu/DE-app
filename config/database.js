const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");

// SDK v3 uses the default credential chain: env vars
// (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) in dev, EC2 IAM role in
// production. No explicit credentials are passed here (same convention as
// config/s3.js and config/sqs.js).
const client = new DynamoDBClient({
  region: process.env.AWS_REGION || "ap-southeast-1",
  // Only override the endpoint when explicitly configured (DynamoDB Local in
  // dev/tests). Leaving it unset makes the SDK resolve the real regional
  // endpoint in AWS.
  ...(process.env.DYNAMODB_ENDPOINT
    ? { endpoint: process.env.DYNAMODB_ENDPOINT }
    : {}),
});

// DocumentClient wrapper: handles JS <-> DynamoDB attribute marshalling.
const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

// Table names are resolved at require time so callers can destructure them.
const TABLES = {
  users: process.env.USERS_TABLE,
  simulations: process.env.SIMULATIONS_TABLE,
  results: process.env.RESULTS_TABLE,
  uniqueness: process.env.UNIQUENESS_TABLE,
};

// DynamoDB has no connection to open/close (it is a stateless HTTP API).
// These remain as no-op async shims so existing importers (server.js,
// tests/setup.js) keep working until they are rewritten.
const connectDB = async () => {};
const closeDB = async () => {};

module.exports = {
  client,
  ddb,
  TABLES,
  connectDB,
  closeDB,
};
