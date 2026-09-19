const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const {
  GetCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { ddb, TABLES } = require("../config/database");
const {
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
} = require("../utils/errors");

const EMAIL_INDEX = "email-index";
const BCRYPT_ROUNDS = 10;
const MAX_PASSWORD_LENGTH = 12;
const DEFAULT_LIST_LIMIT = 20;

// Refresh tokens are high-entropy 7-day JWTs, so a plain SHA-256 digest is
// adequate at rest -- bcrypt is for low-entropy passwords and would add its
// work factor to every /refresh call. Unchanged from the Mongoose model.
const hashRefreshToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const normalizeEmail = (email) => String(email).toLowerCase().trim();

const emailLockKey = (email) => `email#${normalizeEmail(email)}`;

// DynamoDB has no `select: false`; strip secrets explicitly before an item
// leaves this module. `_id` mirrors the old Mongo document so existing
// controllers / API consumers keep working.
const toSafeUser = (user) => {
  if (!user) return null;
  const { passwordHash, refreshTokenHash, ...safe } = user;
  return { ...safe, userId: user.userId, _id: user.userId };
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

const findById = async (id) => {
  if (!id) return null;
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLES.users, Key: { userId: id } })
  );
  return Item || null;
};

const findByEmail = async (email) => {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: TABLES.users,
      IndexName: EMAIL_INDEX,
      KeyConditionExpression: "email = :email",
      ExpressionAttributeValues: { ":email": normalizeEmail(email) },
      Limit: 1,
    })
  );
  return (Items && Items[0]) || null;
};

const register = async (username, email, password, affiliation = "") => {
  if (!username || !email || !password) {
    throw new BadRequestError(
      "All fields (username, email, password) are required"
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new BadRequestError("Password cannot exceed 12 characters");
  }

  const normalizedEmail = normalizeEmail(email);
  const now = new Date().toISOString();
  const userId = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const user = {
    userId,
    username,
    email: normalizedEmail,
    passwordHash,
    role: "user",
    isActive: true,
    profilePicture: null,
    affiliation: affiliation || "",
    createdAt: now,
    updatedAt: now,
  };

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLES.users,
              Item: user,
              ConditionExpression: "attribute_not_exists(userId)",
            },
          },
          {
            Put: {
              TableName: TABLES.uniqueness,
              Item: { lockKey: emailLockKey(normalizedEmail), userId },
              ConditionExpression: "attribute_not_exists(lockKey)",
            },
          },
        ],
      })
    );
  } catch (error) {
    // Duplicate email fails the second condition, cancelling the whole
    // transaction (the user item is rolled back too).
    if (
      error.name === "TransactionCanceledException" ||
      error.name === "ConditionalCheckFailedException"
    ) {
      throw new ConflictError("User already exists");
    }
    throw error;
  }

  return toSafeUser(user);
};

const login = async (email, password) => {
  const user = await findByEmail(email);
  if (!user) {
    throw new UnauthorizedError("Invalid email or password");
  }
  if (!user.isActive) {
    throw new ForbiddenError("Account has been suspended");
  }
  const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
  if (!isPasswordValid) {
    throw new UnauthorizedError("Invalid email or password");
  }
  return user;
};

