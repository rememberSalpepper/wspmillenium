# Roadmap de mejoras — wa-bot (bot + CRM)

Estado del documento: vivo. Cada fase se planifica en detalle y se aprueba antes de implementar.
Última actualización: 2026-06-18.

## Contexto

El sistema creció de "bot de WhatsApp" a **bot + CRM + agendamiento de citas**. Tres ejes de mejora
identificados:

1. Persistencia de la memoria de la IA en el chat.
2. Más funciones de WhatsApp para el bot.
3. Auditoría y revisión completa (seguridad, fiabilidad, datos, operaciones).

## Fases

| Fase | Tema | Esfuerzo | Impacto | Estado |
|------|------|----------|---------|--------|
| 1 | Persistencia de memoria IA en SQLite + rehidratación | Medio | 🔴 Alto | ✅ Hecho |
| 2 | Seguridad: firma webhook + hash scrypt + JWT + PII logs | Bajo | 🔴 Alto | ✅ Hecho |
| 3 | Funciones WhatsApp: botones/listas + recibir audio | Medio | 🟠 Alto | ✅ Hecho |
| 4 | Plantillas (templates) + recordatorios por WhatsApp | Medio | 🟠 Alto | ✅ Hecho |
| 5 | Memoria resumida de largo plazo | Medio | 🟢 Medio | ✅ Hecho |
| 6 | Limpieza: tests, índices, CLAUDE.md, refactor webhook | Medio | 🟢 Medio | ✅ Hecho |

Leyenda estado: ⬜ Pendiente · 📋 En planificación · 🚧 En curso · ✅ Hecho

---

## Resumen de la sesión (2026-06-18)

Se completaron las **Fases 4, 5 y 6** (las últimas pendientes). Verificado con `npm test` →
**69/69 tests pasan**. Archivos nuevos: `src/services/memory.js`, `src/services/reminders.js`,
`src/handlers/menuHandler.js`, `src/utils/text.js`, `src/utils/intent.js`, `src/utils/dateFormat.js`,
y los suites `tests/memory.test.js`, `tests/reminders.test.js`, `tests/utils.test.js`,
`tests/whatsapp.template.test.js`, `tests/menuHandler.test.js`. El roadmap queda completo.

### Acciones de configuración opcionales (en el `.env` del VPS)

Todas tienen default razonable; no bloquean el arranque:

| Variable | Para qué | Default |
|---|---|---|
| `WHATSAPP_REMINDER_TEMPLATE` | Plantilla aprobada para recordatorios fuera de la ventana de 24h. Si está vacía, se intenta texto plano (solo funciona dentro de la ventana). | (vacío) |
| `WHATSAPP_REMINDERS` | Recordatorios de cita por WhatsApp al paciente. | `true` |
| `EMAIL_REMINDERS` | Recordatorios de cita por email a la clínica. | `true` |
| `BOT_REMINDER_MESSAGE` | Texto del recordatorio (`{nombre}`, `{fecha}`, `{hora}`). | mensaje por defecto |
| `LONGTERM_MEMORY` | Memoria resumida de largo plazo por paciente. | `true` |
| `MEMORY_SUMMARY_EVERY_TURNS` | Cada cuántos turnos se refresca el resumen. | `10` |

**Nota plantillas:** `WHATSAPP_REMINDER_TEMPLATE` debe crearse y aprobarse en **Meta → WhatsApp Manager →
Plantillas** con 3 parámetros de cuerpo en este orden: nombre, fecha, hora. Sin plantilla, el recordatorio
solo llegará a pacientes que hayan escrito en las últimas 24h.

## Resumen de la sesión (2026-06-17)

Se completaron las **Fases 1, 2 y 3**. Todo verificado con `npm test` → **34/34 tests pasan**.
Quedan pendientes las Fases 4, 5 y 6.

### Acciones de configuración pendientes (en el `.env` del VPS)

Ninguna es obligatoria para que el bot arranque, pero sí recomendadas:

| Variable | Para qué | Default actual |
|---|---|---|
| `APP_SECRET` | **Activa la verificación de firma del webhook** (Fase 2). Hoy avisa y deja pasar. | (sin definir → firma deshabilitada) |
| `CRM_JWT_SECRET` | Evitar que los redeploys cierren las sesiones del CRM. Ahora avisa si falta. | aleatorio por arranque |
| `LOG_PII` | Mostrar PII completa en logs (solo para debug local). | `false` (recomendado) |
| `WHATSAPP_INTERACTIVE` | Botones/listas interactivas (Fase 3). | `true` (activo) |
| `WHATSAPP_AUDIO_TRANSCRIPTION` | Transcribir notas de voz (Fase 3). | `true` (activo) |

