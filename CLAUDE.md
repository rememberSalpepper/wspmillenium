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
```

There are no test or lint scripts configured.

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

Patient flow states drive everything: `WELCOME → COLLECTING_RUT → COLLECTING_NOMBRE → COLLECTING_CORREO → COLLECTING_TELEFONO → COLLECTING_DIRECCION → CONFIRMING_FORM → CONSULTATION → CONSULTATION_SUMMARY → AWAITING_APPOINTMENT → COMPLETED`

State is derived from the database record (`deriveFlowStateFromPatient`), not stored separately. In-memory overrides exist for UI state (e.g., `CONFIRMING_FORM`).

### AI Usage Pattern

Gemini is called in three distinct modes:
1. **Form extraction** (`buildFormExtractionInstruction`) — extracts structured fields (RUT, name, etc.) from free text, returns JSON
2. **Consultation extraction** (`buildConsultationExtractionInstruction`) — extracts symptoms list, returns JSON array
3. **Orientation generation** (`buildConsultationOrientationInstruction`) — generates 1-3 possible diagnoses
4. **General conversation** (`generateReply`) — fallback with full conversation history context

### Database (SQLite, better-sqlite3)

Synchronous SQLite via `better-sqlite3`. Three tables:
- `patients` — one row per phone, stores form fields + `form_completed` flag
- `consultations` — linked to patient, stores symptoms text + orientation
- `consulta_sintomas` — normalized symptoms per consultation

Key methods in `database.js`: `ensurePatient`, `upsertPatientField`, `markFormCompleted`, `createConsultation`, `addSymptoms`, `resetPatient`.

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
| `BOT_WELCOME_MESSAGE` | Override initial greeting |
| `BOT_HUMAN_HANDOFF_MESSAGE` | Message sent when escalating to human |
| `BOT_EMERGENCY_MESSAGE` | Message sent on emergency detection |
| `BOT_PRICE_TABLE` | Pricing info injected into system prompt (use `\n` for line breaks) |
| `BOT_SYSTEM_INSTRUCTION` | Additional instructions appended to system prompt |
| `BOT_SYSTEM_INSTRUCTION_OVERRIDE` | Fully replaces system prompt |
| `BOT_MAX_WORDS` | Response word limit (default 120) |
| `MESSAGE_BUFFER_MS` | Batching window (default 2500ms) |
| `CONTEXT_MAX_TURNS` | Conversation history turns (default 12) |
| `GEMINI_TIMEOUT_MS` | Gemini request timeout (default 20000ms) |

### Key Files

- `src/routes/webhook.js` — main message processing logic (~770 lines)
- `src/handlers/formHandler.js` — form collection + Gemini field extraction (~386 lines)
- `src/handlers/consultationHandler.js` — symptom extraction + orientation (~276 lines)
- `src/botPrompt.js` — all Gemini system instruction builders
- `src/botPolicy.js` — emergency/handoff keyword patterns
- `src/config.js` — all env var reading and defaults

### Deployment

Deployed via Docker Compose on a server with an external reverse proxy network (`edugeo_default`). SQLite DB persists at `./data/bot.db` via volume mount. The `better-sqlite3` native module requires Python + build tools at image build time (included in Dockerfile).
