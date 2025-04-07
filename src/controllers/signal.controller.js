/**
 * Signal Controller - kontroler sygnałów handlowych
 *
 * Odpowiedzialny za:
 * - Pobieranie sygnałów handlowych
 * - Filtrowanie i sortowanie sygnałów
 * - Generowanie statystyk sygnałów
 */

const signalService = require("../services/signal.service");
const instanceService = require("../services/instance.service");
const Signal = require("../models/signal.model");
const logger = require("../utils/logger");
const { validateSignalFilters } = require("../utils/validators");
const fs = require("fs");
const path = require("path");

/**
 * Pobiera wszystkie sygnały z opcjonalnym filtrowaniem
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getAllSignals = async (req, res) => {
  try {
    const {
      type,
      symbol,
      instanceId,
      startDate,
      endDate,
      limit = 100,
      skip = 0,
    } = req.query;

    // Przygotuj filtry
    const filters = {};

    if (type && type !== "all") {
      filters.type = type;
    }

    if (symbol) {
      filters.symbol = symbol.toUpperCase();
    }

    if (instanceId) {
      filters.instanceId = instanceId;
    }

    // Filtrowanie po datach
    if (startDate || endDate) {
      filters.timestamp = {};

      if (startDate) {
        filters.timestamp.$gte = new Date(startDate).getTime();
      }

      if (endDate) {
        filters.timestamp.$lte = new Date(endDate).getTime();
      }
    }

    // Pobierz sygnały z bazy danych
    const signals = await signalService.getSignalsFromDb(
      filters,
      parseInt(limit),
      parseInt(skip)
    );

    // Pobierz całkowitą liczbę sygnałów (dla paginacji)
    const total = await Signal.countDocuments(filters);

    res.json({
      total,
      count: signals.length,
      page: Math.floor(skip / limit) + 1,
      totalPages: Math.ceil(total / limit),
      signals,
    });
  } catch (error) {
    logger.error(`Błąd podczas pobierania sygnałów: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching signals",
    });
  }
};

/**
 * Pobiera sygnały dla konkretnej instancji
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getSignalsByInstance = async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { type, limit = 100, skip = 0 } = req.query;

    // Sprawdź, czy instancja istnieje
    const instance = await instanceService.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found",
      });
    }

    // Przygotuj filtry
    const filters = { instanceId };

    if (type && type !== "all") {
      filters.type = type;
    }

    // Pobierz sygnały z bazy danych
    const signals = await signalService.getSignalsFromDb(
      filters,
      parseInt(limit),
      parseInt(skip)
    );

    // Pobierz całkowitą liczbę sygnałów (dla paginacji)
    const total = await Signal.countDocuments(filters);

    res.json({
      instanceId,
      instanceName: instance.name,
      total,
      count: signals.length,
      page: Math.floor(skip / limit) + 1,
      totalPages: Math.ceil(total / limit),
      signals,
    });
  } catch (error) {
    logger.error(
      `Błąd podczas pobierania sygnałów instancji: ${error.message}`
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching instance signals",
    });
  }
};

/**
 * Pobiera konkretny sygnał po ID
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getSignalById = async (req, res) => {
  try {
    const { signalId } = req.params;

    // Pobierz sygnał z bazy danych
    const signal = await Signal.findById(signalId);

    if (!signal) {
      return res.status(404).json({
        error: "Not Found",
        message: "Signal not found",
      });
    }

    res.json(signal);
  } catch (error) {
    logger.error(`Błąd podczas pobierania sygnału: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching signal",
    });
  }
};

/**
 * Pobiera statystyki sygnałów
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getSignalStats = async (req, res) => {
  try {
    // Pobierz statystyki sygnałów
    const stats = await signalService.getSignalStats();

    res.json(stats);
  } catch (error) {
    logger.error(
      `Błąd podczas pobierania statystyk sygnałów: ${error.message}`
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching signal statistics",
    });
  }
};

/**
 * Pobiera statystyki sygnałów dla konkretnej instancji
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getSignalStatsByInstance = async (req, res) => {
  try {
    const { instanceId } = req.params;

    // Sprawdź, czy instancja istnieje
    const instance = await instanceService.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found",
      });
    }

    // Pobierz statystyki sygnałów dla instancji
    const stats = await signalService.getSignalStats(instanceId);

    res.json({
      instanceId,
      instanceName: instance.name,
      ...stats,
    });
  } catch (error) {
    logger.error(
      `Błąd podczas pobierania statystyk sygnałów instancji: ${error.message}`
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching instance signal statistics",
    });
  }
};

/**
 * Pobiera aktywne pozycje
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getActivePositions = async (req, res) => {
  try {
    const { instanceId } = req.query;

    // Pobierz aktywne pozycje
    const positions = signalService.getActivePositions(instanceId || null);

    res.json({
      count: Array.isArray(positions) ? positions.length : positions ? 1 : 0,
      positions: positions || [],
    });
  } catch (error) {
    logger.error(`Błąd podczas pobierania aktywnych pozycji: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching active positions",
    });
  }
};

/**
 * Pobiera historię pozycji
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getPositionHistory = async (req, res) => {
  try {
    const { instanceId, limit = 100 } = req.query;

    // Pobierz historię pozycji
    let history = signalService.getPositionHistory(instanceId || null);

    // Ogranicz liczbę wyników
    if (history.length > parseInt(limit)) {
      history = history.slice(0, parseInt(limit));
    }

    res.json({
      count: history.length,
      history,
    });
  } catch (error) {
    logger.error(`Błąd podczas pobierania historii pozycji: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching position history",
    });
  }
};

/**
 * Pobiera sygnały wejścia
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getEntrySignals = async (req, res) => {
  try {
    const { symbol, instanceId, limit = 100, skip = 0 } = req.query;

    // Przygotuj filtry
    const filters = { type: "entry" };

    if (symbol) {
      filters.symbol = symbol.toUpperCase();
    }

    if (instanceId) {
      filters.instanceId = instanceId;
    }

    // Pobierz sygnały z bazy danych
    const signals = await signalService.getSignalsFromDb(
      filters,
      parseInt(limit),
      parseInt(skip)
    );

    // Pobierz całkowitą liczbę sygnałów (dla paginacji)
    const total = await Signal.countDocuments(filters);

    res.json({
      total,
      count: signals.length,
      page: Math.floor(skip / limit) + 1,
      totalPages: Math.ceil(total / limit),
      signals,
    });
  } catch (error) {
    logger.error(`Błąd podczas pobierania sygnałów wejścia: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching entry signals",
    });
  }
};

/**
 * Pobiera sygnały wyjścia
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getExitSignals = async (req, res) => {
  try {
    const { symbol, instanceId, limit = 100, skip = 0 } = req.query;

    // Przygotuj filtry
    const filters = { type: "exit" };

    if (symbol) {
      filters.symbol = symbol.toUpperCase();
    }

    if (instanceId) {
      filters.instanceId = instanceId;
    }

    // Pobierz sygnały z bazy danych
    const signals = await signalService.getSignalsFromDb(
      filters,
      parseInt(limit),
      parseInt(skip)
    );

    // Pobierz całkowitą liczbę sygnałów (dla paginacji)
    const total = await Signal.countDocuments(filters);

    res.json({
      total,
      count: signals.length,
      page: Math.floor(skip / limit) + 1,
      totalPages: Math.ceil(total / limit),
      signals,
    });
  } catch (error) {
    logger.error(`Błąd podczas pobierania sygnałów wyjścia: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching exit signals",
    });
  }
};

/**
 * Pobiera najnowsze sygnały
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getLatestSignals = async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    // Pobierz najnowsze sygnały z bazy danych
    const signals = await signalService.getSignalsFromDb(
      {},
      parseInt(limit),
      0
    );

    res.json({
      count: signals.length,
      signals,
    });
  } catch (error) {
    logger.error(
      `Błąd podczas pobierania najnowszych sygnałów: ${error.message}`
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching latest signals",
    });
  }
};

/**
 * Czyści historię sygnałów dla instancji
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const clearSignalHistory = async (req, res) => {
  try {
    const { instanceId } = req.params;

    // Sprawdź, czy instancja istnieje
    const instance = await instanceService.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found",
      });
    }

    // Wyczyść historię sygnałów
    const deletedCount = await signalService.clearSignalHistory(instanceId);

    res.json({
      message: `Signal history for instance ${instanceId} cleared successfully`,
      deletedCount,
    });
  } catch (error) {
    logger.error(
      `Błąd podczas czyszczenia historii sygnałów: ${error.message}`
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while clearing signal history",
    });
  }
};

/**
 * Eksportuje sygnały do pliku CSV
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const exportSignalsToCSV = async (req, res) => {
  try {
    const { type, symbol, instanceId, startDate, endDate } = req.query;

    // Przygotuj filtry
    const filters = {};

    if (type && type !== "all") {
      filters.type = type;
    }

    if (symbol) {
      filters.symbol = symbol.toUpperCase();
    }

    if (instanceId) {
      filters.instanceId = instanceId;
    }

    // Filtrowanie po datach
    if (startDate || endDate) {
      filters.timestamp = {};

      if (startDate) {
        filters.timestamp.$gte = new Date(startDate).getTime();
      }

      if (endDate) {
        filters.timestamp.$lte = new Date(endDate).getTime();
      }
    }

    // Pobierz sygnały z bazy danych (bez limitu)
    const signals = await signalService.getSignalsFromDb(filters, 9999, 0);

    if (signals.length === 0) {
      return res.status(404).json({
        error: "Not Found",
        message: "No signals found matching the criteria",
      });
    }

    // Utwórz nagłówki CSV
    const headers = [
      "ID",
      "Instance ID",
      "Symbol",
      "Type",
      "SubType",
      "Price",
      "Allocation",
      "Profit %",
      "Timestamp",
      "Date",
    ];

    // Utwórz wiersze CSV
    const rows = signals.map((signal) => [
      signal._id,
      signal.instanceId,
      signal.symbol,
      signal.type,
      signal.subType,
      signal.price,
      signal.allocation || "",
      signal.profitPercent || "",
      signal.timestamp,
      new Date(signal.timestamp).toISOString(),
    ]);

    // Połącz nagłówki i wiersze
    const csvContent = [
      headers.join(","),
      ...rows.map((row) => row.join(",")),
    ].join("\n");

    // Ustaw nagłówki odpowiedzi
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=signals.csv");

    // Wyślij zawartość CSV
    res.send(csvContent);
  } catch (error) {
    logger.error(
      `Błąd podczas eksportowania sygnałów do CSV: ${error.message}`
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while exporting signals to CSV",
    });
  }
};

/**
 * Pobiera sygnały z określonego zakresu dat
 * @param {Object} req - Obiekt żądania
 * @param {Object} res - Obiekt odpowiedzi
 */
