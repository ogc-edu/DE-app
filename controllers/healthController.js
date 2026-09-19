const { ListTablesCommand } = require("@aws-sdk/client-dynamodb");
const { ddb } = require("../config/database");
const logger = require("../config/logger");

const healthCheck = async (req, res) => {
  let database = "ok";
  try {
    // ListTables works even before any tables exist, so it is a safe
    // lightweight connectivity probe for DynamoDB.
    await ddb.send(new ListTablesCommand({ Limit: 1 }));
  } catch (error) {
    logger.warn("DynamoDB health probe failed:", error.message);
    database = "down";
  }
  res.json({
    status: "OK",
    database,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
};

module.exports = {
  healthCheck,
};
