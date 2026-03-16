# Prompt de Implementación — Flujo de Atención al Cliente con Formulario

## Contexto del Proyecto

Este es un bot de WhatsApp construido con **Node.js/Express** que usa **Google Gemini** (`@google/genai`) como motor de IA. Actualmente:

- No tiene base de datos — usa solo stores en memoria (Maps) que se pierden al reiniciar.
- El flujo actual es: mensaje de bienvenida → chequeos de política (emergencia, handoff, diagnóstico) → respuesta de Gemini AI.
- Se despliega con Docker/docker-compose en un VPS.

### Archivos clave del proyecto:

| Archivo | Función |
|---------|---------|
| `server.js` | Entry point HTTP |
| `src/app.js` | Setup de Express, stores, servicios y rutas |
| `src/config.js` | Configuración centralizada desde env vars |
| `src/botPrompt.js` | Mensajes por defecto y constructor del system instruction de Gemini |
| `src/botPolicy.js` | Lógica de respuestas automáticas: emergencia, handoff humano, diagnóstico, límite de palabras |
| `src/routes/webhook.js` | Router principal del webhook: recibe eventos de WhatsApp, bufferiza mensajes, los procesa por política y luego por Gemini |
| `src/services/whatsapp.js` | Cliente del WhatsApp Cloud API (enviar texto, marcar como leído) |
| `src/services/gemini.js` | Cliente de Gemini (generar respuesta con system instruction) |
| `src/stores/conversationStore.js` | Historial de conversación en memoria para contexto de Gemini |
| `src/stores/dedupStore.js` | Deduplicación de mensajes por ID |
| `src/stores/inboundBufferStore.js` | Buffer de mensajes rápidos del mismo sender |
| `src/stores/senderQueue.js` | Cola por sender para procesamiento ordenado |
| `docker-compose.yml` | Servicio Docker con red externa |
| `Dockerfile` | Node 22, npm ci, expose 3000 |

---

## Tareas a Implementar

### TAREA 1: Agregar base de datos SQLite

**Dependencia:** Instalar `better-sqlite3` vía npm (agregar a `package.json`).

