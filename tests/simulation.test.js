const request = require("supertest");
const mongoose = require("mongoose");
const app = require("../app");
const User = require("../models/user");
const Simulation = require("../models/simulation");
// Mocked in tests/setup.js — grab the handles to assert on SQS payloads.
const { SendMessageCommand, __sqsSendMock } = require("@aws-sdk/client-sqs");

describe("Simulation Endpoints", () => {
  let token;
  let userId;

  const testUser = {
    username: "researcher",
    email: "researcher@example.com",
    password: "password123",
  };

  const validSimInput = {
    functions: [1, 2],
    methods: {
      mutation: [1, 2],
      crossover: [1],
      selection: [1],
    },
  };

  beforeEach(async () => {
    __sqsSendMock.mockClear();
    SendMessageCommand.mockClear();
    const user = await User.register(testUser.username, testUser.email, testUser.password);
    userId = user._id.toString();
    token = user.generateJwtToken();
  });

  describe("POST /api/v1/simulation/create", () => {
    it("should create a simulation with valid params and return 201", async () => {
      const res = await request(app)
        .post("/api/v1/simulation/create")
        .set("Authorization", `Bearer ${token}`)
        .send(validSimInput);

      expect(res.statusCode).toBe(201);
      expect(res.body).toHaveProperty("simulationId");
    });

    it("should compute totalModels as Cartesian product", async () => {
      const res = await request(app)
        .post("/api/v1/simulation/create")
        .set("Authorization", `Bearer ${token}`)
        .send(validSimInput);

      const sim = await Simulation.findById(res.body.simulationId);
      expect(sim.totalModels).toBe(2 * 2 * 1 * 1);
    });

    it("should return 401 without a token", async () => {
      const res = await request(app).post("/api/v1/simulation/create").send(validSimInput);

      expect(res.statusCode).toBe(401);
    });

    it("should return 400 with invalid input (Zod validation)", async () => {
      const res = await request(app)
        .post("/api/v1/simulation/create")
        .set("Authorization", `Bearer ${token}`)
        .send({ functions: [99], methods: { mutation: [1], crossover: [1], selection: [1] } });

      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty("errors");
    });

    it("should persist DE algorithm parameters (np/f/cr/gen/dim)", async () => {
      const res = await request(app)
        .post("/api/v1/simulation/create")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...validSimInput, np: 20, f: 0.7, cr: 0.8, gen: 500, dim: 10 });

      expect(res.statusCode).toBe(201);
      const sim = await Simulation.findById(res.body.simulationId);
      expect(sim.np).toBe(20);
      expect(sim.f).toBe(0.7);
      expect(sim.cr).toBe(0.8);
      expect(sim.gen).toBe(500);
      expect(sim.dim).toBe(10);
    });

    it("should apply default DE parameters when omitted", async () => {
      const res = await request(app)
        .post("/api/v1/simulation/create")
        .set("Authorization", `Bearer ${token}`)
        .send(validSimInput);

      const sim = await Simulation.findById(res.body.simulationId);
      expect(sim.np).toBe(15);
      expect(sim.f).toBe(0.5);
      expect(sim.cr).toBe(0.9);
      expect(sim.gen).toBe(1000);
      expect(sim.dim).toBe(30);
    });

    it("should return 400 for out-of-range DE parameters (Zod)", async () => {
      const res = await request(app)
        .post("/api/v1/simulation/create")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...validSimInput, np: 5, dim: 31, cr: 5 });

      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty("errors");
    });

    it("should enqueue exactly one SQS job with the worker contract", async () => {
      const res = await request(app)
        .post("/api/v1/simulation/create")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...validSimInput, np: 20, f: 0.7, cr: 0.8, gen: 500, dim: 10 });

      expect(res.statusCode).toBe(201);
      expect(res.body.queued).toBe(true);
      expect(__sqsSendMock).toHaveBeenCalledTimes(1);

      const commandInput = SendMessageCommand.mock.calls[0][0];
      expect(commandInput.QueueUrl).toBe(process.env.SQS_QUEUE_URL);
      const body = JSON.parse(commandInput.MessageBody);
      expect(body).toEqual({
        simulationId: res.body.simulationId,
        bf: "1,2",
        mutation: "1,2",
        crossover: "1",
        selection: "1",
        cr: 0.8,
        f: 0.7,
        np: 20,
        gen: 500,
        dim: 10,
      });
    });

    it("should mark the simulation failed but still return 201 when SQS enqueue fails", async () => {
      __sqsSendMock.mockRejectedValueOnce(new Error("SQS unavailable"));

      const res = await request(app)
        .post("/api/v1/simulation/create")
        .set("Authorization", `Bearer ${token}`)
        .send(validSimInput);

      expect(res.statusCode).toBe(201);
      expect(res.body.queued).toBe(false);
      const sim = await Simulation.findById(res.body.simulationId);
      expect(sim.status).toBe("failed");
    });

    it("should accept the 'running' status set by workers", async () => {
      const sim = await Simulation.createSimulation(userId, validSimInput.functions, validSimInput.methods);
      const updated = await Simulation.findByIdAndUpdate(
        sim._id,
        { status: "running", progress: 10 },
        { new: true }
      );
      expect(updated.status).toBe("running");
      const simAfter = await Simulation.findById(sim._id);
      expect(simAfter.status).toBe("running");
    });
  });

  describe("GET /api/v1/simulation/get", () => {
    it("should return all simulations for the user", async () => {
      await Simulation.createSimulation(userId, validSimInput.functions, validSimInput.methods);
      const res = await request(app)
        .get("/api/v1/simulation/get")
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.simulationCount).toBe(1);
      expect(res.body.simulations).toHaveLength(1);
    });

    it("should return empty list when user has no simulations", async () => {
      const res = await request(app)
        .get("/api/v1/simulation/get")
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.simulationCount).toBe(0);
      expect(res.body.simulations).toHaveLength(0);
    });

    it("should support pagination", async () => {
      for (let i = 0; i < 3; i++) {
        await Simulation.createSimulation(userId, validSimInput.functions, validSimInput.methods);
      }
      const res = await request(app)
        .get("/api/v1/simulation/get?page=1&limit=2")
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.simulations).toHaveLength(2);
      expect(res.body.currentPage).toBe(1);
      expect(res.body.totalPages).toBe(2);
    });

    it("should support status filter", async () => {
      const sim = await Simulation.createSimulation(userId, validSimInput.functions, validSimInput.methods);
      await Simulation.findByIdAndUpdate(sim._id, { status: "completed" });
      await Simulation.createSimulation(userId, validSimInput.functions, validSimInput.methods);

      const res = await request(app)
        .get("/api/v1/simulation/get?status=completed")
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.simulationCount).toBe(1);
    });

    it("should return 401 without a token", async () => {
      const res = await request(app).get("/api/v1/simulation/get");

      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /api/v1/simulation/get/:simulationId", () => {
    it("should return a single simulation", async () => {
      const sim = await Simulation.createSimulation(userId, validSimInput.functions, validSimInput.methods);
      const res = await request(app)
        .get(`/api/v1/simulation/get/${sim._id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.simulation._id).toBe(sim._id.toString());
    });

    it("should not allow access to another user's simulation", async () => {
      const otherUser = await User.register("other", "other@example.com", "password123");
      const otherSim = await Simulation.createSimulation(
        otherUser._id.toString(),
        validSimInput.functions,
        validSimInput.methods
      );

      const res = await request(app)
        .get(`/api/v1/simulation/get/${otherSim._id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(403);
    });

    it("should return 404 for a non-existent simulation", async () => {
      const missingId = new mongoose.Types.ObjectId().toString();
      const res = await request(app)
        .get(`/api/v1/simulation/get/${missingId}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(404);
      expect(res.body.error).toContain("Simulation not found");
    });
  });

  describe("GET /api/v1/simulation/get/:simulationId/results", () => {
    it("should return simulation results grid", async () => {
      const sim = await Simulation.createSimulation(userId, validSimInput.functions, validSimInput.methods);
      const res = await request(app)
        .get(`/api/v1/simulation/get/${sim._id}/results`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("simulationId");
      expect(res.body).toHaveProperty("totalModels");
      expect(res.body).toHaveProperty("completedModels");
      expect(res.body).toHaveProperty("progress");
      expect(res.body).toHaveProperty("simulationData");
    });

    it("should return 404 for a non-existent simulation", async () => {
      const missingId = new mongoose.Types.ObjectId().toString();
      const res = await request(app)
        .get(`/api/v1/simulation/get/${missingId}/results`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(404);
      expect(res.body.error).toContain("Simulation not found");
    });
  });

  describe("DELETE /api/v1/simulation/delete/:simulationId", () => {
    it("should delete a simulation", async () => {
      const sim = await Simulation.createSimulation(userId, validSimInput.functions, validSimInput.methods);
      const res = await request(app)
        .delete(`/api/v1/simulation/delete/${sim._id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("message", "Simulation deleted successfully");

      const deleted = await Simulation.findById(sim._id);
      expect(deleted).toBeNull();
    });

    it("should not delete another user's simulation", async () => {
      const otherUser = await User.register("other", "other@example.com", "password123");
      const otherSim = await Simulation.createSimulation(
        otherUser._id.toString(),
        validSimInput.functions,
        validSimInput.methods
      );

      const res = await request(app)
        .delete(`/api/v1/simulation/delete/${otherSim._id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/v1/simulation/cancel/:simulationId", () => {
    it("should cancel a simulation", async () => {
      const sim = await Simulation.createSimulation(userId, validSimInput.functions, validSimInput.methods);
      const res = await request(app)
        .post(`/api/v1/simulation/cancel/${sim._id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("message", "Simulation cancelled successfully");
    });

    it("should reject cancelling a completed simulation", async () => {
      const sim = await Simulation.createSimulation(userId, validSimInput.functions, validSimInput.methods);
      await Simulation.findByIdAndUpdate(sim._id, { status: "completed" });
      const res = await request(app)
        .post(`/api/v1/simulation/cancel/${sim._id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(409);
      expect(res.body.error).toContain("Cannot cancel");
    });
  });
});