`APP_SECRET` se obtiene en **Meta for Developers → tu App → Configuración → Básica → Clave secreta de la app**.

### Notas de comportamiento tras el deploy

- **Memoria IA**: empieza a persistir desde el primer mensaje post-deploy. Las conversaciones previas al
  cambio no se recuperan (no existían en BD). La tabla `conversation_turns` se crea sola (migración inline).
- **Contraseñas CRM**: el primer login del admin re-hashea su clave de SHA-256 a scrypt automáticamente.
- **Interactivos**: conviene probarlos en el número real; si un cliente no los renderiza, hay fallback a texto.

### Archivos nuevos creados esta sesión

- `src/utils/signature.js` — verificación HMAC de la firma del webhook.
- `tests/conversationStore.persistence.test.js`, `tests/security.test.js`, `tests/whatsapp.interactive.test.js`.
- `ROADMAP.md` (este documento).

---

## Fase 1 — Persistencia de memoria IA

**Problema:** `conversationStore` es 100% en memoria (`Map`). Se borra en cada reinicio/redeploy,
solo vive en una instancia y solo guarda los últimos 12 turnos. La IA pierde el hilo de la
conversación aunque los datos del paciente sí persistan en SQLite.

**Objetivo:** que el historial conversacional sobreviva reinicios, con SQLite como fuente de verdad.

**Implementado (2026-06-17):**
- Tabla `conversation_turns` (phone, role, text, created_at) + índice `idx_conv_turns_phone`.
- `database.js`: `appendConversationTurn`, `getRecentConversationTurns`, `clearConversationTurns`,
  `pruneConversationTurns`. Cap duro de 50 filas por teléfono; `resetPatient` también borra el historial.
- `conversationStore.js`: caché en memoria con *write-through* a SQLite y rehidratación al arrancar
  (cuando la caché está vacía se cargan los turnos desde la BD). Retrocompatible: sin `database` funciona
  como antes (solo memoria).
- `app.js`: `database` se crea antes del store y se inyecta; prune por TTL en el `setInterval` de limpieza.
- Tests: `tests/conversationStore.persistence.test.js` (rehidratación, maxTurns, clear, reset).

**Pendiente para más adelante:** memoria resumida de largo plazo (Fase 5) y persistir `dedupStore` (Fase 2).

---

## Fase 2 — Seguridad

**Implementado (2026-06-17):**
- **Firma webhook**: `src/utils/signature.js` (`verifyWebhookSignature`, HMAC-SHA256 timing-safe).
  `app.js` captura el body crudo (`express.json({ verify })`); el webhook rechaza con `401` si la firma
  no calza. Rollout seguro: si `APP_SECRET` no está configurado, se loguea un warn y se deja pasar.
- **Hash scrypt**: `hashPassword`/`verifyPassword` en `database.js` usan `scrypt` (formato `scrypt:salt:hash`),
  con compatibilidad para hashes legacy SHA-256. El login (`crm.js`) re-hashea de forma transparente
  los hashes legacy a scrypt (`updateCrmUserPassword`).
- **CRM_JWT_SECRET**: `config.CRM_JWT_SECRET_PROVIDED` + warn al arranque si falta (sigue funcionando
  con secreto aleatorio, pero avisa que cierra sesiones en cada reinicio).
- **PII en logs**: redacción centralizada en `logger.js` (enmascara teléfonos dejando 4 dígitos, redacta
  previews de texto y `lastTurns`). Controlado por `LOG_PII` (default `false`).
- Tests: `tests/security.test.js` (firma, scrypt + legacy, `maskPhone`).

**Variables `.env` nuevas:** `APP_SECRET` (recomendado), `LOG_PII=false` (opcional), `CRM_JWT_SECRET`
(ya debería estar; ahora avisa si falta).

**Fuera de alcance:** persistir `dedupStore` (bajo valor; queda para Fase 6 o se descarta).

## Fase 3 — Funciones WhatsApp

**Implementado (2026-06-17):**
- **Envío interactivo** (`services/whatsapp.js`): `sendInteractiveButtons` (máx 3, título ≤20 chars) y
  `sendInteractiveList` (máx 10 filas, título ≤24). `deliverReply` envía interactivo si la feature está
  activa, con fallback automático a texto si el envío falla.
