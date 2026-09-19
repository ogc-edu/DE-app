// Shared test helpers. Not a test file (does not match `*.test.js`), so Jest
// never executes it as a suite.
const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { ddb, TABLES } = require("../config/database");
const User = require("../models/user");

// There is no admin-creation endpoint/repository function (admins are seeded
// out of band), so register a normal user through the real repository and flip
// the role directly — the test equivalent of Mongo's `User.create({ role })`.
const createAdmin = async ({ username, email, password }) => {
  const user = await User.register(username, email, password);
  await ddb.send(
    new UpdateCommand({
      TableName: TABLES.users,
      Key: { userId: user.userId },
      UpdateExpression: "SET #role = :role, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#role": "role" },
      ExpressionAttributeValues: {
        ":role": "admin",
        ":updatedAt": new Date().toISOString(),
      },
    })
  );
  return { ...user, role: "admin" };
};

// Suspend an account WITHOUT clearing refreshTokenHash. `User.setActive(id,
// false)` deliberately removes the hash (ending sessions); this helper leaves
// it intact so tests can exercise the isActive guard on /refresh.
const setIsActivePreservingToken = async (userId, isActive) => {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLES.users,
      Key: { userId },
      UpdateExpression: "SET isActive = :isActive",
      ExpressionAttributeValues: { ":isActive": isActive },
    })
  );
};

module.exports = { createAdmin, setIsActivePreservingToken };
