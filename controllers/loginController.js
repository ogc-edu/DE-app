const users = require("../models/user");
const { signAccessToken, signRefreshToken } = require("../utils/tokens");

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await users.login(email, password);
    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    await users.saveRefreshToken(user.userId, refreshToken);

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({ message: "Login successful", token: accessToken });
  } catch (error) {
    next(error);
  }
};

module.exports = { login };
