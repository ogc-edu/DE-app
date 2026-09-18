// ---------------------------------------------------------------------------
// Test environment — MUST run before any application module is required.
// config/database.js, config/s3.js and config/sqs.js all read process.env at
// require time, and setupFilesAfterEnv runs before each test file is loaded.
//
// Tests use DEDICATED `-test` tables (never the dev tables): DynamoDB Local
// runs with -sharedDb, so wiping the dev tables would destroy local dev data.
// ---------------------------------------------------------------------------
process.env.AWS_REGION = "ap-southeast-1";
// CI has no ~/.aws/credentials and DynamoDB Local does not validate signatures,
// but the SDK still needs *some* credentials or it fails to load them.
process.env.AWS_ACCESS_KEY_ID = "test";
process.env.AWS_SECRET_ACCESS_KEY = "test";
process.env.DYNAMODB_ENDPOINT = "http://localhost:8000";
process.env.USERS_TABLE = "de-users-test";
process.env.SIMULATIONS_TABLE = "de-simulations-test";
process.env.RESULTS_TABLE = "de-simulation-results-test";
process.env.UNIQUENESS_TABLE = "de-uniqueness-test";
process.env.S3_BUCKET_NAME = "test-bucket";
process.env.SQS_QUEUE_URL =
  "https://sqs.ap-southeast-1.amazonaws.com/000000000000/test-queue";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret";

const { ScanCommand, BatchWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { ddb, TABLES } = require("../config/database");
const { ensureTables, TEST_SUFFIX } = require("../scripts/create-tables");

// Never hit real AWS in tests: mock the SQS SDK commands. `__sqsSendMock`
// lets individual tests assert on the sent payload or override the response.
// (Still viable after the DynamoDB migration: config/sqs.js builds the message
// from `simulation.simulationId`.)
jest.mock("@aws-sdk/client-sqs", () => {
  const __sqsSendMock = jest.fn().mockResolvedValue({});
  return {
    SQSClient: jest.fn().mockImplementation(() => ({ send: __sqsSendMock })),
    SendMessageCommand: jest
      .fn()
      .mockImplementation((input) => ({ command: "SendMessageCommand", input })),
    GetQueueAttributesCommand: jest
      .fn()
      .mockImplementation((input) => ({ command: "GetQueueAttributesCommand", input })),
    DeleteMessageCommand: jest
      .fn()
      .mockImplementation((input) => ({ command: "DeleteMessageCommand", input })),
    __sqsSendMock,
  };
});

// Key schema per test table — used to build DeleteRequests from a key-only Scan.
const TEST_TABLES = [
  { name: TABLES.users, keys: ["userId"] },
  { name: TABLES.simulations, keys: ["simulationId"] },
  { name: TABLES.results, keys: ["simulationId", "modelKey"] },
  { name: TABLES.uniqueness, keys: ["lockKey"] },
];

const BATCH_SIZE = 25; // BatchWriteItem hard cap
const MAX_RETRIES = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// BatchWriteItem deletes (25/batch) with UnprocessedItems retry.
const batchDelete = async (tableName, items, keys) => {
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    let chunk = items.slice(i, i + BATCH_SIZE).map((item) => ({
      DeleteRequest: {
        Key: Object.fromEntries(keys.map((key) => [key, item[key]])),
      },
    }));

    for (let attempt = 0; attempt < MAX_RETRIES && chunk.length; attempt += 1) {
      const { UnprocessedItems } = await ddb.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: chunk } })
      );
      const unprocessed = (UnprocessedItems && UnprocessedItems[tableName]) || [];
      if (!unprocessed.length) break;
      chunk = unprocessed;
      await sleep(25 * (attempt + 1));
    }
  }
};

// Scan the whole table (paging past 1 MB) and delete every item found.
const wipeTable = async ({ name, keys }) => {
  const projection = keys.map((key) => `#${key}`).join(", ");
  const names = Object.fromEntries(keys.map((key) => [`#${key}`, key]));
  let ExclusiveStartKey;

  do {
    const { Items, LastEvaluatedKey } = await ddb.send(
      new ScanCommand({
        TableName: name,
        ProjectionExpression: projection,
        ExpressionAttributeNames: names,
        ExclusiveStartKey,
      })
    );
    ExclusiveStartKey = LastEvaluatedKey;
    await batchDelete(name, Items || [], keys);
  } while (ExclusiveStartKey);
};

const wipeAllTables = async () => {
  for (const table of TEST_TABLES) {
    await wipeTable(table);
  }
};

let tablesReady = false;

beforeAll(async () => {
  try {
    await ensureTables({
      endpoint: process.env.DYNAMODB_ENDPOINT,
      region: process.env.AWS_REGION,
      suffix: TEST_SUFFIX,
    });
  } catch (error) {
    throw new Error(
      `[tests/setup] DynamoDB Local unreachable at ${process.env.DYNAMODB_ENDPOINT}. ` +
        "Start it (`docker compose up -d dynamodb`) and run `npm run db:create:test`. " +
        `Original error: ${error.name}: ${error.message}`
    );
  }
  // Start from a clean slate even if a previous run crashed mid-test.
  await wipeAllTables();
  tablesReady = true;
});

afterEach(async () => {
  if (!tablesReady) return;
  await wipeAllTables();
});
