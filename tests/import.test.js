const request = require("supertest");
const app = require("../app");
const User = require("../models/user");
const Simulation = require("../models/simulation");
const { signAccessToken } = require("../utils/tokens");
// Mocked in tests/setup.js — used to assert that imports never touch SQS.
const { __sqsSendMock } = require("@aws-sdk/client-sqs");

const header = "model\tbenchmark\tlowestFitness";
const validContent = [
  "# np=20",
  "# f=0.7",
  "# cr=0.8",
  "# gen=500",
  "# dim=10",
  header,
  "DE/best/1/binomial/greedy\t1\t2.997146999302399",
  "DE/rand/3/exponential/sts\t6\t1.0924594562311541e-14",
].join("\n");

describe("POST /api/v1/simulation/import", () => {
  let token;
  let userId;

  const testUser = {
    username: "importer",
    email: "importer@example.com",
    password: "password123",
  };

  beforeEach(async () => {
    __sqsSendMock.mockClear();
    const user = await User.register(testUser.username, testUser.email, testUser.password);
    userId = user.userId;
    token = signAccessToken(user);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app)
      .post("/api/v1/simulation/import")
      .send({ content: validContent });

    expect(res.statusCode).toBe(401);
  });

  it("imports valid content as a completed simulation with parsed metadata", async () => {
    const res = await request(app)
      .post("/api/v1/simulation/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ content: validContent, filename: "results.txt" });

    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty("simulationId");
    expect(res.body.totalModels).toBe(2);

    const sim = await Simulation.getSimulationById(res.body.simulationId);
    expect(sim.status).toBe("completed");
    expect(sim.totalModels).toBe(2);
    expect(sim.completedModels).toBe(2);
    expect(sim.progress).toBe(100);
    expect(sim.np).toBe(20);
    expect(sim.f).toBe(0.7);
    expect(sim.cr).toBe(0.8);
    expect(sim.gen).toBe(500);
    expect(sim.dim).toBe(10);

    const data = (await Simulation.getResults(sim.simulationId)).map((d) => ({
      functionId: d.functionId,
      mutationId: d.mutationId,
      crossoverId: d.crossoverId,
      selectionId: d.selectionId,
      lowestFitness: d.lowestFitness,
    }));
    expect(data).toHaveLength(2);
    expect(data).toEqual(
      expect.arrayContaining([
        { functionId: 1, mutationId: 4, crossoverId: 2, selectionId: 2, lowestFitness: 2.997146999302399 },
        { functionId: 6, mutationId: 3, crossoverId: 1, selectionId: 1, lowestFitness: 1.0924594562311541e-14 },
      ])
    );

    // functions/methods derived as unique, sorted IDs from the rows.
    expect(sim.functions).toEqual([1, 6]);
    expect(sim.methods.mutation).toEqual([3, 4]);
    expect(sim.methods.crossover).toEqual([1, 2]);
    expect(sim.methods.selection).toEqual([1, 2]);
  });

  it("applies schema defaults when metadata is omitted", async () => {
    const content = `${header}\nDE/best/1/binomial/greedy\t1\t0.5`;
    const res = await request(app)
      .post("/api/v1/simulation/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ content });

    expect(res.statusCode).toBe(201);
    const sim = await Simulation.getSimulationById(res.body.simulationId);
    expect(sim.np).toBe(15);
    expect(sim.f).toBe(0.5);
    expect(sim.cr).toBe(0.9);
    expect(sim.gen).toBe(1000);
    expect(sim.dim).toBe(30);
  });

  it("returns 400 with line-numbered errors for a malformed file", async () => {
    const content = `${header}\nDE/best/1/bin/greedy\t1\t0.5`;
    const res = await request(app)
      .post("/api/v1/simulation/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ content });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.errors).toBeInstanceOf(Array);
    expect(res.body.errors[0].line).toBe(2);
    expect(res.body.errors[0].message).toMatch(/unknown crossover 'bin'/);
  });

  it("returns 400 when content is missing (Zod)", async () => {
    const res = await request(app)
      .post("/api/v1/simulation/import")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty("errors");
  });

  it("does not enqueue any SQS job", async () => {
    const res = await request(app)
      .post("/api/v1/simulation/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ content: validContent });

    expect(res.statusCode).toBe(201);
    expect(__sqsSendMock).not.toHaveBeenCalled();
  });
});
