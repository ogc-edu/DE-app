#!/usr/bin/env node
/*
 * Idempotently creates the four DynamoDB tables used by the backend.
 *
 * Local dev / tests : DYNAMODB_ENDPOINT=http://localhost:8000 (DynamoDB Local)
 * Production        : DYNAMODB_ENDPOINT empty/unset -> real regional endpoint + IAM role
 *
 * Usage:
 *   npm run db:create        # dev/prod tables (honours *_TABLE env overrides)
 *   npm run db:create:test   # de-*-test tables; DynamoDB Local ONLY (refuses AWS)
 *
 * The table definitions + create logic are exported as `ensureTables()` so the
 * test setup can create the same tables programmatically against the `-test`
 * suffix.
 *
 * Capacity policy: PROVISIONED billing, STANDARD table class, base tables
 * 5 RCU / 5 WCU and every GSI 1 RCU / 1 WCU. The always-free DynamoDB tier is
 * an AGGREGATE of 25 RCU + 25 WCU per region that every GSI's own throughput
 * counts toward, so 5/5 on GSIs as well would be 35/35 and billable
 * (on-demand billing is NOT free-tier eligible at all).
 */
require("dotenv").config();

const {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
} = require("@aws-sdk/client-dynamodb");

const DEFAULT_ENDPOINT = "http://localhost:8000";
const DEFAULT_REGION = "ap-southeast-1";
const TEST_SUFFIX = "-test";

const BASE_CAPACITY = { ReadCapacityUnits: 5, WriteCapacityUnits: 5 };
const GSI_CAPACITY = { ReadCapacityUnits: 1, WriteCapacityUnits: 1 };
const BILLING_MODE = "PROVISIONED";
const TABLE_CLASS = "STANDARD";
// Always-free DynamoDB aggregate for the region (RCU + WCU), tables + GSIs.
const FREE_TIER_LIMIT = { RCU: 25, WCU: 25 };

// Base table names. `resolveTables("")` lets *_TABLE env vars override these
// (backend, worker and the script must agree); the test suffix always derives
// from the base names so the suites never touch the dev tables.
const BASE_TABLES = {
  users: "de-users",
  simulations: "de-simulations",
  results: "de-simulation-results",
  uniqueness: "de-uniqueness",
};

const resolveTables = (suffix = "", env = process.env) => {
  if (suffix) {
    return {
      users: `${BASE_TABLES.users}${suffix}`,
      simulations: `${BASE_TABLES.simulations}${suffix}`,
      results: `${BASE_TABLES.results}${suffix}`,
      uniqueness: `${BASE_TABLES.uniqueness}${suffix}`,
    };
  }
  return {
    users: env.USERS_TABLE || BASE_TABLES.users,
    simulations: env.SIMULATIONS_TABLE || BASE_TABLES.simulations,
    results: env.RESULTS_TABLE || BASE_TABLES.results,
    uniqueness: env.UNIQUENESS_TABLE || BASE_TABLES.uniqueness,
  };
};

const gsi = (IndexName, KeySchema) => ({
  IndexName,
  KeySchema,
  Projection: { ProjectionType: "ALL" },
  ProvisionedThroughput: { ...GSI_CAPACITY },
});

const buildTableDefinitions = (tables) => [
  {
    TableName: tables.users,
    ProvisionedThroughput: { ...BASE_CAPACITY },
    KeySchema: [{ AttributeName: "userId", KeyType: "HASH" }],
    AttributeDefinitions: [
      { AttributeName: "userId", AttributeType: "S" },
      { AttributeName: "email", AttributeType: "S" },
    ],
    GlobalSecondaryIndexes: [
      gsi("email-index", [{ AttributeName: "email", KeyType: "HASH" }]),
    ],
  },
  {
    TableName: tables.simulations,
    ProvisionedThroughput: { ...BASE_CAPACITY },
    KeySchema: [{ AttributeName: "simulationId", KeyType: "HASH" }],
    AttributeDefinitions: [
      { AttributeName: "simulationId", AttributeType: "S" },
      { AttributeName: "userId", AttributeType: "S" },
      { AttributeName: "createdAt", AttributeType: "S" },
      { AttributeName: "status", AttributeType: "S" },
    ],
    GlobalSecondaryIndexes: [
      gsi("user-createdAt-index", [
        { AttributeName: "userId", KeyType: "HASH" },
        { AttributeName: "createdAt", KeyType: "RANGE" },
      ]),
      gsi("status-createdAt-index", [
        { AttributeName: "status", KeyType: "HASH" },
        { AttributeName: "createdAt", KeyType: "RANGE" },
      ]),
    ],
  },
  {
    TableName: tables.results,
    ProvisionedThroughput: { ...BASE_CAPACITY },
    KeySchema: [
      { AttributeName: "simulationId", KeyType: "HASH" },
      { AttributeName: "modelKey", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "simulationId", AttributeType: "S" },
      { AttributeName: "modelKey", AttributeType: "S" },
    ],
  },
  {
    TableName: tables.uniqueness,
    ProvisionedThroughput: { ...BASE_CAPACITY },
    KeySchema: [{ AttributeName: "lockKey", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "lockKey", AttributeType: "S" }],
  },
];

