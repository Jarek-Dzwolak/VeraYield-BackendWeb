/**
 * Technical Analysis Utilities - narzędzia do analizy technicznej
 *
 * Zawiera funkcje do obliczania wskaźników technicznych:
 * - Kanał Hursta
 * - EMA (Exponential Moving Average)
 * - Wykrywanie przecięć
 */

const logger = require("./logger");

/**
 * Klasa do obliczania wykładniczej średniej ruchomej (EMA)
 */
class ExponentialMovingAverage {
  /**
   * Tworzy nowy obiekt EMA
   * @param {Object} options - Opcje konfiguracyjne
   * @param {number} options.periods - Liczba okresów (domyślnie: 30)
   */
  constructor(options = {}) {
    this.options = {
      periods: 30,
      ...options,
    };
    this.emaValue = null;
  }

  /**
   * Oblicza wartość EMA dla danych świecowych
   * @param {Array} candles - Tablica danych świecowych
   * @param {boolean} resetState - Czy zresetować stan EMA
   * @returns {number} - Wartość EMA
   */
  calculate(candles, resetState = false) {
    if (!candles || candles.length === 0) {
      logger.warn("Brak danych do obliczenia EMA");
      return null;
    }

    try {
      // Jeśli resetujemy stan lub nie mamy wartości EMA, oblicz od nowa
      if (resetState || this.emaValue === null) {
        // Potrzebujemy co najmniej 'periods' świec
        if (candles.length < this.options.periods) {
          logger.warn(
            `Za mało danych do obliczenia EMA (${candles.length}/${this.options.periods})`
          );
          return null;
        }

        // Inicjalizacja EMA jako SMA dla pierwszych 'periods' świec
        const initialCandles = candles.slice(0, this.options.periods);
        const closePrices = initialCandles.map((candle) => candle.close);
        const sma =
          closePrices.reduce((sum, price) => sum + price, 0) /
          closePrices.length;

        this.emaValue = sma;

        // Oblicz EMA dla pozostałych świec
        const remainingCandles = candles.slice(this.options.periods);
        for (const candle of remainingCandles) {
          this._updateEMA(candle.close);
        }
      } else {
        // Aktualizuj istniejącą wartość EMA o ostatnią świecę
        const lastCandle = candles[candles.length - 1];
        this._updateEMA(lastCandle.close);
      }

      return this.emaValue;
    } catch (error) {
      logger.error(`Błąd podczas obliczania EMA: ${error.message}`);
      return null;
    }
  }

  /**
   * Aktualizuje wartość EMA o nową cenę
   * @param {number} price - Nowa cena
   * @private
   */
  _updateEMA(price) {
    if (this.emaValue === null) {
      this.emaValue = price;
      return;
    }

    // Oblicz współczynnik wygładzania
    const multiplier = 2 / (this.options.periods + 1);

    // Aktualizuj EMA: EMA = Cena * k + EMA poprzednia * (1 - k)
    this.emaValue = price * multiplier + this.emaValue * (1 - multiplier);
  }
}

/**
 * Klasa implementująca kanał Hursta
 */
class HurstChannel {
  /**
   * Tworzy nowy kanał Hursta
   * @param {Object} options - Opcje konfiguracyjne
   * @param {number} options.periods - Liczba okresów do analizy (domyślnie: 25)
   * @param {number} options.upperDeviationFactor - Współczynnik odchylenia dla górnej bandy (domyślnie: 2.0)
   * @param {number} options.lowerDeviationFactor - Współczynnik odchylenia dla dolnej bandy (domyślnie: 2.0)
   */
  constructor(options = {}) {
    this.options = {
      periods: 25,
      upperDeviationFactor: 2.0,
      lowerDeviationFactor: 2.0,
      ...options,
    };
  }

