const crypto = require("node:crypto");
const {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  BatchWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { ddb, TABLES } = require("../config/database");
const { ForbiddenError, NotFoundError, ConflictError, BadRequestError } = require("../utils/errors");

const USER_CREATED_INDEX = "user-createdAt-index";
const RESULT_BATCH_SIZE = 25;
// `limit = 0` means "return everything" (legacy Mongo behavior). DynamoDB has no
// unbounded query, so we page internally and stop at this cap to protect memory.
const ALL_PAGE_SIZE = 100;
const MAX_ALL_RESULTS = 1000;

// --- shared helpers ---------------------------------------------------------

const computeTotalModels = (functions = [], methods = {}) =>
  (functions ? functions.length : 0) *
  (methods && methods.mutation ? methods.mutation.length : 0) *
  (methods && methods.crossover ? methods.crossover.length : 0) *
  (methods && methods.selection ? methods.selection.length : 0);

// Zero-padded so the results sort key orders numerically, e.g.
// "01#02#01#10" < "01#02#02#01".
const modelKey = (row) =>
  [row.mutationId, row.crossoverId, row.selectionId, row.functionId]
    .map((id) => String(id).padStart(2, "0"))
    .join("#");

const minFitness = (rows = []) => {
  const values = rows
    .map((row) => row.lowestFitness)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
};

// LastEvaluatedKey is opaque to the client -> base64(JSON).
const encodeCursor = (lastEvaluatedKey) =>
  lastEvaluatedKey
    ? Buffer.from(JSON.stringify(lastEvaluatedKey)).toString("base64")
    : null;

const decodeCursor = (cursor) => {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
  } catch (err) {
    throw new BadRequestError("Invalid cursor");
  }
};

// Emit `_id` (the old Mongo document field) alongside every field the API
// already returns, so the frontend (`sim._id ?? sim.id`) keeps working.
const serializeSimulation = (item) =>
  item ? { ...item, _id: item.simulationId } : null;

const toResultItem = (simulationId, row) => ({
  simulationId,
  modelKey: modelKey(row),
  functionId: row.functionId,
  mutationId: row.mutationId,
  crossoverId: row.crossoverId,
  selectionId: row.selectionId,
  lowestFitness: row.lowestFitness,
});