// DynamoDB Local accepts any signature but rejects unsigned requests, and the
// default provider chain throws when it finds no credentials at all. Only fall
// back to dummy credentials for a local endpoint: in AWS the endpoint is unset,
// so the EC2 IAM role / default chain is used instead.
const isLocalEndpoint = (endpoint) =>
  /(^https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|dynamodb)(:|\/|$)/i.test(
    endpoint || ""
  );

// Empty/whitespace DYNAMODB_ENDPOINT means "no override" => real regional AWS
// endpoint (matching config/database.js). A non-empty value is used verbatim.
const normalizeEndpoint = (endpoint) =>
  typeof endpoint === "string" && endpoint.trim() ? endpoint.trim() : undefined;

// Sum the provisioned RCU/WCU of every base table AND every GSI, since each
// GSI has its own provisioned throughput that counts toward the free aggregate.
const sumProvisionedCapacity = (definitions) =>
  definitions.reduce(
    (totals, definition) => {
      const units = [
        definition.ProvisionedThroughput,
        ...(definition.GlobalSecondaryIndexes || []).map(
          (index) => index.ProvisionedThroughput
        ),
      ];
      for (const unit of units) {
        totals.rcu += unit.ReadCapacityUnits;
        totals.wcu += unit.WriteCapacityUnits;
      }
      return totals;
    },
    { rcu: 0, wcu: 0 }
  );

const buildClientConfig = ({ endpoint, region }) => {
  const config = { region };
  if (endpoint) config.endpoint = endpoint;
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    config.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
  } else if (isLocalEndpoint(endpoint)) {
    config.credentials = { accessKeyId: "local", secretAccessKey: "local" };
  }
  return config;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const describeTable = (client, TableName) =>
  client.send(new DescribeTableCommand({ TableName }));

// Real DynamoDB leaves a freshly created table in CREATING for a moment;
// DynamoDB Local returns ACTIVE immediately. Poll so the function exits "ready".
const waitUntilActive = async (client, TableName, attempts = 30) => {
  for (let i = 0; i < attempts; i += 1) {
    const { Table } = await describeTable(client, TableName);
    if (Table.TableStatus === "ACTIVE") return Table;
    await sleep(1000);
  }
  const { Table } = await describeTable(client, TableName);
  return Table;
};

const createTable = async (client, definition) => {
  try {
    await client.send(
      new CreateTableCommand({
        ...definition,
        BillingMode: BILLING_MODE,
        ProvisionedThroughput: definition.ProvisionedThroughput || {
          ...BASE_CAPACITY,
        },
        TableClass: TABLE_CLASS,
      })
    );
    return "created";
  } catch (error) {
    // Idempotency: the table (and its GSIs) already exist.
    if (error.name === "ResourceInUseException") return "exists";
    throw error;
  }
};

/*
 * Ensure the four tables exist on `endpoint`, creating missing ones and waiting
 * for ACTIVE. Reusable from the CLI, tests and any bootstrap script.
 *
 * @param {object}   [options]
 * @param {string}   [options.endpoint] DynamoDB endpoint (default DYNAMODB_ENDPOINT;
 *                                      empty/unset => real AWS regional endpoint)
 * @param {string}   [options.region]   AWS region (default ap-southeast-1)
 * @param {string}   [options.suffix]   Table-name suffix, e.g. "-test"
 * @param {object}   [options.tables]   Explicit {users,simulations,results,uniqueness}
 * @param {object}   [options.client]   Pre-built DynamoDBClient (not destroyed)
 * @param {object}   [options.logger]   Logger with .log (default console)
 * @returns {Promise<object[]>} per-table outcome/status/GSI summary
 */
