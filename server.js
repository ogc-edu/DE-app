require("dotenv").config();
const app = require("./app");
const logger = require("./config/logger");

const port = process.env.PORT || 3000;

const startServer = () => {
  app.listen(port, () => {
    logger.info(`Server is running on port ${port}`);
    logger.info(`Environment: ${process.env.NODE_ENV || "development"}`);
  });
};

process.on("SIGTERM", async () => {
  logger.info("SIGTERM signal received: closing HTTP server");
  process.exit(0);
});

startServer();
