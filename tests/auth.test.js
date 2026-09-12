const request = require("supertest");
const crypto = require("node:crypto");
const app = require("../app");
const User = require("../models/user");

describe("Auth Endpoints", () => {
  const testUser = {
    username: "testuser",
    email: "test@example.com",
    password: "password123",
  };

  describe("POST /api/register", () => {
    it("should register a new user with valid credentials", async () => {
      const res = await request(app).post("/api/v1/register").send(testUser);

      expect(res.statusCode).toBe(201);
      expect(res.body).toHaveProperty("success", true);
      expect(res.body).toHaveProperty("message", "User registered successfully");
    });

    it("should not register a duplicate user", async () => {
      await User.register(testUser.username, testUser.email, testUser.password);
      const res = await request(app).post("/api/v1/register").send(testUser);

      expect(res.statusCode).toBe(409);
    });

    it("should not register with missing fields", async () => {
      const res = await request(app).post("/api/v1/register").send({ email: "incomplete@example.com" });

      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/login", () => {
    beforeEach(async () => {
      await User.register(testUser.username, testUser.email, testUser.password);
    });

    it("should login with valid credentials and return access token", async () => {
      const res = await request(app)
        .post("/api/v1/login")
        .send({ email: testUser.email, password: testUser.password });

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("message", "Login successful");
      expect(res.body).toHaveProperty("token");
      expect(res.headers["set-cookie"]).toBeDefined();
    });

    it("should set refreshToken as httpOnly cookie", async () => {
      const res = await request(app)
        .post("/api/v1/login")
        .send({ email: testUser.email, password: testUser.password });

      const cookies = res.headers["set-cookie"];
      const refreshCookie = Array.isArray(cookies) ? cookies.find((c) => c.startsWith("refreshToken=")) : cookies;
      expect(refreshCookie).toContain("refreshToken=");
      expect(refreshCookie).toContain("HttpOnly");
    });

    it("should not login with invalid password", async () => {
      const res = await request(app)
        .post("/api/v1/login")
        .send({ email: testUser.email, password: "wrongpassword" });

      expect(res.statusCode).toBe(401);
    });

    it("should not login with non-existent email", async () => {
      const res = await request(app)
        .post("/api/v1/login")
        .send({ email: "noone@example.com", password: "password123" });

      expect(res.statusCode).toBe(401);
    });

    it("should not login if account is suspended", async () => {
      const user = await User.findOne({ email: testUser.email });
      user.isActive = false;
      await user.save();

      const res = await request(app)
        .post("/api/v1/login")
        .send({ email: testUser.email, password: testUser.password });

      expect(res.statusCode).toBe(403);
      expect(res.body.error).toContain("suspended");
    });
  });

  describe("POST /api/verify", () => {
    let token;

    beforeEach(async () => {
      const user = await User.register(testUser.username, testUser.email, testUser.password);
      token = user.generateJwtToken();
    });

    it("should verify a valid token", async () => {
      const res = await request(app)
        .post("/api/v1/verify")
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("status", true);
      expect(res.body.userData).toHaveProperty("username", testUser.username);
    });

    it("should return 401 without a token", async () => {
      const res = await request(app).post("/api/v1/verify");

      expect(res.statusCode).toBe(401);
    });
  });

  describe("Protected routes - 401 handling", () => {
    it("should return 401 when accessing protected route without token", async () => {
      const res = await request(app).get("/api/v1/simulation/get");

      expect(res.statusCode).toBe(401);
      expect(res.body).toHaveProperty("message");
    });

    it("should return 403 when suspended user accesses protected route", async () => {
      const user = await User.register(testUser.username, testUser.email, testUser.password);
      const token = user.generateJwtToken();
      await User.findByIdAndUpdate(user._id, { isActive: false });

      const res = await request(app)
        .get("/api/v1/simulation/get")
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(403);
      expect(res.body.message).toContain("suspended");
    });
  });

  describe("POST /api/refresh", () => {
    let refreshToken;

    beforeEach(async () => {
      await User.register(testUser.username, testUser.email, testUser.password);
      const res = await request(app)
        .post("/api/v1/login")
        .send({ email: testUser.email, password: testUser.password });

      const cookies = res.headers["set-cookie"];
      const cookieStr = Array.isArray(cookies) ? cookies.join(";") : cookies;
      const match = cookieStr.match(/refreshToken=([^;]+)/);
      refreshToken = match ? match[1] : null;
    });

    it("should issue a new access token with a valid refresh token", async () => {
      const res = await request(app)
        .post("/api/v1/refresh")
        .set("Cookie", `refreshToken=${refreshToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("token");
      expect(res.headers["set-cookie"]).toBeDefined();
    });

    it("should rotate the refresh token", async () => {
      const res = await request(app)
        .post("/api/v1/refresh")
        .set("Cookie", `refreshToken=${refreshToken}`);

      const cookies = res.headers["set-cookie"];
      const cookieStr = Array.isArray(cookies) ? cookies.join(";") : cookies;
      const newMatch = cookieStr.match(/refreshToken=([^;]+)/);
      const newRefreshToken = newMatch ? newMatch[1] : null;

      expect(newRefreshToken).not.toBe(refreshToken);
    });

    it("should store only a sha256 hash of the refresh token, never the raw token", async () => {
      const user = await User.findOne({ email: testUser.email }).select("+refreshTokenHash");

      expect(user.refreshTokenHash).toHaveLength(64);
      expect(user.refreshTokenHash).not.toBe(refreshToken);
      expect(user.refreshTokenHash).toBe(
        crypto.createHash("sha256").update(refreshToken).digest("hex")
      );
    });

    it("should reject the old refresh token after rotation", async () => {
      await request(app)
        .post("/api/v1/refresh")
        .set("Cookie", `refreshToken=${refreshToken}`);

      const res = await request(app)
        .post("/api/v1/refresh")
        .set("Cookie", `refreshToken=${refreshToken}`);

      expect(res.statusCode).toBe(401);
    });

    it("should reject a refresh after the user is suspended", async () => {
      const admin = await User.create({
        username: "suspendadmin",
        email: "suspendadmin@example.com",
        password: "password123",
        role: "admin",
      });
      const user = await User.findOne({ email: testUser.email });

      const suspendRes = await request(app)
        .patch(`/api/v1/admin/users/${user._id.toString()}/suspend`)
        .set("Authorization", `Bearer ${admin.generateJwtToken()}`);
      expect(suspendRes.statusCode).toBe(200);

      const res = await request(app)
        .post("/api/v1/refresh")
        .set("Cookie", `refreshToken=${refreshToken}`);

      expect(res.statusCode).toBe(401);
    });

    it("should reject a refresh for an inactive user even when the stored hash still matches", async () => {
      // Suspend directly so the hash is left intact -- exercises the
      // isActive guard rather than the cleared-hash path.
      const user = await User.findOne({ email: testUser.email });
      await User.findByIdAndUpdate(user._id, { isActive: false });

      const stillStored = await User.findById(user._id).select("+refreshTokenHash");
      expect(stillStored.refreshTokenHash).not.toBeNull();

      const res = await request(app)
        .post("/api/v1/refresh")
        .set("Cookie", `refreshToken=${refreshToken}`);

      expect(res.statusCode).toBe(401);
      expect(res.body.message).toContain("suspended");
    });

    it("should reject an invalid refresh token", async () => {
      const res = await request(app)
        .post("/api/v1/refresh")
        .set("Cookie", `refreshToken=invalidtoken`);

      expect(res.statusCode).toBe(401);
    });

    it("should return 401 without a refresh token", async () => {
      const res = await request(app).post("/api/v1/refresh");

      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/logout", () => {
    let refreshToken;

    beforeEach(async () => {
      await User.register(testUser.username, testUser.email, testUser.password);
      const res = await request(app)
        .post("/api/v1/login")
        .send({ email: testUser.email, password: testUser.password });

      const cookies = res.headers["set-cookie"];
      const cookieStr = Array.isArray(cookies) ? cookies.join(";") : cookies;
      const match = cookieStr.match(/refreshToken=([^;]+)/);
      refreshToken = match ? match[1] : null;
    });

    it("should clear the refresh token cookie on logout", async () => {
      const res = await request(app)
        .post("/api/v1/logout")
        .set("Cookie", `refreshToken=${refreshToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("message", "Logged out successfully");
    });

    it("should invalidate the refresh token in the database", async () => {
      await request(app)
        .post("/api/v1/logout")
        .set("Cookie", `refreshToken=${refreshToken}`);

      const user = await User.findOne({ email: testUser.email }).select("+refreshTokenHash");
      expect(user.refreshTokenHash).toBeNull();
    });
  });
});
