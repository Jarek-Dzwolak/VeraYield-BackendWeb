/**
 * Logger - narzędzie do logowania
 *
 * Prosty system logowania oparty na winston
 * Dostosowany do pracy na Railway (logi tylko w konsoli w produkcji)
 */

const winston = require("winston");
const { format, transports } = winston;
const path = require("path");
const fs = require("fs");

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

// Przygotuj transporty w zależności od środowiska
const loggerTransports = [
  // Logi do konsoli zawsze aktywne
  new transports.Console({
    format: consoleFormat,
  }),
];

// W środowisku deweloperskim dodajemy logi do plików
if (process.env.NODE_ENV !== "production") {
  // Utwórz katalog logów, jeśli nie istnieje (tylko w dev)
  const logsDir = path.join(process.cwd(), "logs");
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
  }

  // Dodaj transporty dla plików
  loggerTransports.push(
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
    })
  );
}

// Konfiguracja loggera
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(format.errors({ stack: true }), format.splat()),
  defaultMeta: { service: "binance-trading-bot" },
  transports: loggerTransports,
});

// Eksportuj logger
module.exports = logger;