  /**
   * Oblicza kanał Hursta dla danych świecowych
   * @param {Array} candles - Tablica danych świecowych
   * @returns {Object} - Obiekt z parametrami kanału Hursta
   */
  calculate(candles) {
    if (!candles || candles.length < this.options.periods) {
      logger.warn(
        `Za mało danych do obliczenia kanału Hursta (${candles ? candles.length : 0}/${this.options.periods})`
      );
      return null;
    }

    try {
      // Użyj tylko wymaganej liczby ostatnich świec
      const relevantCandles = candles.slice(-this.options.periods);

      // Pobierz ceny zamknięcia
      const closePrices = relevantCandles.map((candle) => candle.close);

      // Oblicz logarytmiczne zmiany cen
      const logReturns = [];
      for (let i = 1; i < closePrices.length; i++) {
        logReturns.push(Math.log(closePrices[i] / closePrices[i - 1]));
      }

      // Oblicz wykładnik Hursta za pomocą metody przeskalowanego zakresu (R/S)
      const hurstExponent = this._calculateHurstExponent(logReturns);

      // Oblicz średnią cenę i odchylenie standardowe
      const mean = this._calculateMean(closePrices);
      const stdDev = this._calculateStandardDeviation(closePrices, mean);

      // PRAWDZIWY KANAŁ HURSTA - wykładnik jako mnożnik bazowych szerokości
      const adaptiveUpperFactor =
        this.options.upperDeviationFactor * hurstExponent;
      const adaptiveLowerFactor =
        this.options.lowerDeviationFactor * hurstExponent;

      const upperBand = mean + adaptiveUpperFactor * stdDev;
      const lowerBand = mean - adaptiveLowerFactor * stdDev;

      // Oblicz nachylenie kanału (trend)
      const trend = this._calculateTrend(relevantCandles);

      // Zwróć wyniki z dodatkowymi informacjami o adaptacyjności
      return {
        upperBand,
        middleBand: mean,
        lowerBand,
        hurstExponent,
        stdDev,
        trend,
        lastClose: closePrices[closePrices.length - 1],
        lastCandle: relevantCandles[relevantCandles.length - 1],
        timestamp: new Date().getTime(),
        // Dodatkowe informacje diagnostyczne
        adaptiveUpperFactor,
        adaptiveLowerFactor,
        originalUpperFactor: this.options.upperDeviationFactor,
        originalLowerFactor: this.options.lowerDeviationFactor,
      };
    } catch (error) {
      logger.error(`Błąd podczas obliczania kanału Hursta: ${error.message}`);
      return null;
    }
  }

  /**
   * Oblicza wykładnik Hursta za pomocą metody przeskalowanego zakresu (R/S)
   * @param {Array} logReturns - Tablica logarytmicznych zmian cen
   * @returns {number} - Wykładnik Hursta
   * @private
   */
  _calculateHurstExponent(logReturns) {
    if (logReturns.length < 10) {
      return 0.5; // Domyślna wartość dla zbyt małej liczby danych
    }

    try {
      // Implementacja metody przeskalowanego zakresu (R/S)
      // Podziel szereg czasowy na kilka podszeregów
      const n = logReturns.length;
      const divisions = [
        10,
        Math.floor(n / 8),
        Math.floor(n / 4),
        Math.floor(n / 2),
      ];
      const validDivisions = divisions.filter((d) => d > 0 && d < n / 2);

      const rsValues = [];
      const divisionLengths = [];

      for (const m of validDivisions) {
        const numDivisions = Math.floor(n / m);
        let avgRS = 0;

        for (let i = 0; i < numDivisions; i++) {
          const segment = logReturns.slice(i * m, (i + 1) * m);

          // Średnia segmentu
          const segmentMean = this._calculateMean(segment);

          // Odchylenia od średniej
          const deviations = segment.map((value) => value - segmentMean);

          // Skumulowane odchylenia
          const cumulativeDeviations = [];
          let sum = 0;
          for (const dev of deviations) {
            sum += dev;
            cumulativeDeviations.push(sum);
          }

          // Zakres (R)
          const range =
            Math.max(...cumulativeDeviations) -
            Math.min(...cumulativeDeviations);

          // Odchylenie standardowe (S)
          const stdDev = this._calculateStandardDeviation(segment, segmentMean);

          // R/S
          const rs = stdDev === 0 ? 1 : range / stdDev;
          avgRS += rs;
        }

        // Średnie R/S dla danej długości podziału
        avgRS /= numDivisions;

        rsValues.push(Math.log(avgRS));
        divisionLengths.push(Math.log(m));
      }

      // Regresja liniowa dla log(R/S) vs log(n)
      const slope = this._linearRegression(divisionLengths, rsValues);

      return slope;
    } catch (error) {
      logger.error(
        `Błąd podczas obliczania wykładnika Hursta: ${error.message}`
      );
      return 0.5; // Wartość domyślna w przypadku błędu
    }
  }