// BatchWriteItem is capped at 25 requests; chunk + retry UnprocessedItems.
const batchWrite = async (requests) => {
  for (let i = 0; i < requests.length; i += RESULT_BATCH_SIZE) {
    let chunk = requests.slice(i, i + RESULT_BATCH_SIZE);
    for (let attempt = 0; attempt < 5 && chunk.length; attempt += 1) {
      const { UnprocessedItems } = await ddb.send(
        new BatchWriteCommand({ RequestItems: { [TABLES.results]: chunk } })
      );
      const unprocessed =
        UnprocessedItems && UnprocessedItems[TABLES.results]
          ? UnprocessedItems[TABLES.results]
          : [];
      if (!unprocessed.length) break;
      chunk = unprocessed;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
};

const putResults = async (simulationId, rows = []) =>
  batchWrite(
    rows.map((row) => ({ PutRequest: { Item: toResultItem(simulationId, row) } }))
  );

// Query every result key for a simulation (paginated) then batch-delete them.
const deleteResults = async (simulationId) => {
  const keys = [];
  let lastEvaluatedKey;
  do {
    const { Items, LastEvaluatedKey } = await ddb.send(
      new QueryCommand({
        TableName: TABLES.results,
        KeyConditionExpression: "simulationId = :simulationId",
        ExpressionAttributeValues: { ":simulationId": simulationId },
        ProjectionExpression: "simulationId, modelKey",
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );
    (Items || []).forEach((item) =>
      keys.push({ simulationId: item.simulationId, modelKey: item.modelKey })
    );
    lastEvaluatedKey = LastEvaluatedKey;
  } while (lastEvaluatedKey);

  await batchWrite(keys.map((Key) => ({ DeleteRequest: { Key } })));
};

// --- repository functions ---------------------------------------------------

const createSimulation = async (userId, functions, methods, params = {}) => {
  const totalModels = computeTotalModels(functions, methods);
  const { np = 15, f = 0.5, cr = 0.9, gen = 1000, dim = 30 } = params;
  const now = new Date().toISOString();
  const simulationId = crypto.randomUUID();

  const item = {
    simulationId,
    userId,
    functions,
    methods,
    np,
    f,
    cr,
    gen,
    dim,
    totalModels,
    completedModels: 0,
    progress: 0,
    bestFitness: null,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(new PutCommand({ TableName: TABLES.simulations, Item: item }));
  return item;
};

// Persist user-imported results as an already-completed simulation. Imported
// data is final, so no SQS job is enqueued (workers skip "completed" anyway).
const importSimulation = async (
  userId,
  { functions, methods, simulationData, np = 15, f = 0.5, cr = 0.9, gen = 1000, dim = 30 }
) => {
  const rows = simulationData || [];
  const totalModels = rows.length;
  const now = new Date().toISOString();
  const simulationId = crypto.randomUUID();

  const item = {
    simulationId,
    userId,
    functions,
    methods,
    np,
    f,
    cr,
    gen,
    dim,
    totalModels,
    completedModels: totalModels,
    progress: 100,
    bestFitness: minFitness(rows),
    status: "completed",
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(new PutCommand({ TableName: TABLES.simulations, Item: item }));
  await putResults(simulationId, rows);
  return item;
};

// List a user's simulations newest-first via the user-createdAt-index GSI.
// `limit = 0` pages through everything (capped) to preserve the legacy
// "limit 0 = all" contract; `limit > 0` returns a single cursor page.
const getSimulation = async (userId, options = {}) => {
  const { limit = 0, cursor, status } = options;
  const baseParams = {
    TableName: TABLES.simulations,
    IndexName: USER_CREATED_INDEX,
    KeyConditionExpression: "userId = :userId",
    ExpressionAttributeValues: { ":userId": userId },
    ScanIndexForward: false,
  };
  if (status) {
    // STATUS is a DynamoDB reserved word.
    baseParams.FilterExpression = "#s = :status";
    baseParams.ExpressionAttributeNames = { "#s": "status" };
    baseParams.ExpressionAttributeValues[":status"] = status;
  }

  const items = [];

  if (limit > 0) {
    const { Items, LastEvaluatedKey } = await ddb.send(
      new QueryCommand({
        ...baseParams,
        Limit: limit,
        ExclusiveStartKey: decodeCursor(cursor),
      })
    );
    items.push(...(Items || []));
    return {
      simulations: items.map(serializeSimulation),
      simulationCount: items.length,
      nextCursor: encodeCursor(LastEvaluatedKey),
    };
  }

  let lastEvaluatedKey = decodeCursor(cursor);
  do {
    const remaining = MAX_ALL_RESULTS - items.length;
    const { Items, LastEvaluatedKey } = await ddb.send(
      new QueryCommand({
        ...baseParams,
        Limit: Math.min(remaining, ALL_PAGE_SIZE),
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );
    items.push(...(Items || []));
    lastEvaluatedKey = LastEvaluatedKey;
  } while (lastEvaluatedKey && items.length < MAX_ALL_RESULTS);

  return {
    simulations: items.map(serializeSimulation),
    simulationCount: items.length,
    nextCursor:
      items.length >= MAX_ALL_RESULTS && lastEvaluatedKey
        ? encodeCursor(lastEvaluatedKey)
        : null,
  };
};

const getSimulationById = async (id) => {
  if (!id) return null;
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: TABLES.simulations,
      Key: { simulationId: id },
    })
  );
  return Item || null;
};

// Assemble the API's simulationData array from the separate result items.
const getResults = async (id) => {
  const rows = [];
  let lastEvaluatedKey;
  do {
    const { Items, LastEvaluatedKey } = await ddb.send(
      new QueryCommand({
        TableName: TABLES.results,
        KeyConditionExpression: "simulationId = :simulationId",
        ExpressionAttributeValues: { ":simulationId": id },
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );
    (Items || []).forEach((item) =>
      rows.push({
        functionId: item.functionId,
        mutationId: item.mutationId,
        crossoverId: item.crossoverId,
        selectionId: item.selectionId,
        lowestFitness: item.lowestFitness,
      })
    );
    lastEvaluatedKey = LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return rows;
};

const deleteSimulation = async (userId, id) => {
  const simulation = await getSimulationById(id);
  if (!simulation) {
    throw new NotFoundError("Simulation not found");
  }
  if (simulation.userId !== userId) {
    throw new ForbiddenError("Unauthorized");
  }
  await deleteResults(id);
  await ddb.send(
    new DeleteCommand({
      TableName: TABLES.simulations,
      Key: { simulationId: id },
    })
  );
  return id;
};

// Admin variant: no ownership check, but still cascades the result items.
const deleteSimulationById = async (id) => {
  await deleteResults(id);
  await ddb.send(
    new DeleteCommand({
      TableName: TABLES.simulations,
      Key: { simulationId: id },
    })
  );
  return id;
};

const cancelSimulation = async (userId, id) => {
  const simulation = await getSimulationById(id);
  if (!simulation) {
    throw new NotFoundError("Simulation not found");
  }
  if (simulation.userId !== userId) {
    throw new ForbiddenError("Unauthorized");
  }
  // Only in-flight jobs can be cancelled — terminal results must not be
  // overwritten by a late cancel (workers check status before spawning).
  if (simulation.status !== "pending" && simulation.status !== "running") {
    throw new ConflictError(
      `Cannot cancel a simulation in "${simulation.status}" status`
    );
  }

  try {
    // Atomic: a concurrent worker transition to a terminal state fails the
    // condition instead of being silently overwritten.
    await ddb.send(
      new UpdateCommand({
        TableName: TABLES.simulations,
        Key: { simulationId: id },
        UpdateExpression: "SET #s = :cancelled, updatedAt = :updatedAt",
        ConditionExpression: "#s IN (:pending, :running)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":cancelled": "cancelled",
          ":pending": "pending",
          ":running": "running",
          ":updatedAt": new Date().toISOString(),
        },
      })
    );
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") {
      throw new ConflictError(
        "Cannot cancel a simulation in its current status"
      );
    }
    throw error;
  }
  return id;
};

const setStatus = async (id, status) => {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLES.simulations,
      Key: { simulationId: id },
      UpdateExpression: "SET #s = :status, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":status": status,
        ":updatedAt": new Date().toISOString(),
      },
    })
  );
  return id;
};

const updateProgress = async (id, completedModels, progress, bestFitness) => {
  const sets = [
    "completedModels = :completedModels",
    "progress = :progress",
    "updatedAt = :updatedAt",
  ];
  const values = {
    ":completedModels": completedModels,
    ":progress": progress,
    ":updatedAt": new Date().toISOString(),
  };
  if (bestFitness !== undefined) {
    sets.push("bestFitness = :bestFitness");
    values[":bestFitness"] = bestFitness;
  }
  await ddb.send(
    new UpdateCommand({
      TableName: TABLES.simulations,
      Key: { simulationId: id },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeValues: values,
    })
  );
  return id;
};

// Worker / import completion: write all result items, then flip the parent
// item to completed with the denormalized bestFitness.
const saveResults = async (id, rows = []) => {
  await putResults(id, rows);
  const completedModels = rows.length;
  await ddb.send(
    new UpdateCommand({
      TableName: TABLES.simulations,
      Key: { simulationId: id },
      UpdateExpression:
        "SET #s = :completed, progress = :progress, completedModels = :completedModels, bestFitness = :bestFitness, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":completed": "completed",
        ":progress": 100,
        ":completedModels": completedModels,
        ":bestFitness": minFitness(rows),
        ":updatedAt": new Date().toISOString(),
      },
    })
  );
  return id;
};

// Admin overview: Scan the table (optionally filtered to one user).
const listAll = async ({ limit = 50, cursor, userId } = {}) => {
  const params = {
    TableName: TABLES.simulations,
    Limit: limit,
    ExclusiveStartKey: decodeCursor(cursor),
  };
  if (userId) {
    params.FilterExpression = "userId = :userId";
    params.ExpressionAttributeValues = { ":userId": userId };
  }
  const { Items, LastEvaluatedKey } = await ddb.send(new ScanCommand(params));
  return {
    simulations: (Items || []).map(serializeSimulation),
    nextCursor: encodeCursor(LastEvaluatedKey),
  };
};

const Simulation = {
  createSimulation,
  importSimulation,
  getSimulation,
  getSimulationById,
  getResults,
  deleteSimulation,
  deleteSimulationById,
  cancelSimulation,
  setStatus,
  updateProgress,
  saveResults,
  listAll,
  serializeSimulation,
  modelKey,
  computeTotalModels,
};

module.exports = Simulation;
