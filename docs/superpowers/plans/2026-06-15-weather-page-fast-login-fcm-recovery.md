# Weather Page, Fast Login, and FCM Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Google-style weather page shared by both roles, remove homepage weather blocks, make login navigate after core identity data, and recover FCM failures without blocking access.

**Architecture:** Extract weather data, cache, presence, and FCM connection state into focused Dart files. Keep Firebase Auth and the role document on the critical login path, then launch Firestore listeners, contacts, help listeners, and FCM asynchronously after navigation. Both role home headers open one shared weather page.

**Tech Stack:** Flutter/Dart, Firebase Auth, Cloud Firestore, Firebase Messaging, Open-Meteo, Geolocator, SharedPreferences, Flutter test.

---

## File Structure

- Create `lib/weather_models.dart`: current, hourly, and daily weather value models.
- Create `lib/weather_cache.dart`: 30-minute in-memory weather cache decision logic.
- Create `lib/fcm_connection.dart`: FCM state, retry delays, and single-flight controller.
- Create `lib/background_bootstrap.dart`: launches non-critical post-login work without blocking navigation.
- Create `test/weather_models_test.dart`
- Create `test/weather_cache_test.dart`
- Create `test/fcm_connection_test.dart`
- Create `test/background_bootstrap_test.dart`
- Modify `lib/main.dart`: weather API parsing, shared WeatherPage, headers, login flow, warnings, lifecycle retry.
- Modify `test/notification_delivery_regression_test.dart`

### Task 1: Weather models and API parsing

**Files:**
- Create: `C:\Users\user\Desktop\retrocare_project\heal2_app\lib\weather_models.dart`
- Create: `C:\Users\user\Desktop\retrocare_project\heal2_app\test\weather_models_test.dart`
- Modify: `C:\Users\user\Desktop\retrocare_project\heal2_app\lib\main.dart`

- [ ] **Step 1: Write failing model tests**

Test parsing hourly arrays into aligned values, limiting the visible range to the next 12 hours, and parsing seven daily forecasts.

- [ ] **Step 2: Run the focused test**

Run: `flutter test test/weather_models_test.dart`

Expected: FAIL because `weather_models.dart` does not exist.

- [ ] **Step 3: Implement models**

Add `HourlyWeatherForecast`, `WeatherDayForecast`, and expanded `WeatherInfo` with location source, fallback state, current rain probability, and hourly forecasts.

- [ ] **Step 4: Expand Open-Meteo request**

Request:

```text
hourly=temperature_2m,apparent_temperature,precipitation_probability,relative_humidity_2m,weather_code,wind_speed_10m
daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max
forecast_days=8
timezone=Asia/Taipei
```

- [ ] **Step 5: Run tests**

Run: `flutter test test/weather_models_test.dart`

Expected: PASS.

### Task 2: Thirty-minute weather cache

**Files:**
- Create: `C:\Users\user\Desktop\retrocare_project\heal2_app\lib\weather_cache.dart`
- Create: `C:\Users\user\Desktop\retrocare_project\heal2_app\test\weather_cache_test.dart`
- Modify: `C:\Users\user\Desktop\retrocare_project\heal2_app\lib\main.dart`

- [ ] **Step 1: Write failing cache tests**

Verify cached data is reused for 29 minutes, expires after 30 minutes, and `forceRefresh` bypasses it.

- [ ] **Step 2: Run focused tests**

Run: `flutter test test/weather_cache_test.dart`

Expected: FAIL because cache types are missing.

- [ ] **Step 3: Implement cache**

Implement a generic `TimedCache<T>` with `get`, `set`, and `clear`; update `WeatherService.fetchCurrentWeather({bool forceRefresh = false})`.

- [ ] **Step 4: Run tests**

Run: `flutter test test/weather_cache_test.dart`

Expected: PASS.

### Task 3: Shared full weather page

**Files:**
- Modify: `C:\Users\user\Desktop\retrocare_project\heal2_app\lib\main.dart`
- Create: `C:\Users\user\Desktop\retrocare_project\heal2_app\test\weather_page_regression_test.dart`

- [ ] **Step 1: Write structural regression tests**

Assert the source contains one shared `WeatherPage`, hourly forecast section, seven-day section, pull-to-refresh, and no homepage `WeatherCard` or `CaregiverWeatherStrip` usage.

- [ ] **Step 2: Run test and verify failure**

Run: `flutter test test/weather_page_regression_test.dart`

Expected: FAIL because the shared page and header buttons are not present.

- [ ] **Step 3: Implement WeatherPage**

Build:

- location and source header
- large current temperature panel
- rain probability, humidity, wind, and apparent temperature metrics
- horizontally scrollable 12-hour forecast
- temperature `CustomPainter` line
- seven-day forecast list
- fallback location warning
- `RefreshIndicator` calling `forceRefresh: true`

- [ ] **Step 4: Add both header buttons**

Add a weather icon immediately before the notification icon in `PatientHomePage` and `CaregiverHeader`.

- [ ] **Step 5: Remove homepage weather fetches**

Remove `WeatherCard()` and `CaregiverWeatherStrip()` from their home layouts.

- [ ] **Step 6: Run focused and full tests**

Run:

```powershell
flutter test test/weather_page_regression_test.dart
flutter test
```

Expected: PASS.

### Task 4: Non-blocking post-login bootstrap

**Files:**
- Create: `C:\Users\user\Desktop\retrocare_project\heal2_app\lib\background_bootstrap.dart`
- Create: `C:\Users\user\Desktop\retrocare_project\heal2_app\test\background_bootstrap_test.dart`
- Modify: `C:\Users\user\Desktop\retrocare_project\heal2_app\lib\main.dart`

- [ ] **Step 1: Write failing tests**

Use completers to prove `start()` returns before background jobs complete and one failed job does not prevent other jobs from starting.

- [ ] **Step 2: Run focused test**

Run: `flutter test test/background_bootstrap_test.dart`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement coordinator**

Implement `BackgroundBootstrap.start(List<Future<void> Function()> jobs)` using unawaited guarded futures and per-job error reporting.

- [ ] **Step 4: Refactor login paths**

Email, Google, and `AppStartupPage` critical path becomes:

```text
authenticate -> read users/{uid} -> set role profile -> load local URL -> navigate
```

After navigation start realtime sync, contacts, FCM, and help listener through the coordinator. Remove fixed 500ms delays.

- [ ] **Step 5: Run tests**

Run: `flutter test test/background_bootstrap_test.dart`

Expected: PASS.

### Task 5: FCM connection state and retry

**Files:**
- Create: `C:\Users\user\Desktop\retrocare_project\heal2_app\lib\fcm_connection.dart`
- Create: `C:\Users\user\Desktop\retrocare_project\heal2_app\test\fcm_connection_test.dart`
- Modify: `C:\Users\user\Desktop\retrocare_project\heal2_app\lib\main.dart`

- [ ] **Step 1: Write failing controller tests**

Verify:

- concurrent calls share one initialization
- failure transitions to failed
- delays are immediate, 30 seconds, then 2 minutes
- success cancels retry and clears the error
- manual and foreground retries can trigger a new attempt

- [ ] **Step 2: Run focused test**

Run: `flutter test test/fcm_connection_test.dart`

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement controller**

Create `FcmConnectionController` with a `ValueNotifier<FcmConnectionState>`, injected initializer and delay scheduler, one active future, and bounded retry sequence.

- [ ] **Step 4: Connect FcmService**

Background bootstrap calls the controller rather than directly awaiting `FcmService.init()`. App lifecycle resume triggers `retryNow()`.

- [ ] **Step 5: Add warning UI**

Create a reusable warning band shown on both homepages when state is failed:

```text
通知服務尚未連線，目前可能收不到背景服藥提醒
```

Include a `重新連接` action and show current progress while retrying.

- [ ] **Step 6: Add settings reconnect entry**

Add notification connection status, last error, and reconnect button to both settings pages.

- [ ] **Step 7: Run focused tests**

Run: `flutter test test/fcm_connection_test.dart`

Expected: PASS.

### Task 6: Verification and emulator install

**Files:**
- Verify all Flutter source and tests.

- [ ] **Step 1: Format**

Run:

```powershell
dart format lib test
```

- [ ] **Step 2: Test**

Run:

```powershell
flutter test
flutter analyze
```

Expected: all tests pass; no new analyzer errors.

- [ ] **Step 3: Build**

Run:

```powershell
flutter build apk --debug
```

Expected: `build\app\outputs\flutter-apk\app-debug.apk`.

- [ ] **Step 4: Install on Pixel_8**

Run:

```powershell
adb -s emulator-5556 install -r build\app\outputs\flutter-apk\app-debug.apk
```

- [ ] **Step 5: Manual acceptance**

Confirm:

- both role homepages show weather then notification icons
- neither homepage fetches or displays a weather block
- weather page renders current, hourly, and seven-day information without overlap
- login reaches the correct home before FCM or contacts finish
- simulated FCM failure shows warning and manual retry