  /**
   * Wykonuje regresję liniową dla danych
   * @param {Array} x - Tablica wartości x
   * @param {Array} y - Tablica wartości y
   * @returns {number} - Współczynnik nachylenia (slope)
   * @private
   */
  _linearRegression(x, y) {
    if (x.length !== y.length || x.length === 0) {
      return 0;
    }

    const n = x.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;

    for (let i = 0; i < n; i++) {
      sumX += x[i];
      sumY += y[i];
      sumXY += x[i] * y[i];
      sumXX += x[i] * x[i];
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    return slope;
  }

  /**
   * Oblicza średnią arytmetyczną tablicy liczb
   * @param {Array} values - Tablica liczb
   * @returns {number} - Średnia arytmetyczna
   * @private
   */
  _calculateMean(values) {
    if (!values || values.length === 0) {
      return 0;
    }

    const sum = values.reduce((total, value) => total + value, 0);
    return sum / values.length;
  }

  /**
   * Oblicza odchylenie standardowe tablicy liczb
   * @param {Array} values - Tablica liczb
   * @param {number} mean - Średnia arytmetyczna (opcjonalnie)
   * @returns {number} - Odchylenie standardowe
   * @private
   */
  _calculateStandardDeviation(values, mean = null) {
    if (!values || values.length === 0) {
      return 0;
    }

    const avg = mean !== null ? mean : this._calculateMean(values);
    const squaredDiffs = values.map((value) => Math.pow(value - avg, 2));
    const variance = this._calculateMean(squaredDiffs);

    return Math.sqrt(variance);
  }

  /**
   * Oblicza trend na podstawie danych świecowych
   * @param {Array} candles - Tablica danych świecowych
   * @returns {string} - Kierunek trendu ('up', 'down', 'sideways')
   * @private
   */
  _calculateTrend(candles) {
    if (!candles || candles.length < 2) {
      return "sideways";
    }

    // Podziel dane na dwie połowy
    const half = Math.floor(candles.length / 2);
    const firstHalf = candles.slice(0, half);
    const secondHalf = candles.slice(half);

    // Oblicz średnie ceny zamknięcia dla obu połów
    const firstHalfAvg = this._calculateMean(firstHalf.map((c) => c.close));
    const secondHalfAvg = this._calculateMean(secondHalf.map((c) => c.close));

    // Określ trend na podstawie różnicy średnich
    const diff = secondHalfAvg - firstHalfAvg;
    const threshold = firstHalfAvg * 0.01; // 1% próg dla określenia trendu

    if (diff > threshold) {
      return "up";
    } else if (diff < -threshold) {
      return "down";
    } else {
      return "sideways";
    }
  }
}

/**
 * Klasa do wykrywania przecięć linii
 */
class CrossDetector {
  /**
   * Wykrywa przecięcie linii ceny z określonym poziomem
   * @param {number} previousPrice - Poprzednia cena
   * @param {number} currentPrice - Aktualna cena
   * @param {number} level - Poziom do sprawdzenia przecięcia
   * @returns {Object|null} - Informacje o przecięciu lub null, jeśli nie wykryto
   */
  static detectLevelCross(previousPrice, currentPrice, level) {
    // Sprawdź, czy nastąpiło przecięcie z góry na dół
    if (previousPrice > level && currentPrice <= level) {
      return {
        direction: "down",
        level,
        previousPrice,
        currentPrice,
        timestamp: new Date().getTime(),
      };
    }

    // Sprawdź, czy nastąpiło przecięcie z dołu do góry
    if (previousPrice < level && currentPrice >= level) {
      return {
        direction: "up",
        level,
        previousPrice,
        currentPrice,
        timestamp: new Date().getTime(),
      };
    }

    return null;
  }

  /**
   * Wykrywa dotknięcie dolnej bandy kanału Hursta (używane dla sygnałów wejścia)
   * @param {number} currentLow - Najniższa cena bieżącej świecy
   * @param {number} currentHigh - Najwyższa cena bieżącej świecy
   * @param {number} lowerBand - Poziom dolnej bandy
   * @param {number} previousLow - Najniższa cena poprzedniej świecy (opcjonalnie)
   * @param {number} touchTolerance - Tolerancja dotknięcia (opcjonalnie, domyślnie 0.05%)
   * @returns {boolean} - Czy nastąpiło dotknięcie dolnej bandy
   */
  static detectLowerBandTouch(
    currentLow,
    currentHigh,
    lowerBand,
    previousLow = null,
    touchTolerance = 0.0005
  ) {
    // Oblicz dolną bandę z tolerancją
    const lowerBandWithTolerance = lowerBand * (1 + touchTolerance);

    // Sprawdź, czy cena przecina dolną bandę (low jest poniżej, ale high jest powyżej)
    const touchesLowerBand =
      currentLow <= lowerBandWithTolerance && currentHigh >= lowerBand;

    // Jeśli mamy dostępną poprzednią cenę, sprawdź, czy to nowe przecięcie
    if (previousLow !== null && touchesLowerBand) {
      // Sprawdź, czy poprzednia świeca nie przecięła już bandy,
      // lub przecięła ją tylko trochę (z mniejszą tolerancją)
      return (
        previousLow > lowerBand ||
        Math.abs(previousLow - lowerBand) < lowerBand * touchTolerance * 0.5
      );
    }

    return touchesLowerBand;
  }

