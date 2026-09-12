const User = require("../models/user");
const Simulation = require("../models/simulation");
const sqsConfig = require("../config/sqs");

const getAllUsers = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const users = await User.find()
      .select("-refreshTokenHash")
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });
    const total = await User.countDocuments();

    res.status(200).json({
      userCount: total,
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      users,
    });
  } catch (err) {
    next(err);
  }
};

const getUserById = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select("-refreshTokenHash -password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
};

const toggleSuspendUser = async (req, res, next) => {
  try {
    const userId = req.params.id;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    if (user.role === "admin") {
      return res.status(400).json({ message: "Cannot suspend an admin user" });
    }

    // Suspending ends existing sessions; reactivation requires a fresh login.
    if (user.isActive) {
      user.refreshTokenHash = null;
    }
    user.isActive = !user.isActive;
    await user.save();

    res.status(200).json({
      message: `User ${user.isActive ? "activated" : "suspended"} successfully`,
      userId: user._id.toString(),
      isActive: user.isActive,
    });
  } catch (err) {
    next(err);
  }
};

const getAllSimulations = async (req, res, next) => {
  try {
    const { userId } = req.query;
    const filter = userId ? { userId } : {};
    const simulations = await Simulation.find(filter).sort({ createdAt: -1 });

    res.status(200).json({
      simulationCount: simulations.length,
      simulations,
    });
  } catch (err) {
    next(err);
  }
};

const deleteAnySimulation = async (req, res, next) => {
  try {
    const simulation = await Simulation.findById(req.params.id);
    if (!simulation) {
      return res.status(404).json({ message: "Simulation not found" });
    }
    await Simulation.findByIdAndDelete(req.params.id);
    res.status(200).json({
      message: "Simulation deleted successfully",
      simulationId: req.params.id,
    });
  } catch (err) {
    next(err);
  }
};

const getQueueStatus = async (req, res, next) => {
  try {
    const queue = await sqsConfig.getQueueStatus();
    res.status(200).json({ queue });
  } catch (err) {
    if (err.message === "SQS_QUEUE_URL is not configured") {
      return res.status(503).json({
        message: "SQS queue not configured (SQS_QUEUE_URL missing)",
        queue: null,
      });
    }
    next(err);
  }
};

module.exports = {
  getAllUsers,
  getUserById,
  toggleSuspendUser,
  getAllSimulations,
  deleteAnySimulation,
  getQueueStatus,
};