- **Recepción interactiva** (`routes/webhook.js`): los `button_reply`/`list_reply` se mapean a su `id`,
  que coincide con lo que ya esperan los handlers (`1`/`2`/`3`/`si`/`no`) → la lógica de flujo no cambia.
- **Menús convertidos**: menú principal (COMPLETED), gestión de cita, ¿agendar? (sí/no), confirmar hora
  (sí/no) y selección de horario (lista). Todos conservan su texto de respaldo.
- **Audio**: `whatsapp.downloadMedia` (resuelve media id → URL → bytes) + `gemini.transcribeAudio`
  (inlineData base64). En el webhook, los audios se transcriben y entran al flujo como texto; si falla,
  se envía el fallback "no puedo escuchar audios". Dedup/stale movidos antes para no transcribir dos veces.
- Tests: `tests/whatsapp.interactive.test.js` (payloads de botones/lista, truncado/cap, descarga de media).

**Variables `.env` nuevas (default activado):** `WHATSAPP_INTERACTIVE=true`,
`WHATSAPP_AUDIO_TRANSCRIPTION=true`.

**Pendiente/evaluar:** recibir imágenes/documentos (no incluido en esta fase).

## Fase 4 — Plantillas + recordatorios WhatsApp

**Implementado (2026-06-18):**
- **Plantillas**: `whatsapp.sendTemplate(to, { name, languageCode, components })` para mensajes de
  plantilla aprobados (necesarios fuera de la ventana de 24h).
- **Recordatorios por WhatsApp**: `src/services/reminders.js` (`createReminderService`) ahora notifica
  al paciente por WhatsApp además de avisar a la clínica por email. Usa plantilla si
  `WHATSAPP_REMINDER_TEMPLATE` está configurada; si no, intenta texto plano. La cita se marca como
  recordada si al menos un canal tuvo éxito. El scheduler de `app.js` delega en este servicio.

**Variables `.env` nuevas:** `WHATSAPP_REMINDERS=true`, `WHATSAPP_REMINDER_TEMPLATE` (vacío → texto),
`WHATSAPP_REMINDER_TEMPLATE_LANG=es`, `EMAIL_REMINDERS=true`, `BOT_REMINDER_MESSAGE` (placeholders
`{nombre}`, `{fecha}`, `{hora}`).

## Fase 5 — Memoria resumida de largo plazo

**Implementado (2026-06-18):**
- Tabla `patient_memory` (phone, summary, turns_at_update, updated_at) + métodos en `database.js`
  (`getPatientMemory`, `upsertPatientMemory`, `clearPatientMemory`). `resetPatient` también la borra.
- `gemini.summarizeConversation({ previousSummary, turns })` genera un resumen acumulativo;
  builders de prompt en `botPrompt.js` (`buildSummarizationInstruction/Prompt`, `buildMemorySystemSuffix`).
- `src/services/memory.js` (`createMemoryService`): `getSummary` para inyectar y `noteTurn` que refresca
  el resumen en segundo plano cada `MEMORY_SUMMARY_EVERY_TURNS` turnos. El resumen se inyecta en el
  system prompt del fallback de conversación general (estado COMPLETED).

**Variables `.env` nuevas:** `LONGTERM_MEMORY=true`, `MEMORY_SUMMARY_EVERY_TURNS=10`.

## Fase 6 — Limpieza

**Implementado (2026-06-18):**
- **Índices**: `idx_patients_phone`, `idx_consultations_phone`, `idx_appointments_date`,
  `idx_appointments_phone` (además del ya existente `idx_conv_turns_phone`).
- **Modularización de `webhook.js`**: helpers de texto a `src/utils/text.js`, detección de intención a
  `src/utils/intent.js`, formato de fechas en español a `src/utils/dateFormat.js`, y el menú del estado
  COMPLETED a `src/handlers/menuHandler.js`. El webhook quedó considerablemente más corto.
- **Tests**: nuevos suites `memory.test.js`, `reminders.test.js`, `utils.test.js`,
  `whatsapp.template.test.js`, `menuHandler.test.js`. Total **69/69 tests pasan**.
- **`CLAUDE.md`** actualizado (comando de tests, tablas nuevas, variables y archivos clave).

**Pendiente/evaluar (fuera de alcance):** recibir imágenes/documentos por WhatsApp; persistir
`dedupStore` (bajo valor). Falta `lint` configurado.
