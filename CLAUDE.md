# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the server
npm start

# Run with Docker
docker compose up -d

# View logs
docker compose logs -f app

# Run the test suite (Jest)
npm test
```

Tests live in `tests/` and run with Jest (`npm test`). There is no lint script configured.

## Architecture Overview

This is a **telemedicine WhatsApp bot** (named "Catalina") for Consultas Milenium, powered by Google Gemini AI. It collects patient data, extracts symptoms, and provides medical orientations via WhatsApp Cloud API.

### Request Flow

```
WhatsApp Webhook POST
  → Stale check (> 5min old → ignore)
  → Dedup check (dedupStore, 6hr TTL)
  → Policy check (emergency patterns → escalate, human patterns → handoff)
  → First contact → send welcome
  → Buffer messages 2.5s (inboundBufferStore) then combine
  → SenderQueue (per-user sequential processing, prevents race conditions)
  → PatientFlowStore (state machine) determines next handler:
      COLLECTING_RUT/NOMBRE/CORREO/TELEFONO/DIRECCION → formHandler
      CONFIRMING_FORM → formHandler
      CONSULTATION → consultationHandler
      COMPLETED → Gemini fallback with conversation context
  → WhatsApp API sends reply
```

### State Machine (patientFlowStore.js)

Patient flow states drive everything: `WELCOME → COLLECTING_RUT → COLLECTING_NOMBRE → COLLECTING_CORREO → COLLECTING_TELEFONO → COLLECTING_DIRECCION → CONFIRMING_FORM → CONSULTATION → CONSULTATION_SUMMARY → AWAITING_APPOINTMENT → SELECTING_DAY → SELECTING_APPOINTMENT → CONFIRMING_APPOINTMENT → COMPLETED`

State is derived from the database record (`deriveFlowStateFromPatient`), not stored separately. In-memory overrides exist for UI state (e.g., `CONFIRMING_FORM`).

**Appointment booking is a two-step dropdown flow:** once the patient accepts (`AWAITING_APPOINTMENT`), the bot shows an interactive list of available **days** (`SELECTING_DAY`, built from `database.getAvailableDays`), then the **times** for the chosen day (`SELECTING_APPOINTMENT`, from `database.getSlotsForDate`), then a confirm step (`CONFIRMING_APPOINTMENT`). The time list includes an `otro_dia` row to go back to the day list. Rescheduling (`mode: 'reschedule'` carried in the flow-store state data, with `appointmentId`) reuses the exact same day→time path.

### AI Usage Pattern

Gemini is called in three distinct modes:
1. **Form extraction** (`buildFormExtractionInstruction`) — extracts structured fields (RUT, name, etc.) from free text, returns JSON
2. **Consultation extraction** (`buildConsultationExtractionInstruction`) — extracts symptoms list, returns JSON array
3. **Orientation generation** (`buildConsultationOrientationInstruction`) — generates 1-3 possible diagnoses
4. **General conversation** (`generateReply`) — fallback with full conversation history context

### Database (SQLite, better-sqlite3)

Synchronous SQLite via `better-sqlite3`. Main tables:
- `patients` — one row per phone, stores form fields + `form_completed` flag
- `consultations` — linked to patient, stores symptoms text + orientation
- `consulta_sintomas` — normalized symptoms per consultation
- `appointments` / `doctor_schedule` / `schedule_blocks` — appointment scheduling
- `conversation_turns` — persisted AI conversation history (rolling window, capped per phone)
- `patient_memory` — long-term summarized memory per phone (one row, injected into the system prompt)

Indexes exist on `patients.phone`, `consultations.phone`, `appointments.appointment_date`,
`appointments.phone` and `conversation_turns(phone, id)`.

Key methods in `database.js`: `ensurePatient`, `upsertPatientField`, `markFormCompleted`, `createConsultation`, `addSymptoms`, `resetPatient`, `getPatientMemory`, `upsertPatientMemory`, `clearPatientMemory`.

### In-Memory Stores

All stores live in `src/stores/` and are singletons passed via `app.js`:
- `conversationStore` — last 12 turns, max 12KB per user (24hr TTL)
- `dedupStore` — processed message IDs (6hr TTL)
- `senderQueue` — per-user FIFO promise chain
- `inboundBufferStore` — 2.5s batching window

### Bot Behavior Configuration

Bot behavior is controlled entirely via environment variables — no code changes needed for most tuning:

| Variable | Purpose |
|---|---|
| `BOT_WELCOME_MESSAGE` | Override initial greeting for new users (asks for all form data in one message) |
| `BOT_RETURNING_MESSAGE` | Greeting for returning patients; `{nombre}` is replaced with the patient's first name. The menu is appended automatically |
| `RETURNING_SESSION_GAP_MS` | Inactivity gap (ms) after which a completed patient is greeted back by name + menu (default 6h) |
| `BOT_HUMAN_HANDOFF_MESSAGE` | Message sent when escalating to human |
| `BOT_EMERGENCY_MESSAGE` | Message sent on emergency detection |
| `BOT_PRICE_TABLE` | Pricing info injected into system prompt (use `\n` for line breaks) |
| `BOT_SYSTEM_INSTRUCTION` | Additional instructions appended to system prompt |
| `BOT_SYSTEM_INSTRUCTION_OVERRIDE` | Fully replaces system prompt |
| `BOT_MAX_WORDS` | Response word limit (default 120) |
| `MESSAGE_BUFFER_MS` | Batching window (default 2500ms) |
| `CONTEXT_MAX_TURNS` | Conversation history turns (default 12) |
| `GEMINI_TIMEOUT_MS` | Gemini request timeout (default 20000ms) |
| `WHATSAPP_INTERACTIVE` | Interactive buttons/lists (default true) |
| `CLINIC_NAME` | Clinic name shown as the footer on interactive messages (default `Consultas Milenium`) |
| `WHATSAPP_AUDIO_TRANSCRIPTION` | Transcribe voice notes (default true) |
| `WHATSAPP_REMINDERS` | Send appointment reminders via WhatsApp (default true) |
| `WHATSAPP_REMINDER_TEMPLATE` | Approved template name for reminders (empty → plain text) |
| `WHATSAPP_REMINDER_TEMPLATE_LANG` | Template language code (default `es`) |
| `EMAIL_REMINDERS` | Send appointment reminders via email to the clinic (default true) |
| `BOT_REMINDER_MESSAGE` | WhatsApp reminder text; placeholders `{nombre}`, `{fecha}`, `{hora}` |
| `LONGTERM_MEMORY` | Per-patient summarized long-term memory (default true) |
| `MEMORY_SUMMARY_EVERY_TURNS` | Turns before refreshing the memory summary (default 10) |

### Key Files

- `src/routes/webhook.js` — main message processing logic
- `src/handlers/formHandler.js` — form collection + Gemini field extraction
- `src/handlers/consultationHandler.js` — symptom extraction + orientation
- `src/handlers/menuHandler.js` — COMPLETED-state main menu (new consultation / status / cancel-reschedule)
- `src/services/memory.js` — long-term summarized memory (summary persistence + refresh trigger)
- `src/services/reminders.js` — WhatsApp + email appointment reminder scheduler logic
- `src/botPrompt.js` — all Gemini system instruction builders (incl. memory/summary prompts)
- `src/botPolicy.js` — emergency/handoff keyword patterns
- `src/config.js` — all env var reading and defaults
- `src/utils/` — `text.js` (text helpers), `intent.js` (restart/reset detection), `dateFormat.js` (Spanish dates), `signature.js` (webhook HMAC)

### Deployment

Deployed via Docker Compose on a server with an external reverse proxy network (`edugeo_default`). SQLite DB persists at `./data/bot.db` via volume mount. The `better-sqlite3` native module requires Python + build tools at image build time (included in Dockerfile).
