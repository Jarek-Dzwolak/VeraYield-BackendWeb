# Dokumentacja Projektu: Binance Trading Bot

## Cel Projektu

Stworzenie backendu dla automatycznego systemu tradingowego, który analizuje rynek kryptowalut, identyfikuje sygnały oparte na określonych wskaźnikach technicznych i podejmuje decyzje handlowe w czasie rzeczywistym. System ma umożliwiać równoległe uruchamianie wielu instancji z różnymi parametrami i dla różnych kont.

## Główne Założenia

1. **Analiza techniczna w czasie rzeczywistym**:

   - Obserwacja ruchu cen przez WebSockety Binance
   - Obliczanie kanału Hursta na danych 15-minutowych (25 okresów)
   - Wyznaczanie linii trendu z EMA(30) na świecach godzinowych
   - Generowanie sygnałów na podstawie przecięć linii ceny z określonymi wskaźnikami

2. **Architektura danych**:

   - Inicjalizacja z historycznymi danymi pobranymi przez REST API
   - Przełączenie na dane strumieniowe WebSocket po inicjalizacji
   - Utrzymywanie połączenia WebSocket poprzez regularne wysyłanie pingów (co 30 minut)

3. **Zarządzanie danymi**:
   - Przechowywanie sygnałów i historycznych danych w MongoDB
   - Przechowywanie 25 okresów dla kalkulacji kanału Hursta
   - Przechowywanie 90-100 okresów dla kalkulacji EMA na godzinówkach

## Kluczowe Komponenty

1. **Binance Integration**:

   - Połączenie z WebSocketami Binance
   - Pobieranie danych historycznych przez REST API
   - Obsługa pingów dla utrzymania połączenia

2. **Analiza Techniczna**:

   - Implementacja kanału Hursta dla interwału 15-minutowego
   - Implementacja EMA(30) dla interwału godzinowego
   - System wykrywania przecięć linii ceny z wyznaczonymi wskaźnikami

3. **Zarządzanie Sygnałami**:

   - Generowanie sygnałów w czasie rzeczywistym
   - Filtrowanie fałszywych sygnałów
   - Przechowywanie sygnałów w bazie danych

4. **Backend API**:
   - Endpoints do zarządzania ustawieniami
   - Dostęp do historycznych sygnałów
   - Podgląd bieżących danych i wskaźników

## Szczegóły Techniczne

### Źródła Danych

- **Inicjalizacja**: REST API Binance
- **Dane strumieniowe**: WebSocket Binance
- **Częstotliwość pingów**: 30 minut

### Wskaźniki Techniczne

1. **Kanał Hursta**:

   - Dane źródłowe: 25 okresów 15-minutowych
   - Aktualizacja: po zamknięciu każdej nowej świecy 15-minutowej

2. **Linia Trendu (EMA)**:
   - Typ: EMA(30) na danych godzinowych
   - Dane źródłowe: 90-100 okresów godzinowych
   - Aktualizacja: po zamknięciu każdej nowej świecy godzinowej

### Strategia Handlowa

#### Warunki wejścia w pozycję:

1. **Pierwsze wejście** (10% kapitału):

   - Następuje gdy linia ceny dotyka dolnej bandy kanału Hursta (wystarczy dotknięcie, nawet na moment)
   - Dodatkowy warunek trendu z wyższego timeframe'u (EMA(30) na godzinówkach) - trend musi być wzrostowy lub neutralny

2. **Drugie wejście** (25% kapitału):

   - Dostępne tylko po wykonaniu pierwszego wejścia
   - Następuje gdy cena ponownie dotyka dolnej bandy kanału Hursta
   - Wymagany minimalny odstęp czasowy od poprzedniego wejścia (opcjonalna implementacja)

3. **Trzecie wejście** (50% kapitału):
   - Dostępne tylko po wykonaniu drugiego wejścia
   - Następuje gdy cena ponownie dotyka dolnej bandy kanału Hursta

#### Warunki wyjścia z pozycji:

Pozycja jest zamykana gdy nastąpi jedno z poniższych zdarzeń:

- Linia ceny przetnie górną bandę kanału Hursta, a następnie powróci do kanału (główny sygnał)
- Aktywowany trailing stop (po osiągnięciu górnego ekstremum) zostanie naruszony (spadek o określony procent od maksimum)

Wszystkie sygnały są generowane w czasie rzeczywistym na podstawie aktualnej ceny, nie czekając na zamknięcie świecy. Strategia zawiera mechanizmy adaptacyjne dostosowujące się do aktualnych warunków rynkowych.

## Technologie

- **Backend**: Node.js, Express
- **Baza danych**: MongoDB
- **Komunikacja**: REST API, WebSocket
- **Analiza techniczna**: własne implementacje + biblioteki technicalindicators/tulind
- **Deployment**: Docker, możliwość uruchomienia na VPS
- **Skalowalność**: PM2 do zarządzania wieloma instancjami Node.js

## Struktura Projektu

Struktura folderów została zorganizowana zgodnie z wzorcem MVC z dodatkowymi warstwami serwisów. Główne komponenty:

- **src/services/binance.service.js**: obsługa WebSocketów i API Binance
- **src/services/analysis.service.js**: implementacja wskaźników technicznych
- **src/services/signal.service.js**: generowanie sygnałów handlowych
- **src/services/instance.service.js**: zarządzanie instancjami strategii
- **src/utils/technical.js**: funkcje pomocnicze do analizy technicznej
- **src/utils/websocket.js**: zarządzanie połączeniami WebSocket

### Modele danych uwzględniające wieloinstancyjność:

- **src/models/instance.model.js**: konfiguracja instancji
- **src/models/signal.model.js**: sygnały z identyfikatorem instancji
- **src/models/market-data.model.js**: dane rynkowe z oznaczeniem instancji

## Architektura Wieloinstancyjna

System został zaprojektowany z myślą o równoległym uruchamianiu wielu instancji z różnymi parametrami:

1. **Instancje dla różnych strategii**:

   - Każda instancja może mieć własne parametry kanału Hursta
   - Możliwość konfiguracji EMA o różnych okresach (np. EMA(20), EMA(30), EMA(50))
   - Różne interwały czasowe dla poszczególnych wskaźników (np. 15m/1h, 5m/30m, 1h/4h)

2. **Zarządzanie wieloma kontami**:

   - Każda instancja może być przypisana do innego konta Binance
   - Niezależna konfiguracja API keys dla każdej instancji
   - Separacja danych pomiędzy kontami

3. **Architektura modułowa**:

   - Serwisy analizy technicznej są inicjalizowane per-instancja
   - Wspólna warstwa abstrakcji dla WebSocketów z wieloma połączeniami
   - Współdzielona infrastruktura (serwer, baza danych), ale rozdzielone dane biznesowe

4. **Izolacja danych**:
   - Każda instancja ma własne kolekcje w MongoDB
   - Mechanizm identyfikacji instancji (instanceId) w modelach danych
   - Filtry w zapytaniach do bazy danych uwzględniające identyfikator instancji

## Rozszerzenia i Przyszły Rozwój

1. **Dodatkowe wskaźniki**: Możliwość włączenia innych wskaźników technicznych
2. **Panel użytkownika**: Frontend do monitorowania i zarządzania sygnałami
3. **Automatyczna realizacja zleceń**: Integracja z API tradingowym Binance
4. **Testowanie na danych historycznych**: Backtesting strategii
5. **Optymalizacja parametrów**: System do optymalizacji parametrów wskaźników
6. **Porównywanie instancji**: Analityka porównawcza różnych konfiguracji parametrów
