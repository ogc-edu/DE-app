const jwt = require("jsonwebtoken");

// Access token: short-lived, carries only the stable user id.
const signAccessToken = (user) =>
  jwt.sign({ userId: user.userId }, process.env.JWT_SECRET, {
    expiresIn: "1h",
  });

// Refresh token: 7 days, carries a random jti so every rotation is a distinct
// token (the sha256 digest is what gets persisted).
const signRefreshToken = (user) =>
  jwt.sign(
    {
      userId: user.userId,
      jti: Date.now().toString() + Math.random().toString(36).slice(2),
    },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: "7d" }
  );

module.exports = { signAccessToken, signRefreshToken };