**Crear `src/services/database.js`:**
- Inicializar SQLite con un archivo persistente (ruta configurable via env var `DATABASE_PATH`, default `./data/bot.db`).
- Crear las tablas al inicializar si no existen (usar `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  rut TEXT,
  nombre TEXT,
  correo TEXT,
  telefono TEXT,
  direccion TEXT,
  form_completed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS consultations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL,
  symptoms TEXT,
  reason TEXT,
  ai_orientation TEXT,
  summary TEXT,
  appointment_status TEXT DEFAULT 'pending',
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (patient_id) REFERENCES patients(id)
);
```

**Funciones del servicio de base de datos:**
- `findPatientByPhone(phone)` — Buscar paciente por teléfono (el `from` de WhatsApp)
- `createPatient(phone)` — Crear registro inicial con solo el teléfono
- `updatePatientField(phone, field, value)` — Actualizar un campo individual del paciente
- `isFormComplete(phone)` — Verificar si el paciente tiene todos los campos del formulario completos (rut, nombre, correo, telefono, direccion)
- `markFormComplete(phone)` — Marcar `form_completed = 1`
- `getPatientData(phone)` — Obtener todos los datos del paciente
- `createConsultation(patientId, data)` — Crear registro de consulta
- `updateConsultation(consultationId, data)` — Actualizar consulta
- `getActiveConsultation(patientId)` — Obtener consulta activa del paciente

**Integración en `src/app.js`:**
- Importar y crear la instancia del servicio de base de datos.
- Pasarlo al `createWebhookRouter` como dependencia adicional.
- Asegurar que el directorio `data/` exista (crearlo si no).

**Docker:**
- En `docker-compose.yml`, agregar un volumen para persistir la BD:
  ```yaml
  volumes:
    - ./data:/app/data
  ```
- En `.gitignore`, agregar `data/` y `*.db`.
- En `.dockerignore`, agregar `data/`.

---

### TAREA 2: Implementar flujo de formulario de registro (state machine)

**Crear `src/stores/patientFlowStore.js`:**

Un store en memoria que rastrea en qué paso del formulario se encuentra cada sender. Los estados son:

```
STATES = {
  WELCOME: 'welcome',
  AWAITING_RUT: 'awaiting_rut',
  AWAITING_NOMBRE: 'awaiting_nombre',
  AWAITING_CORREO: 'awaiting_correo',
  AWAITING_TELEFONO: 'awaiting_telefono',
  AWAITING_DIRECCION: 'awaiting_direccion',
  FORM_COMPLETE: 'form_complete',
  CONSULTATION: 'consultation'
}
```

**Funciones:**
- `getState(senderId)` — Retorna el estado actual del sender (default: `WELCOME` si no existe)
- `setState(senderId, state)` — Establece el estado
- `resetState(senderId)` — Vuelve al estado WELCOME
- Debe tener TTL de limpieza similar a los otros stores.

**IMPORTANTE:** Al iniciar, si un paciente ya tiene su formulario completo en la BD (checkeado via `database.isFormComplete`), su estado debe ser `FORM_COMPLETE` o `CONSULTATION`, NO debe pedir el formulario de nuevo.

---

### TAREA 3: Implementar el handler del formulario

**Crear `src/handlers/formHandler.js`:**

Este handler se encarga de procesar mensajes cuando el paciente está en la fase de formulario. Debe:

1. **Validar cada campo** con funciones específicas:
   - `validateRut(text)` — Validar formato de RUT chileno (ej: 12.345.678-9 o 12345678-9). Normalizar eliminando puntos y guiones para almacenar solo dígitos + dígito verificador.
   - `validateNombre(text)` — Solo validar que no esté vacío y tenga al menos 2 palabras.
   - `validateCorreo(text)` — Validar formato básico de email con regex.
   - `validateTelefono(text)` — Validar que sea un número chileno (9 dígitos, opcionalmente con +56).
   - `validateDireccion(text)` — Solo validar que no esté vacío y tenga al menos 5 caracteres.

2. **Mensajes de solicitud para cada campo** (cortos y directos):
   - RUT: `"Por favor, indícame tu RUT (ej: 12.345.678-9)."`
   - Nombre: `"¿Cuál es tu nombre completo?"`
   - Correo: `"¿Cuál es tu correo electrónico?"`
   - Teléfono: `"¿Cuál es tu número de teléfono? (ej: 912345678)"`
   - Dirección: `"¿Cuál es tu dirección? (incluye comuna)"`

3. **Mensajes de error de validación** (cortos):
   - Ejemplo RUT inválido: `"El RUT no tiene un formato válido. Intenta de nuevo (ej: 12.345.678-9)."`

4. **Función principal `handleFormStep(senderId, text, { database, patientFlowStore })`** que:
   - Obtiene el estado actual del sender desde `patientFlowStore`.
   - Si el estado es alguno de los `AWAITING_*`, valida el campo correspondiente.
   - Si la validación pasa: guarda en la BD via `database.updatePatientField`, avanza al siguiente estado, y retorna el mensaje del siguiente campo.
   - Si la validación falla: retorna el mensaje de error y se queda en el mismo estado.
   - Si todos los campos están completos: marca `form_completed`, cambia estado a `FORM_COMPLETE`, y retorna un mensaje de confirmación con resumen de datos.
   - Retorna `{ reply: string, formComplete: boolean }`.

---

### TAREA 4: Implementar flujo de consulta médica

**Crear `src/handlers/consultationHandler.js`:**

Después de que el formulario está completo, el bot entra en fase de consulta:

1. **Mensaje de transición** (al completar el formulario):
   ```
   "Perfecto, tus datos quedaron registrados. Ahora cuéntame, ¿cómo te sientes y cuál es el motivo de tu consulta?"
   ```

2. **Esta fase usa Gemini AI** pero con un system instruction actualizado que:
   - Sabe que ya tiene los datos del paciente (se le pasan como contexto).
   - Debe preguntar síntomas y motivo de consulta de forma conversacional.
   - Puede dar orientaciones generales (NO diagnósticos serios). Ejemplo: "Por lo que describes, podría tratarse de un resfrío común" o "Parece una molestia muscular leve".
   - Después de obtener suficiente información (2-3 intercambios sobre síntomas), debe generar un resumen/mini-formulario de la consulta.
   - El resumen se guarda en la tabla `consultations`.

3. **Mini-formulario de resumen** (el bot lo envía al paciente):
   ```
   📋 Resumen de tu consulta:
   - Paciente: {nombre}
   - Motivo: {razón resumida}
   - Síntomas: {síntomas principales}
   - Orientación: {orientación del bot}
   
   Un profesional revisará tu caso. Te contactaremos para coordinar la hora de atención.
   ```

4. **Placeholder para citas:** La columna `appointment_status` queda en `'pending'`. No implementar notificación de citas aún, pero dejar la estructura lista. Agregar un comentario `// TODO: Implementar notificación de cita cuando esté definido el flujo de agendamiento` en el lugar apropiado.

---

### TAREA 5: Modificar el flujo principal en `webhook.js`

**Cambiar `handleInboundBatch` en `src/routes/webhook.js`:**

El nuevo flujo de procesamiento debe ser:

```
1. Recibir mensaje
2. Chequeos de política (emergencia → responder y salir)
3. Buscar paciente en BD por teléfono (from)
   a. Si no existe → crearlo en BD, setear estado WELCOME
4. Verificar estado del paciente:
   a. Si estado es WELCOME → 
      - Enviar mensaje de bienvenida + informar sobre formulario
      - Avanzar estado a AWAITING_RUT
      - Enviar primer prompt del formulario (pedir RUT)
   b. Si estado es AWAITING_* → 
      - Pasar al formHandler
      - Si formHandler retorna formComplete=true → enviar mensaje de transición a consulta
   c. Si estado es FORM_COMPLETE o CONSULTATION →
      - Verificar si hay consulta activa
      - Pasar a Gemini AI con el system instruction actualizado
      - Incluir datos del paciente como contexto adicional
5. Enviar respuesta al paciente
```

**IMPORTANTE:** Los chequeos de emergencia deben funcionar en CUALQUIER estado. Si el paciente escribe algo de emergencia en medio del formulario, debe recibir el mensaje de emergencia.

---

### TAREA 6: Actualizar mensaje de bienvenida y system instruction

**Modificar `src/botPrompt.js`:**

1. **Nuevo mensaje de bienvenida:**
   ```
   Hola 👋 Bienvenido(a) a Consultas Milenium Online.

   Soy Catalina, asistente del Dr. Luis Martínez. Para continuar con la atención, necesito que completes un breve formulario con tus datos.

   Comencemos: ¿cuál es tu RUT? (ej: 12.345.678-9)
   ```
   NOTA: El mensaje de bienvenida ahora incluye directamente la primera pregunta del formulario para no enviar dos mensajes separados.

2. **Actualizar el system instruction (`buildBotSystemInstruction`):**
   - Agregar instrucción explícita de mantener respuestas CORTAS (máximo 2-3 oraciones por mensaje).
   - Eliminar la sección de "Datos a recopilar de manera natural" porque ahora los datos se recopilan via formulario estructurado.
   - Agregar instrucción de que el bot ya tiene los datos del paciente y no debe volver a pedirlos.
   - Agregar instrucción sobre el flujo de consulta: preguntar síntomas → orientación general → resumen.
   - Agregar sección: "Estilo de respuesta: Sé directo y conciso. Máximo 2-3 oraciones. No repitas información. No uses listas largas."

3. **Reducir `BOT_MAX_WORDS` default** de 120 a 80 en `src/config.js`.

---

### TAREA 7: Actualizar `botPolicy.js`

- La función `getAutomatedReply` ya no debe retornar el `welcome` automático como lo hace ahora. El welcome ahora es parte del flujo del formulario.
- Eliminar el caso `isFirstInteraction` de `getAutomatedReply` — esa lógica se maneja ahora en el flujo principal del webhook.
- Mantener intactos los chequeos de emergencia y handoff humano — estos deben funcionar en cualquier momento.

---

### TAREA 8: Actualizar configuración y Docker

**`src/config.js`:**
- Agregar `DATABASE_PATH: process.env.DATABASE_PATH || './data/bot.db'` al objeto config.
- Reducir `BOT_MAX_WORDS` default a 80.

**`docker-compose.yml`:**
- Agregar volumen `./data:/app/data` al servicio `app`.

**`.gitignore`:**
- Agregar `data/` y `*.db`.

**`.dockerignore`:**
- Agregar `data/`.

**`package.json`:**
- La dependencia `better-sqlite3` debe agregarse con `npm install better-sqlite3`.

---

## Orden de Implementación Recomendado

1. Instalar `better-sqlite3` (`npm install better-sqlite3`)
2. Crear `src/services/database.js` (TAREA 1)
3. Crear `src/stores/patientFlowStore.js` (TAREA 2)
4. Crear `src/handlers/formHandler.js` (TAREA 3)
5. Crear `src/handlers/consultationHandler.js` (TAREA 4)
6. Actualizar `src/botPrompt.js` (TAREA 6)
7. Actualizar `src/botPolicy.js` (TAREA 7)
8. Actualizar `src/config.js` (TAREA 8)
9. Actualizar `src/routes/webhook.js` — flujo principal (TAREA 5)
10. Actualizar `src/app.js` — integrar nuevos servicios y stores
11. Actualizar `docker-compose.yml`, `.gitignore`, `.dockerignore` (TAREA 8)
12. Verificar que la app inicia sin errores (`node server.js`)

---

## Restricciones y Consideraciones

- **No romper funcionalidad existente:** Los chequeos de emergencia, handoff humano y dedup deben seguir funcionando.
- **Persistencia:** Los datos del formulario DEBEN persistir en SQLite. Si el bot se reinicia, un paciente que ya completó el formulario NO debe volver a llenarlo.
- **Recuperación de estado:** Al recibir un mensaje, siempre verificar primero en la BD si el paciente ya existe y si su formulario está completo. Usar eso para determinar el estado inicial en el `patientFlowStore`.
- **Sin migraciones complejas:** Usar `CREATE TABLE IF NOT EXISTS` para que la BD se auto-cree.
- **Mensajes cortos:** Todas las respuestas del bot (tanto automáticas como de Gemini) deben ser cortas y directas. Máximo 2-3 oraciones.
- **Citas médicas:** Dejar placeholder pero NO implementar el flujo de agendamiento ni notificaciones. Solo guardar `appointment_status: 'pending'`.
- **Compatibilidad Docker:** `better-sqlite3` es un módulo nativo que necesita compilación. El Dockerfile actual usa `node:22-bookworm-slim` que debería soportarlo, pero si hay problemas de compilación, agregar `RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*` antes del `npm ci` en el Dockerfile.
- **No cambiar la estructura de endpoints**: El webhook sigue siendo `POST /webhook` y `GET /webhook` para verificación. El health check sigue en `GET /health`.
