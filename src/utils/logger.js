/**
 * Logger - narzędzie do logowania
 *
 * Prosty system logowania oparty na winston
 */

const winston = require("winston");
const { format, transports } = winston;
const path = require("path");
const fs = require("fs");

// Utwórz katalog logów, jeśli nie istnieje
const logsDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Format dla logów konsoli
const consoleFormat = format.combine(
  format.colorize(),
  format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  format.printf(({ timestamp, level, message }) => {
    return `[${timestamp}] ${level}: ${message}`;
  })
);

// Format dla logów plików
const fileFormat = format.combine(
  format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  format.printf(({ timestamp, level, message }) => {
    return `[${timestamp}] ${level}: ${message}`;
  })
);

// Konfiguracja loggera
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(format.errors({ stack: true }), format.splat()),
  defaultMeta: { service: "binance-trading-bot" },
  transports: [
    // Logi do konsoli
    new transports.Console({
      format: consoleFormat,
    }),

    // Logi do pliku (wszystkie poziomy)
    new transports.File({
      filename: path.join(logsDir, "combined.log"),
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),

    // Logi błędów do osobnego pliku
    new transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  ],
});

// Eksportuj logger
module.exports = logger;
