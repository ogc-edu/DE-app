const simulations = require("../models/simulation");
const { sendSimulationJob } = require("../config/sqs");
const { parseImportFile } = require("../utils/importParser");
const logger = require("../config/logger");
const { ForbiddenError, NotFoundError } = require("../utils/errors");

const createSimulation = async (req, res, next) => {
  try {
    const { functions, methods, np, f, cr, gen, dim } = req.body;
    const userId = req.userId;
    const simulation = await simulations.createSimulation(
      userId,
      functions,
      methods,
      { np, f, cr, gen, dim }
    );

    // Enqueue one SQS job per created simulation so EC2 workers can pick it up.
    // Failure here must not 500 the create (the record exists) — log it and
    // mark the simulation failed so it never hangs in "pending".
    let queued = true;
    try {
      await sendSimulationJob(simulation);
    } catch (err) {
      queued = false;
      logger.error(`Failed to enqueue simulation ${simulation._id} to SQS: ${err.message}`);
      await simulations
        .findByIdAndUpdate(simulation._id, { status: "failed" })
        .catch((updateErr) =>
          logger.error(`Failed to mark simulation ${simulation._id} as failed: ${updateErr.message}`)
        );
    }

    res.status(201).json({
      message: queued
        ? "Simulation created successfully"
        : "Simulation created but failed to enqueue to the job queue",
      simulationId: simulation._id.toString(),
      queued,
    });
  } catch (err) {
    next(err);
  }
};

// Import a user-provided .txt results file as a completed simulation.
// The parser returns structured, line-numbered errors which are surfaced to
// the user (the "teach the user" requirement from import-format.md).
const importSimulation = async (req, res, next) => {
  try {
    const parsed = parseImportFile(req.body.content);
    if (!parsed.ok) {
      return res.status(400).json({
        success: false,
        message: "Import failed",
        errors: parsed.errors,
      });
    }

    const { params, simulationData } = parsed.data;

    // Derive the schema-required functions/methods arrays as the unique IDs
    // present in the imported rows (powers the Dashboard/History columns).
    const uniqueSorted = (ids) => [...new Set(ids)].sort((a, b) => a - b);
    const functions = uniqueSorted(simulationData.map((row) => row.functionId));
    const methods = {
      mutation: uniqueSorted(simulationData.map((row) => row.mutationId)),
      crossover: uniqueSorted(simulationData.map((row) => row.crossoverId)),
      selection: uniqueSorted(simulationData.map((row) => row.selectionId)),
    };

    const simulation = await simulations.importSimulation(req.userId, {
      functions,
      methods,
      simulationData,
      ...params,
    });

    res.status(201).json({
      message: "Data imported successfully",
      simulationId: simulation._id.toString(),
      totalModels: simulation.totalModels,
    });
  } catch (err) {
    next(err);
  }
};

const getAllSimulations = async (req, res, next) => {
  try {
    const userId = req.userId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 0;
    const status = req.query.status;

    const result = await simulations.getSimulation(userId, { page, limit, status });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
};

const deleteSimulation = async (req, res, next) => {
  try {
    const simulationId = req.params.simulationId;
    const userId = req.userId;
    const deletedSimulationId = await simulations.deleteSimulation(
      userId,
      simulationId
    );
    if (!deletedSimulationId) {
      throw new Error("Simulation delete failed");
    }
    res.status(200).json({
      message: "Simulation deleted successfully",
      simulationId: deletedSimulationId,
    });
  } catch (err) {
    next(err);
  }
};

const cancelSimulation = async (req, res, next) => {
  try {
    const simulationId = req.params.simulationId;
    const userId = req.userId;
    const cancelledSimulationId = await simulations.cancelSimulation(
      userId,
      simulationId
    );
    if (!cancelledSimulationId) {
      throw new Error("Simulation cancel failed");
    }
    res.status(200).json({
      message: "Simulation cancelled successfully",
      cancelledSimulationId,
    });
  } catch (err) {
    next(err);
  }
};

const getSingleSimulation = async (req, res, next) => {
  try {
    const simulationId = req.params.simulationId;
    const userId = req.userId;
    const simulation = await simulations.getSimulationById(simulationId);
    if (!simulation) {
      throw new NotFoundError("Simulation not found");
    }
    if (simulation.userId.toString() !== userId) {
      throw new ForbiddenError("user id not authorized to access this simulation");
    }
    res.status(200).json({ simulation });
  } catch (err) {
    next(err);
  }
};

const getSimulationResults = async (req, res, next) => {
  try {
    const simulationId = req.params.simulationId;
    const userId = req.userId;
    const simulation = await simulations.getSimulationById(simulationId);
    if (!simulation) {
      throw new NotFoundError("Simulation not found");
    }
    if (simulation.userId.toString() !== userId) {
      throw new ForbiddenError("user id not authorized to access this simulation");
    }
    res.status(200).json({
      simulationId: simulation._id,
      status: simulation.status,
      totalModels: simulation.totalModels,
      completedModels: simulation.completedModels,
      progress: simulation.progress,
      simulationData: simulation.simulationData,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createSimulation,
  importSimulation,
  getAllSimulations,
  deleteSimulation,
  cancelSimulation,
  getSingleSimulation,
  getSimulationResults,
};
