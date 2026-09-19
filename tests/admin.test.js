const crypto = require("node:crypto");
const request = require("supertest");
const app = require("../app");
const User = require("../models/user");
const Simulation = require("../models/simulation");
const { signAccessToken } = require("../utils/tokens");
const { createAdmin } = require("./helpers");
// Mocked in tests/setup.js — used to return canned SQS queue attributes.
const { GetQueueAttributesCommand, __sqsSendMock } = require("@aws-sdk/client-sqs");

describe("Admin Endpoints", () => {
  let userToken;
  let adminToken;
  let adminId;
  let userId;

  const regularUser = {
    username: "regularuser",
    email: "user@example.com",
    password: "password123",
  };

  const adminUser = {
    username: "adminuser",
    email: "admin@example.com",
    password: "password123",
  };

  beforeEach(async () => {
    const user = await User.register(regularUser.username, regularUser.email, regularUser.password);
    userId = user.userId;
    userToken = signAccessToken(user);

    const admin = await createAdmin({
      username: adminUser.username,
      email: adminUser.email,
      password: adminUser.password,
    });
    adminId = admin.userId;
    adminToken = signAccessToken(admin);
  });

  describe("Role-based access control", () => {
    it("should deny admin access to regular users (403)", async () => {
      const res = await request(app)
        .get("/api/v1/admin/users")
        .set("Authorization", `Bearer ${userToken}`);

      expect(res.statusCode).toBe(403);
      expect(res.body).toHaveProperty("message", "Admin access required");
    });

    it("should allow admin access to admin users", async () => {
      const res = await request(app)
        .get("/api/v1/admin/users")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(200);
    });

    it("should return 401 without a token", async () => {
      const res = await request(app).get("/api/v1/admin/users");

      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /api/v1/admin/users", () => {
    it("should list all users with cursor pagination", async () => {
      // DynamoDB sets LastEvaluatedKey whenever the page Limit is reached, so a
      // final empty page is possible; follow the cursor until it is exhausted.
      const seen = [];
      let cursor;
      let pages = 0;

      do {
        const url = cursor
          ? `/api/v1/admin/users?limit=1&cursor=${encodeURIComponent(cursor)}`
          : "/api/v1/admin/users?limit=1";
        const res = await request(app)
          .get(url)
          .set("Authorization", `Bearer ${adminToken}`);

        expect(res.statusCode).toBe(200);
        expect(res.body.users).toBeInstanceOf(Array);
        seen.push(...res.body.users.map((u) => u.userId));
        cursor = res.body.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);

      expect(pages).toBeGreaterThanOrEqual(2);
      expect(seen).toEqual(expect.arrayContaining([userId, adminId]));
    });

    it("should not expose refresh tokens in user list", async () => {
      const res = await request(app)
        .get("/api/v1/admin/users")
        .set("Authorization", `Bearer ${adminToken}`);

      res.body.users.forEach((u) => {
        expect(u).not.toHaveProperty("refreshToken");
        expect(u).not.toHaveProperty("refreshTokenHash");
      });
    });
  });

  describe("GET /api/v1/admin/users/:id", () => {
    it("should return a single user by ID", async () => {
      const res = await request(app)
        .get(`/api/v1/admin/users/${userId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.user._id).toBe(userId);
    });

    it("should return 404 for non-existent user", async () => {
      const fakeId = crypto.randomUUID();
      const res = await request(app)
        .get(`/api/v1/admin/users/${fakeId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(404);
    });
  });

  describe("PATCH /api/v1/admin/users/:id/suspend", () => {
    it("should suspend a regular user", async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/users/${userId}/suspend`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("isActive", false);
      expect(res.body.message).toContain("suspended");
    });

    it("should clear the suspended user's stored refresh-token hash", async () => {
      await request(app)
        .post("/api/v1/login")
        .send({ email: regularUser.email, password: regularUser.password });

      const before = await User.findById(userId);
      expect(before.refreshTokenHash).not.toBeNull();

      await request(app)
        .patch(`/api/v1/admin/users/${userId}/suspend`)
        .set("Authorization", `Bearer ${adminToken}`);

      const after = await User.findById(userId);
      expect(after.refreshTokenHash).toBeUndefined();
    });

    it("should reactivate a suspended user", async () => {
      await User.setActive(userId, false);
      const res = await request(app)
        .patch(`/api/v1/admin/users/${userId}/suspend`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("isActive", true);
      expect(res.body.message).toContain("activated");
    });

    it("should not suspend an admin user", async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/users/${adminId}/suspend`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(400);
    });

    it("should return 404 for non-existent user", async () => {
      const fakeId = crypto.randomUUID();
      const res = await request(app)
        .patch(`/api/v1/admin/users/${fakeId}/suspend`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /api/v1/admin/simulations", () => {
    it("should list all simulations across all users", async () => {
      await Simulation.createSimulation(userId, [1, 2], {
        mutation: [1],
        crossover: [1],
        selection: [1],
      });

      const res = await request(app)
        .get("/api/v1/admin/simulations")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.simulationCount).toBeGreaterThanOrEqual(1);
      expect(res.body.simulations).toBeInstanceOf(Array);
    });

    it("should filter simulations by userId", async () => {
      await Simulation.createSimulation(userId, [1, 2], {
        mutation: [1],
        crossover: [1],
        selection: [1],
      });

      const res = await request(app)
        .get(`/api/v1/admin/simulations?userId=${userId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.simulationCount).toBe(1);
    });
  });

  describe("DELETE /api/v1/admin/simulations/:id", () => {
    it("should delete any simulation as admin", async () => {
      const sim = await Simulation.createSimulation(userId, [1, 2], {
        mutation: [1],
        crossover: [1],
        selection: [1],
      });

      const res = await request(app)
        .delete(`/api/v1/admin/simulations/${sim.simulationId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("message", "Simulation deleted successfully");

      const deleted = await Simulation.getSimulationById(sim.simulationId);
      expect(deleted).toBeNull();
    });

    it("should return 404 for non-existent simulation", async () => {
      const fakeId = crypto.randomUUID();
      const res = await request(app)
        .delete(`/api/v1/admin/simulations/${fakeId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /api/v1/admin/queue", () => {
    it("should return real SQS queue metrics", async () => {
      __sqsSendMock.mockResolvedValue({
        Attributes: {
          ApproximateNumberOfMessages: "3",
          ApproximateNumberOfMessagesNotVisible: "1",
          ApproximateNumberOfMessagesDelayed: "2",
          OldestMessageAge: "42",
        },
      });

      const res = await request(app)
        .get("/api/v1/admin/queue")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.queue).toEqual({
        queueUrl: process.env.SQS_QUEUE_URL,
        approximateNumberOfMessages: 3,
        approximateNumberOfMessagesNotVisible: 1,
        approximateNumberOfMessagesDelayed: 2,
        oldestMessageAge: 42,
      });

      const commandInput = GetQueueAttributesCommand.mock.calls[0][0];
      expect(commandInput.QueueUrl).toBe(process.env.SQS_QUEUE_URL);
      expect(commandInput.AttributeNames).toEqual(
        expect.arrayContaining([
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
          "ApproximateNumberOfMessagesDelayed",
          "OldestMessageAge",
        ])
      );
    });

    it("should return 503 when SQS queue URL is not configured", async () => {
      const sqsConfig = require("../config/sqs");
      const spy = jest
        .spyOn(sqsConfig, "getQueueStatus")
        .mockRejectedValue(new Error("SQS_QUEUE_URL is not configured"));

      const res = await request(app)
        .get("/api/v1/admin/queue")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(503);
      expect(res.body.message).toContain("not configured");
      expect(res.body.queue).toBeNull();
      spy.mockRestore();
    });

    it("should deny regular users (403)", async () => {
      const res = await request(app)
        .get("/api/v1/admin/queue")
        .set("Authorization", `Bearer ${userToken}`);

      expect(res.statusCode).toBe(403);
    });
  });
});
