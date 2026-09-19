const {
  SQSClient,
  SendMessageCommand,
  GetQueueAttributesCommand,
} = require("@aws-sdk/client-sqs");

const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL;
// Local dev/test talks to ElasticMQ (http://localhost:9324). MUST be empty in
// AWS so the SDK resolves the real regional endpoint — same convention as
// DYNAMODB_ENDPOINT in config/database.js.
const SQS_ENDPOINT = process.env.SQS_ENDPOINT;

// SDK v3 uses the default credential chain: env vars (AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY) in dev, EC2 IAM role in production. No explicit
// credentials are passed here (same convention as config/s3.js).
const sqsClient = new SQSClient({
  region: AWS_REGION,
  ...(SQS_ENDPOINT ? { endpoint: SQS_ENDPOINT } : {}),
});

// Build the exact worker contract the EC2 spawner (DE-forEC2/spawner.js)
// expects. `de.exe` parses the array fields as comma-separated values, so we
// send them as comma-joined strings (spawner.js also handles plain arrays).
const buildSimulationJob = (simulation) => ({
  simulationId: String(simulation.simulationId ?? simulation._id),
  bf: simulation.functions.join(","),
  mutation: simulation.methods.mutation.join(","),
  crossover: simulation.methods.crossover.join(","),
  selection: simulation.methods.selection.join(","),
  cr: simulation.cr,
  f: simulation.f,
  np: simulation.np,
  gen: simulation.gen,
  dim: simulation.dim,
});

// Enqueue one job per created simulation. Throws on SQS failure so the
// controller can mark the simulation as failed and surface a warning.
const sendSimulationJob = async (simulation) => {
  if (!SQS_QUEUE_URL) {
    throw new Error("SQS_QUEUE_URL is not configured");
  }
  const body = buildSimulationJob(simulation);
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: SQS_QUEUE_URL,
      MessageBody: JSON.stringify(body),
    })
  );
  return body;
};

// Real queue metrics for GET /admin/queue (values come back as strings).
const getQueueStatus = async () => {
  if (!SQS_QUEUE_URL) {
    throw new Error("SQS_QUEUE_URL is not configured");
  }
  const response = await sqsClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: SQS_QUEUE_URL,
      AttributeNames: [
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
        "ApproximateNumberOfMessagesDelayed",
        "OldestMessageAge",
      ],
    })
  );
  const attrs = response.Attributes || {};
  const toInt = (v) => (v === undefined || v === null ? null : parseInt(v, 10));
  return {
    queueUrl: SQS_QUEUE_URL,
    approximateNumberOfMessages: toInt(attrs.ApproximateNumberOfMessages),
    approximateNumberOfMessagesNotVisible: toInt(
      attrs.ApproximateNumberOfMessagesNotVisible
    ),
    approximateNumberOfMessagesDelayed: toInt(
      attrs.ApproximateNumberOfMessagesDelayed
    ),
    oldestMessageAge: toInt(attrs.OldestMessageAge),
  };
};

module.exports = { sqsClient, SQS_QUEUE_URL, buildSimulationJob, sendSimulationJob, getQueueStatus };