const updateProfile = async (id, updates = {}) => {
  const existing = await findById(id);
  if (!existing) return null;

  const nextEmail =
    updates.email !== undefined ? normalizeEmail(updates.email) : undefined;
  const emailChanged = nextEmail !== undefined && nextEmail !== existing.email;
  const now = new Date().toISOString();

  if (emailChanged) {
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: TABLES.users,
                Key: { userId: id },
                UpdateExpression: "SET email = :email, updatedAt = :updatedAt",
                ConditionExpression: "attribute_exists(userId)",
                ExpressionAttributeValues: {
                  ":email": nextEmail,
                  ":updatedAt": now,
                },
              },
            },
            {
              Delete: {
                TableName: TABLES.uniqueness,
                Key: { lockKey: emailLockKey(existing.email) },
              },
            },
            {
              Put: {
                TableName: TABLES.uniqueness,
                Item: { lockKey: emailLockKey(nextEmail), userId: id },
                ConditionExpression: "attribute_not_exists(lockKey)",
              },
            },
          ],
        })
      );
    } catch (error) {
      if (
        error.name === "TransactionCanceledException" ||
        error.name === "ConditionalCheckFailedException"
      ) {
        throw new ConflictError("Email already in use");
      }
      throw error;
    }
  }

  const sets = ["updatedAt = :updatedAt"];
  const names = {};
  const values = { ":updatedAt": now };

  const assign = (attr, value, placeholder) => {
    names[`#${attr}`] = attr;
    values[placeholder] = value;
    sets.push(`#${attr} = ${placeholder}`);
  };

  if (updates.username !== undefined) {
    assign("username", updates.username, ":username");
  }
  // When the email changed it was already written by the transaction above.
  if (!emailChanged && updates.email !== undefined) {
    assign("email", nextEmail, ":email");
  }
  if (updates.affiliation !== undefined) {
    assign("affiliation", updates.affiliation, ":affiliation");
  }
  if (updates.profilePicture !== undefined) {
    assign("profilePicture", updates.profilePicture, ":profilePicture");
  }

  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: TABLES.users,
      Key: { userId: id },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ...(Object.keys(names).length
        ? { ExpressionAttributeNames: names }
        : {}),
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    })
  );

  return toSafeUser(Attributes);
};

const changePassword = async (id, newPassword) => {
  if (!newPassword || newPassword.length > MAX_PASSWORD_LENGTH) {
    throw new BadRequestError("Password cannot exceed 12 characters");
  }
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: TABLES.users,
      Key: { userId: id },
      UpdateExpression:
        "SET passwordHash = :passwordHash, updatedAt = :updatedAt REMOVE refreshTokenHash",
      ExpressionAttributeValues: {
        ":passwordHash": passwordHash,
        ":updatedAt": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    })
  );
  return toSafeUser(Attributes);
};

const saveRefreshToken = async (id, token) => {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLES.users,
      Key: { userId: id },
      UpdateExpression: "SET refreshTokenHash = :refreshTokenHash",
      ExpressionAttributeValues: {
        ":refreshTokenHash": hashRefreshToken(token),
      },
    })
  );
};

const clearRefreshToken = async (id) => {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLES.users,
      Key: { userId: id },
      UpdateExpression: "REMOVE refreshTokenHash",
    })
  );
};

const setActive = async (id, isActive) => {
  const now = new Date().toISOString();
  const params = {
    TableName: TABLES.users,
    Key: { userId: id },
    ExpressionAttributeValues: { ":isActive": isActive, ":updatedAt": now },
    ReturnValues: "ALL_NEW",
  };
  if (isActive) {
    params.UpdateExpression = "SET isActive = :isActive, updatedAt = :updatedAt";
  } else {
    // Suspending ends all sessions.
    params.UpdateExpression =
      "SET isActive = :isActive, updatedAt = :updatedAt REMOVE refreshTokenHash";
  }
  const { Attributes } = await ddb.send(new UpdateCommand(params));
  return toSafeUser(Attributes);
};

const listAll = async ({ limit = DEFAULT_LIST_LIMIT, cursor } = {}) => {
  const { Items, LastEvaluatedKey } = await ddb.send(
    new ScanCommand({
      TableName: TABLES.users,
      Limit: limit,
      ExclusiveStartKey: decodeCursor(cursor),
    })
  );
  return {
    users: (Items || []).map(toSafeUser),
    nextCursor: encodeCursor(LastEvaluatedKey),
  };
};

const User = {
  hashRefreshToken,
  toSafeUser,
  register,
  login,
  findById,
  findByEmail,
  updateProfile,
  changePassword,
  saveRefreshToken,
  clearRefreshToken,
  setActive,
  listAll,
};

module.exports = User;