const ensureTables = async ({
  endpoint = process.env.DYNAMODB_ENDPOINT,
  region = DEFAULT_REGION,
  suffix = "",
  tables,
  client,
  logger = console,
} = {}) => {
  const resolvedEndpoint = normalizeEndpoint(endpoint);
  const resolvedTables = tables || resolveTables(suffix);
  const definitions = buildTableDefinitions(resolvedTables);

  // `-test` tables are for DynamoDB Local only. Never create them in real AWS:
  // they would double the provisioned aggregate and break the free tier.
  if (suffix && !isLocalEndpoint(resolvedEndpoint)) {
    throw new Error(
      `Refusing to create "${suffix}" tables against non-local endpoint ` +
        `"${resolvedEndpoint || "(real AWS)"}". Test tables are DynamoDB Local only.`
    );
  }

  const totals = sumProvisionedCapacity(definitions);
  logger.log(
    `Provisioned capacity: ${totals.rcu} RCU / ${totals.wcu} WCU across ` +
      `${definitions.length} tables + GSIs ` +
      `(free-tier aggregate limit ${FREE_TIER_LIMIT.RCU}/${FREE_TIER_LIMIT.WCU})`
  );
  if (totals.rcu > FREE_TIER_LIMIT.RCU || totals.wcu > FREE_TIER_LIMIT.WCU) {
    throw new Error(
      `Provisioned capacity ${totals.rcu} RCU / ${totals.wcu} WCU exceeds the ` +
        `free-tier aggregate of ${FREE_TIER_LIMIT.RCU}/${FREE_TIER_LIMIT.WCU}.`
    );
  }

  const ownsClient = !client;
  const dynamo =
    client ||
    new DynamoDBClient(buildClientConfig({ endpoint: resolvedEndpoint, region }));

  try {
    const results = [];
    for (const definition of definitions) {
      const outcome = await createTable(dynamo, definition);
      const table = await waitUntilActive(dynamo, definition.TableName);
      const gsis = (table.GlobalSecondaryIndexes || []).map((i) => i.IndexName);
      results.push({
        table: table.TableName,
        outcome,
        status: table.TableStatus,
        billingMode:
          table.BillingModeSummary && table.BillingModeSummary.BillingMode,
        throughput: table.ProvisionedThroughput,
        gsis,
      });
      logger.log(
        `[${outcome}] ${table.TableName} (${table.TableStatus}` +
          `${gsis.length ? `, GSIs: ${gsis.join(", ")}` : ""})`
      );
    }
    return results;
  } finally {
    // Only close a client we created; a caller-supplied client stays usable.
    if (ownsClient) dynamo.destroy();
  }
};

// Where the credentials for this run come from (for the log line).
const credentialSource = (endpoint) => {
  if (process.env.AWS_ACCESS_KEY_ID) return "env credentials";
  if (isLocalEndpoint(endpoint)) return "dummy local credentials";
  return "default credential chain";
};

const main = async () => {
  const testMode = process.argv.includes("--test");
  const suffix = testMode ? TEST_SUFFIX : "";
  const endpoint = normalizeEndpoint(process.env.DYNAMODB_ENDPOINT);
  const region = process.env.AWS_REGION || DEFAULT_REGION;

  // `--test` creates `de-*-test` tables: DynamoDB Local only, never AWS.
  if (testMode && !endpoint) {
    throw new Error(
      "Refusing to run --test without DYNAMODB_ENDPOINT set: `-test` tables " +
        "are DynamoDB Local only and must never be created in real AWS."
    );
  }

  console.log(
    `Creating DynamoDB tables via endpoint=${endpoint || "(real AWS)"} ` +
      `region=${region} suffix="${suffix}" (${credentialSource(endpoint)})`
  );
  await ensureTables({ endpoint, region, suffix });
  console.log("All tables ready.");
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`Failed to create tables: ${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  ensureTables,
  buildTableDefinitions,
  resolveTables,
  sumProvisionedCapacity,
  normalizeEndpoint,
  BASE_TABLES,
  BASE_CAPACITY,
  GSI_CAPACITY,
  FREE_TIER_LIMIT,
  TEST_SUFFIX,
  DEFAULT_ENDPOINT,
  DEFAULT_REGION,
};