  /**
   * Wykrywa przecięcie górnej bandy kanału Hursta w dół (używane dla sygnałów wyjścia)
   * @param {number} currentLow - Najniższa cena bieżącej świecy
   * @param {number} currentPrice - Cena zamknięcia bieżącej świecy
   * @param {number} previousPrice - Cena zamknięcia poprzedniej świecy
   * @param {number} upperBand - Poziom górnej bandy
   * @returns {boolean} - Czy nastąpiło przecięcie górnej bandy w dół
   */
  static detectUpperBandCrossDown(
    currentLow,
    currentPrice,
    previousPrice,
    upperBand
  ) {
    // Sprawdź warunek z backtestingowej strategii:
    // Low jest poniżej górnej bandy,
    // cena zamknięcia jest poniżej górnej bandy,
    // poprzednia cena zamknięcia była powyżej górnej bandy
    return (
      currentLow <= upperBand &&
      currentPrice <= upperBand &&
      previousPrice > upperBand
    );
  }

  /**
   * Sprawdza czy trailing stop został aktywowany
   * @param {number} highestPrice - Najwyższa osiągnięta cena
   * @param {number} currentPrice - Aktualna cena
   * @param {number} trailingStopPercent - Procent trailing stopu (jako ułamek, np. 0.03 dla 3%)
   * @returns {boolean} - Czy trailing stop został aktywowany
   */
  static isTrailingStopActivated(
    highestPrice,
    currentPrice,
    trailingStopPercent
  ) {
    // Oblicz spadek od najwyższej ceny
    const dropFromHigh = (highestPrice - currentPrice) / highestPrice;

    // Sprawdź, czy spadek przekroczył trailing stop
    return dropFromHigh >= trailingStopPercent;
  }

  /**
   * Wykrywa przecięcie dwóch linii
   * @param {number} previousLine1 - Poprzednia wartość linii 1
   * @param {number} currentLine1 - Aktualna wartość linii 1
   * @param {number} previousLine2 - Poprzednia wartość linii 2
   * @param {number} currentLine2 - Aktualna wartość linii 2
   * @returns {Object|null} - Informacje o przecięciu lub null, jeśli nie wykryto
   */
  static detectLineCross(
    previousLine1,
    currentLine1,
    previousLine2,
    currentLine2
  ) {
    // Sprawdź, czy linia 1 przecięła linię 2 z góry na dół
    if (previousLine1 > previousLine2 && currentLine1 <= currentLine2) {
      return {
        direction: "down",
        line1: {
          previous: previousLine1,
          current: currentLine1,
        },
        line2: {
          previous: previousLine2,
          current: currentLine2,
        },
        timestamp: new Date().getTime(),
      };
    }

    // Sprawdź, czy linia 1 przecięła linię 2 z dołu do góry
    if (previousLine1 < previousLine2 && currentLine1 >= currentLine2) {
      return {
        direction: "up",
        line1: {
          previous: previousLine1,
          current: currentLine1,
        },
        line2: {
          previous: previousLine2,
          current: currentLine2,
        },
        timestamp: new Date().getTime(),
      };
    }

    return null;
  }

  /**
   * Wykrywa przecięcie linii ceny z bandą kanału Hursta
   * @param {number} previousPrice - Poprzednia cena
   * @param {number} currentPrice - Aktualna cena
   * @param {Object} hurstChannel - Obiekt kanału Hursta
   * @param {string} band - Banda do sprawdzenia ('upper', 'middle', 'lower')
   * @returns {Object|null} - Informacje o przecięciu lub null, jeśli nie wykryto
   */
  static detectHurstBandCross(previousPrice, currentPrice, hurstChannel, band) {
    if (!hurstChannel) {
      return null;
    }

    let level;

    // Wybierz odpowiednią bandę
    switch (band) {
      case "upper":
        level = hurstChannel.upperBand;
        break;
      case "middle":
        level = hurstChannel.middleBand;
        break;
      case "lower":
        level = hurstChannel.lowerBand;
        break;
      default:
        return null;
    }

    return this.detectLevelCross(previousPrice, currentPrice, level);
  }
}

// Eksportuj klasy
module.exports = {
  HurstChannel,
  ExponentialMovingAverage,
  CrossDetector,
};