const getSignalsByDateRange = async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      type,
      symbol,
      instanceId,
      limit = 100,
      skip = 0,
    } = req.query;

    // Sprawdź, czy daty są podane
    if (!startDate || !endDate) {
      return res.status(400).json({
        error: "Validation Error",
        message: "Start date and end date are required",
      });
    }

    // Przygotuj filtry
    const filters = {
      timestamp: {
        $gte: new Date(startDate).getTime(),
        $lte: new Date(endDate).getTime(),
      },
    };

    if (type && type !== "all") {
      filters.type = type;
    }

    if (symbol) {
      filters.symbol = symbol.toUpperCase();
    }

    if (instanceId) {
      filters.instanceId = instanceId;
    }

    // Pobierz sygnały z bazy danych
    const signals = await signalService.getSignalsFromDb(
      filters,
      parseInt(limit),
      parseInt(skip)
    );

    // Pobierz całkowitą liczbę sygnałów (dla paginacji)
    const total = await Signal.countDocuments(filters);

    res.json({
      startDate,
      endDate,
      total,
      count: signals.length,
      page: Math.floor(skip / limit) + 1,
      totalPages: Math.ceil(total / limit),
      signals,
    });
  } catch (error) {
    logger.error(
      `Błąd podczas pobierania sygnałów z zakresu dat: ${error.message}`
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching signals by date range",
    });
  }
};

