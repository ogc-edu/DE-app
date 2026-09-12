const request = require("supertest");
const app = require("../app");
const User = require("../models/user");

// Do not hit AWS in tests; return a canned presigned URL.
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn().mockResolvedValue("https://presigned.example.com/upload"),
}));

describe("User Profile Endpoints", () => {
  let token;
  let userId;

  const testUser = {
    username: "profileuser",
    email: "profile@example.com",
    password: "password123",
  };

  beforeEach(async () => {
    const user = await User.register(testUser.username, testUser.email, testUser.password);
    userId = user._id.toString();
    token = user.generateJwtToken();
  });

  describe("GET /api/v1/user/profile", () => {
    it("should return the current user's profile", async () => {
      const res = await request(app)
        .get("/api/v1/user/profile")
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.user).toHaveProperty("username", testUser.username);
      expect(res.body.user).toHaveProperty("email", testUser.email);
      expect(res.body.user).not.toHaveProperty("password");
      expect(res.body.user).not.toHaveProperty("refreshToken");
      expect(res.body.user).not.toHaveProperty("refreshTokenHash");
    });

    it("should return 401 without a token", async () => {
      const res = await request(app).get("/api/v1/user/profile");

      expect(res.statusCode).toBe(401);
    });
  });

  describe("PATCH /api/v1/user/profile", () => {
    it("should update username", async () => {
      const res = await request(app)
        .patch("/api/v1/user/profile")
        .set("Authorization", `Bearer ${token}`)
        .send({ username: "newusername" });

      expect(res.statusCode).toBe(200);
      expect(res.body.user).toHaveProperty("username", "newusername");
    });

    it("should update email", async () => {
      const res = await request(app)
        .patch("/api/v1/user/profile")
        .set("Authorization", `Bearer ${token}`)
        .send({ email: "newemail@example.com" });

      expect(res.statusCode).toBe(200);
      expect(res.body.user).toHaveProperty("email", "newemail@example.com");
    });

    it("should not update to an email already in use", async () => {
      await User.register("other", "taken@example.com", "password123");
      const res = await request(app)
        .patch("/api/v1/user/profile")
        .set("Authorization", `Bearer ${token}`)
        .send({ email: "taken@example.com" });

      expect(res.statusCode).toBe(409);
      expect(res.body.error).toContain("already in use");
    });

    it("should update affiliation", async () => {
      const res = await request(app)
        .patch("/api/v1/user/profile")
        .set("Authorization", `Bearer ${token}`)
        .send({ affiliation: "University of Science" });

      expect(res.statusCode).toBe(200);
      expect(res.body.user).toHaveProperty("affiliation", "University of Science");
    });
  });

  describe("PATCH /api/v1/user/password", () => {
    it("should change password with correct current password", async () => {
      const res = await request(app)
        .patch("/api/v1/user/password")
        .set("Authorization", `Bearer ${token}`)
        .send({ currentPassword: testUser.password, newPassword: "newpass123" });

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("message", "Password changed successfully");
    });

    it("should not change password with incorrect current password", async () => {
      const res = await request(app)
        .patch("/api/v1/user/password")
        .set("Authorization", `Bearer ${token}`)
        .send({ currentPassword: "wrongpassword", newPassword: "newpass123" });

      expect(res.statusCode).toBe(401);
      expect(res.body.error).toContain("incorrect");
    });

    it("should verify new password works for login", async () => {
      await request(app)
        .patch("/api/v1/user/password")
        .set("Authorization", `Bearer ${token}`)
        .send({ currentPassword: testUser.password, newPassword: "newpass123" });

      const res = await request(app)
        .post("/api/v1/login")
        .send({ email: testUser.email, password: "newpass123" });

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("token");
    });

    it("should invalidate existing sessions after a password change", async () => {
      const loginRes = await request(app)
        .post("/api/v1/login")
        .send({ email: testUser.email, password: testUser.password });
      const cookies = loginRes.headers["set-cookie"];
      const cookieStr = Array.isArray(cookies) ? cookies.join(";") : cookies;
      const refreshToken = cookieStr.match(/refreshToken=([^;]+)/)[1];

      await request(app)
        .patch("/api/v1/user/password")
        .set("Authorization", `Bearer ${token}`)
        .send({ currentPassword: testUser.password, newPassword: "newpass123" });

      const res = await request(app)
        .post("/api/v1/refresh")
        .set("Cookie", `refreshToken=${refreshToken}`);

      expect(res.statusCode).toBe(401);

      const user = await User.findById(userId).select("+refreshTokenHash");
      expect(user.refreshTokenHash).toBeNull();
    });

    it("should reject new password exceeding 12 characters (Zod validation)", async () => {
      const res = await request(app)
        .patch("/api/v1/user/password")
        .set("Authorization", `Bearer ${token}`)
        .send({ currentPassword: testUser.password, newPassword: "toolongpassword123" });

      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty("errors");
    });
  });

  describe("GET /api/v1/user/profile/presign", () => {
    it("should return a presigned upload URL for an allowed content type", async () => {
      const res = await request(app)
        .get("/api/v1/user/profile/presign")
        .query({ contentType: "image/jpeg" })
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("uploadUrl", "https://presigned.example.com/upload");
      expect(res.body).toHaveProperty("key", `profile-images/${userId}`);
      expect(res.body).toHaveProperty("contentType", "image/jpeg");
      expect(res.body).toHaveProperty("expiresIn");
    });

    it("should reject an unsupported content type", async () => {
      const res = await request(app)
        .get("/api/v1/user/profile/presign")
        .query({ contentType: "text/html" })
        .set("Authorization", `Bearer ${token}`);

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toContain("Unsupported content type");
    });

    it("should return 401 without a token", async () => {
      const res = await request(app).get("/api/v1/user/profile/presign").query({ contentType: "image/png" });

      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/v1/user/profile/picture", () => {
    it("should store the public profile picture URL with versionId cache-buster", async () => {
      const res = await request(app)
        .post("/api/v1/user/profile/picture")
        .set("Authorization", `Bearer ${token}`)
        .send({ versionId: "abc123" });

      expect(res.statusCode).toBe(200);
      expect(res.body.user).toHaveProperty("profilePicture");
      expect(res.body.user.profilePicture).toBe(
        `https://test-bucket.s3.us-east-1.amazonaws.com/profile-images/${userId}?v=abc123`
      );
    });

    it("should store the URL without versionId when omitted", async () => {
      const res = await request(app)
        .post("/api/v1/user/profile/picture")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.statusCode).toBe(200);
      expect(res.body.user.profilePicture).toBe(
        `https://test-bucket.s3.us-east-1.amazonaws.com/profile-images/${userId}`
      );
    });

    it("should reject an empty versionId (Zod validation)", async () => {
      const res = await request(app)
        .post("/api/v1/user/profile/picture")
        .set("Authorization", `Bearer ${token}`)
        .send({ versionId: "" });

      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty("errors");
    });
  });
});
