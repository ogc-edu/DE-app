const User = require("../models/user");
const Simulation = require("../models/simulation");
const sqsConfig = require("../config/sqs");

const getAllUsers = async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const cursor = req.query.cursor || undefined;

    const { users, nextCursor } = await User.listAll({ limit, cursor });

    res.status(200).json({ users, nextCursor });
  } catch (err) {
    next(err);
  }
};

const getUserById = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(200).json({ user: User.toSafeUser(user) });
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

    const isActive = !user.isActive;
    // Suspending ends existing sessions; reactivation requires a fresh login.
    const updated = await User.setActive(userId, isActive);

    res.status(200).json({
      message: `User ${isActive ? "activated" : "suspended"} successfully`,
      userId: user.userId,
      isActive: updated ? updated.isActive : isActive,
    });
  } catch (err) {
    next(err);
  }
};

const getAllSimulations = async (req, res, next) => {
  try {
    const { userId } = req.query;
    const limit = parseInt(req.query.limit) || 50;
    const cursor = req.query.cursor || undefined;

    const { simulations, nextCursor } = await Simulation.listAll({
      limit,
      cursor,
      userId,
    });

    res.status(200).json({
      simulationCount: simulations.length,
      simulations,
      nextCursor,
    });
  } catch (err) {
    next(err);
  }
};

const deleteAnySimulation = async (req, res, next) => {
  try {
    const simulation = await Simulation.getSimulationById(req.params.id);
    if (!simulation) {
      return res.status(404).json({ message: "Simulation not found" });
    }
    await Simulation.deleteSimulationById(req.params.id);
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