/**
 * Testowy endpoint do generowania sygnału wejścia
 */
const testEntrySignal = async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { price = 70000 } = req.body;

    // Sprawdź, czy instancja istnieje
    const instance = await instanceService.getInstance(instanceId);
    if (!instance) {
      return res.status(404).json({
        error: "Not Found",
        message: "Instance not found",
      });
    }

    // Wygeneruj testowy sygnał wejścia
    signalService.processEntrySignal({
      instanceId,
      type: "lowerBandTouch",
      price: price,
      timestamp: Date.now(),
      trend: "up",
    });

    res.json({
      success: true,
      message: "Test entry signal processed",
      instanceId,
      price,
    });
  } catch (error) {
    logger.error(`Błąd podczas testowego sygnału wejścia: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Testowy endpoint do generowania sygnału wyjścia
 */
const testExitSignal = async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { price = 75000 } = req.body;

    // Pobierz aktualną pozycję
    const activePosition = signalService.getActivePositions(instanceId);

    if (
      !activePosition ||
      !activePosition.entries ||
      activePosition.entries.length === 0
    ) {
      return res.status(400).json({
        error: "No active position",
        message: "Nie znaleziono aktywnej pozycji dla tej instancji",
      });
    }

    logger.info(
      `Używam pozycji z pamięci RAM: ${JSON.stringify(activePosition)}`
    );

    // Użyj ID pozycji zamiast konkretnego ID sygnału wejścia
    const positionId = activePosition.positionId || `position-${instanceId}`;

    // Wygeneruj testowy sygnał wyjścia z ID pozycji
    const result = await signalService.processExitSignal({
      instanceId,
      type: "upperBandCrossDown",
      price: price,
      timestamp: Date.now(),
      positionId: positionId,
    });

    res.json({
      success: true,
      message: "Test exit signal processed",
      instanceId,
      price,
      positionId,
    });
  } catch (error) {
    logger.error(`Błąd podczas testowego sygnału wyjścia: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getAllSignals,
  getSignalsByInstance,
  getSignalById,
  getSignalStats,
  getSignalStatsByInstance,
  getActivePositions,
  getPositionHistory,
  getEntrySignals,
  getExitSignals,
  getLatestSignals,
  clearSignalHistory,
  exportSignalsToCSV,
  getSignalsByDateRange,
  // Testowe endpointy
  testEntrySignal, // DODANE
  testExitSignal, // DODANE
};
