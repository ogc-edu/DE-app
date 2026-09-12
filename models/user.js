const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");
const {
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
} = require("../utils/errors");
require("dotenv").config();

// Refresh tokens are high-entropy 7-day JWTs, so a plain SHA-256 digest is
// adequate at rest -- bcrypt is for low-entropy passwords and would add its
// work factor to every /refresh call.
const hashRefreshToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");


const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: [true, "Please provide a name"],
    minLength: [3, "Name must be at least 3 characters long"],
    maxLength: [50, "Name cannot exceed 50 characters"],
    trim: true,
  },
  email: {
    type: String,
    required: [true, "Please provide an email"],
    unique: true,
    match: [
      /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
      "Please add a valid email",
    ],
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: true,
    minlength: [6, "Password must be at least 6 characters long"],
    select: false,
  },
  isVerified: {
    type: Boolean,
    default: false,
  },
  role: {
    type: String,
    enum: {values: ["admin", "user"],
    message: "Role must be either admin or user"
    },
    default: "user",
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  // Stores sha256(rawRefreshToken) as hex -- never the token itself.
  refreshTokenHash: {
    type: String,
    select: false,
    default: null,
  },
  profilePicture: {
    type: String,
    default: null,
  },
  affiliation: {
    type: String,
    default: "",
    trim: true,
  },
  simulationCount: {
    type: Number,
    default: 0,
  },
}, { timestamps: true });

userSchema.statics.login = async function (email, password) {
  const user = await this.findOne({ email }).select("+password +isActive");

  if (!user) {
    throw new UnauthorizedError("Invalid email or password");
  }
  if (!user.isActive) {
    throw new ForbiddenError("Account has been suspended");
  }
  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) {
    throw new UnauthorizedError("Invalid email or password");
  }
  return user;
};

userSchema.statics.register = async function (username, email, password, affiliation = "") {
  if (!username || !email || !password) {
    throw new BadRequestError("All fields (username, email, password) are required");
  }
  const exist = await this.findOne({ email });
  if (exist) {
    throw new ConflictError("User already exists");
  }
  if (password.length > 12) {
    throw new BadRequestError("Password cannot exceed 12 characters");
  }
  return await this.create({ username, email, password, affiliation });
};

userSchema.methods.generateJwtToken = function () {
  return jwt.sign({ userId: this._id.toString() }, process.env.JWT_SECRET, {
    expiresIn: "1h",
  });
};

userSchema.methods.generateRefreshToken = function () {
  return jwt.sign(
    { userId: this._id.toString(), jti: Date.now().toString() + Math.random().toString(36).slice(2) },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: "7d" }
  );
};

userSchema.methods.saveRefreshToken = async function (token) {
  this.refreshTokenHash = hashRefreshToken(token);
  return await this.save();
};

userSchema.methods.clearRefreshToken = async function () {
  this.refreshTokenHash = null;
  return await this.save();
};

// Exported so the refresh controller can hash the presented token and compare
// it in constant time.
userSchema.statics.hashRefreshToken = hashRefreshToken;

//middleware before saving new user,
//used async because bcrypt is time-consuming
userSchema.pre("save", async function () {
  if (!this.isModified("password")) {
    return;
  }
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  } catch (err) {
    console.error("Error hashing password:", err);
    throw err;
  }
});

module.exports = mongoose.model("users", userSchema);
