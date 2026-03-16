# Prompt de Implementación — Bot WhatsApp Consultas Millenium

## Contexto del Proyecto

Bot de WhatsApp para telemedicina (Consultas Millenium) construido con:
- **Node.js 22** + **Express 5** + **Gemini AI** (`@google/genai`)
- **WhatsApp Cloud API** (Meta Graph API)
- **Docker** para deploy
- Todo el estado actual es **in-memory** (no hay base de datos)
- Los archivos principales están en `/workspace/src/`

### Estructura actual:
```
server.js                    → Entry point
src/app.js                   → Express setup, stores, servicios
src/config.js                → Variables de entorno
src/botPrompt.js             → System prompt para Gemini
src/botPolicy.js             → Reglas automáticas (emergencia, welcome, handoff)
src/logger.js                → JSON logger
src/routes/webhook.js        → POST/GET /webhook, handleInboundBatch
src/services/gemini.js       → generateReply con Gemini
src/services/whatsapp.js     → sendText, markAsReadAndTyping
src/stores/conversationStore.js → Historial de conversación in-memory
src/stores/dedupStore.js     → Deduplicación de mensajes
src/stores/inboundBufferStore.js → Buffer de mensajes entrantes
src/stores/senderQueue.js    → Cola por sender
src/utils/timeout.js         → withTimeout helper
docker-compose.yml           → Docker config
Dockerfile                   → Node 22 image
package.json                 → Dependencies
```

### Flujo actual de mensajes:
1. WhatsApp envía POST a `/webhook`
2. `extractEvents()` parsea el payload de Meta
3. `stageInboundMessage()` valida, deduplica, filtra mensajes viejos
4. `InboundBufferStore` agrupa mensajes rápidos del mismo sender (2.5s)
5. `SenderQueue` serializa procesamiento por sender
6. `handleInboundBatch()`:
   - Marca como leído + typing indicator
   - Agrega al `conversationStore`
   - Verifica `botPolicy` (emergencia/welcome/handoff) → respuesta automática
   - Si no aplica policy → llama a Gemini con historial de conversación
   - Limita respuesta a `BOT_MAX_WORDS` (120) y `MAX_REPLY_CHARS` (3500)
   - Envía respuesta por WhatsApp

### Datos importantes del config actual:
- `CONVERSATION_TTL_MS`: 24h
- `CONTEXT_MAX_TURNS`: 12
- `CONTEXT_MAX_CHARS`: 12000
- `BOT_MAX_WORDS`: 120
- `MESSAGE_BUFFER_MS`: 2500

---

## Requerimientos a Implementar

### 1. Formulario de Atención por WhatsApp

**Objetivo**: Cuando un paciente escribe por primera vez, el bot debe informar que para continuar debe completar un formulario de atención. Luego recopila los siguientes datos uno a uno a través de la conversación:

- **RUT** (formato chileno: 12.345.678-9 o 12345678-9)
- **Nombre completo**
- **Correo electrónico**
- **Teléfono de contacto**
- **Dirección** (con comuna)

**Reglas**:
- El mensaje de bienvenida debe informar claramente que se requiere completar el formulario antes de continuar.
- Pedir los datos de forma conversacional, uno o dos a la vez (no todos de golpe).
- Validar cada dato: RUT válido (módulo 11), email con formato correcto, teléfono con al menos 8 dígitos.
- Si un dato es inválido, pedir que lo corrija amablemente.
- Los datos deben quedar almacenados en una **base de datos persistente**.
- Si el paciente ya tiene datos registrados (mismo número de teléfono/sender), no volver a pedir el formulario.

### 2. Consulta Médica Post-Formulario

**Objetivo**: Una vez completados todos los datos del formulario, el bot pregunta al paciente:
- ¿Cómo se siente?
- Motivos de la consulta
- Síntomas que experimenta

El bot entrega **posibles diagnósticos leves** (nada grave — esto lo hace Gemini con instrucciones claras de no diagnosticar condiciones serias y siempre recomendar validar con el doctor).

Luego se genera un **mini resumen/formulario de consulta** con los datos del paciente + síntomas + posible orientación, que se almacena en la BD.

**Sobre el agendamiento**: La estructura debe quedar lista para agendar hora con el doctor a futuro, pero **por ahora NO se envía notificación ni se agenda realmente**. Solo se guarda el registro de la consulta con un campo `appointment_status = 'pending'`.

### 3. Respuestas Más Precisas y Cortas

**Objetivo**: Las respuestas del bot deben ser más breves y directas. Actualmente a veces genera textos largos.

**Acciones**:
- Reducir `BOT_MAX_WORDS` de 120 a **80**.
- Reescribir el system prompt para enfatizar brevedad extrema.
- Agregar reglas explícitas: "Máximo 2-3 oraciones por respuesta", "No repitas información que ya diste", "Sé directo".
- En el prompt de consulta médica, igualmente mantener respuestas cortas.

---

## Plan de Implementación Técnico

### Paso 1: Agregar Base de Datos (SQLite)

1. **Instalar `better-sqlite3`** como dependencia (`npm install better-sqlite3`).
2. Crear `src/database.js`:
   - Inicializar SQLite con WAL mode.
   - Crear tablas al iniciar:

```sql
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,          -- número WhatsApp (sender ID)
  rut TEXT,
  nombre TEXT,
  correo TEXT,
  telefono TEXT,
  direccion TEXT,
  form_completed INTEGER DEFAULT 0,    -- 0 = incompleto, 1 = completo
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS consultations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  sintomas TEXT,
  motivo_consulta TEXT,
  orientacion TEXT,                     -- posible diagnóstico leve del bot
  resumen TEXT,                         -- mini formulario generado
  appointment_status TEXT DEFAULT 'pending',  -- pending, scheduled, completed, cancelled
  appointment_date TEXT,                -- para uso futuro
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (patient_id) REFERENCES patients(id)
);
```

3. Exportar funciones:
   - `getPatientByPhone(phone)` → row o null
   - `upsertPatientField(phone, field, value)` → actualiza un campo
   - `markFormCompleted(phone)` → pone form_completed = 1
   - `isFormCompleted(phone)` → boolean
   - `createConsultation({ phone, patientId, sintomas, motivo, orientacion, resumen })` → id
   - `getLastConsultation(phone)` → row o null

4. En `docker-compose.yml`, agregar un volumen para persistir la BD:
```yaml
volumes:
  - ./data:/app/data
```
Y en `database.js` usar path `/app/data/bot.db` (o `./data/bot.db` en desarrollo).

5. En `Dockerfile`, crear el directorio `data`:
```dockerfile
RUN mkdir -p /app/data
```

### Paso 2: Máquina de Estados del Paciente

Crear `src/stores/patientFlowStore.js`:

```javascript
// Estados posibles del flujo
const FLOW_STATES = {
  WELCOME: 'welcome',
  COLLECTING_RUT: 'collecting_rut',
  COLLECTING_NOMBRE: 'collecting_nombre',
  COLLECTING_CORREO: 'collecting_correo',
  COLLECTING_TELEFONO: 'collecting_telefono',
  COLLECTING_DIRECCION: 'collecting_direccion',
  CONFIRMING_FORM: 'confirming_form',
  CONSULTATION: 'consultation',
  CONSULTATION_SUMMARY: 'consultation_summary',
  COMPLETED: 'completed',
};
```

- El store usa un `Map<phone, { state, lastUpdated }>` en memoria.
- Al iniciar, verificar en la BD si el paciente ya completó el formulario.
- Si `form_completed = 1` → saltar directo a `CONSULTATION`.
- Si hay datos parciales en BD → retomar desde el campo faltante.

### Paso 3: Lógica de Recolección de Formulario

Modificar `handleInboundBatch` en `src/routes/webhook.js`:

1. Después de verificar `botPolicy`, antes de llamar a Gemini:
   - Obtener el estado del flujo del paciente.
   - Si está en fase de formulario (`COLLECTING_*`):
     - Usar Gemini con un prompt específico para **extraer** el dato solicitado del mensaje del usuario.
     - Validar el dato extraído.
     - Si es válido → guardarlo en BD, avanzar al siguiente estado, pedir el siguiente dato.
     - Si es inválido → pedir que corrija.
   - Si está en `CONFIRMING_FORM`:
     - Mostrar resumen de datos y pedir confirmación.
     - Si confirma → `markFormCompleted`, pasar a `CONSULTATION`.
     - Si quiere corregir → volver al campo correspondiente.

2. Para la extracción de datos, usar un prompt tipo:
```
Extrae el [CAMPO] del siguiente mensaje del usuario. 
Responde SOLO con un JSON: {"value": "valor_extraido", "valid": true/false}
Si no puedes extraer el dato, responde: {"value": null, "valid": false}
```

3. Validaciones:
   - **RUT**: Formato chileno, validar dígito verificador (módulo 11).
   - **Email**: Regex básica de email.
   - **Teléfono**: Al menos 8 dígitos, opcionalmente +56.
   - **Nombre**: Al menos 2 palabras.
   - **Dirección**: Al menos 5 caracteres.

### Paso 4: Flujo de Consulta Médica

Después de completar el formulario:

1. Estado `CONSULTATION`:
   - Bot pregunta: "¿Cómo se siente? Cuénteme brevemente sus síntomas y el motivo de su consulta."
   - El paciente responde con síntomas y motivo.
   - El bot usa Gemini con un prompt médico orientativo (NO diagnóstico real):
     ```
     Eres un asistente médico orientativo. Basándote en los síntomas descritos, 
     entrega una orientación breve (máximo 2 oraciones) sobre posibles causas leves 
     y comunes. NUNCA diagnostiques condiciones graves. SIEMPRE indica que debe 
     validar con el doctor en la consulta.
     ```
   - Guardar síntomas y orientación en tabla `consultations`.

2. Estado `CONSULTATION_SUMMARY`:
   - Bot envía un mini resumen:
     ```
     📋 Resumen de su consulta:
     • Paciente: [nombre]
     • RUT: [rut]
     • Síntomas: [síntomas]
     • Orientación: [orientación]
     
     Un profesional revisará su caso. Le contactaremos para agendar su hora.
     ```
   - Guardar resumen en BD.
   - Cambiar estado a `COMPLETED`.

### Paso 5: Ajustar el System Prompt (botPrompt.js)

Reescribir `buildBotSystemInstruction` con las siguientes directrices:

```javascript
// Nuevo prompt más conciso y orientado al flujo
const sections = [
  // Identidad
  'Eres Catalina, asistente virtual de Consultas Millenium (telemedicina). Respondes por WhatsApp en español de Chile.',
  
  // Regla de brevedad (NUEVA Y MÁS ESTRICTA)
  [
    'REGLAS DE FORMATO OBLIGATORIAS:',
    '- Máximo 2-3 oraciones por mensaje.',
    '- No repitas información que ya diste.',
    '- Sé directa y concisa.',
    '- No uses listas largas ni explicaciones extensas.',
    '- Si el paciente pregunta algo simple, responde en 1 oración.',
  ].join('\n'),

  // Flujo (ajustado)
  [
    'FLUJO DE ATENCIÓN:',
    '- Primero se completa el formulario de atención (RUT, nombre, correo, teléfono, dirección).',
    '- Luego se consultan síntomas y motivo.',
    '- Finalmente se genera un resumen y se gestiona la hora médica.',
    '- No saltes pasos.',
  ].join('\n'),

  // Normas médicas (se mantienen)
  [
    'NORMAS MÉDICAS:',
    '- Nunca diagnostiques enfermedades graves.',
    '- Nunca prescribas medicamentos.',
    '- Ante síntomas de emergencia, indica ir a urgencias.',
    '- Siempre recomienda validar con el doctor.',
  ].join('\n'),
];
```

Reducir `BOT_MAX_WORDS` default de 120 a **80**.

### Paso 6: Actualizar Mensaje de Bienvenida

```javascript
const DEFAULT_WELCOME_MESSAGE = [
  'Hola 👋 Bienvenido(a) a Consultas Millenium.',
  '',
  'Soy Catalina, asistente del Dr. Luis Martínez.',
  '',
  'Para continuar, necesito que complete un breve formulario de atención.',
  '',
  'Comencemos: ¿Cuál es su RUT?',
].join('\n');
```

### Paso 7: Integración en el Flujo Principal

Modificar `handleInboundBatch` en `webhook.js`:

```javascript
async function handleInboundBatch(batch) {
  const from = batch?.senderId;
  const prompt = batch?.combinedText?.trim();
  
  // ... validaciones existentes ...

  // 1. Verificar policy (emergencia, handoff) — se mantiene
  const automatedReply = getAutomatedReply({ prompt, isFirstInteraction, config });
  if (automatedReply) { /* ... enviar ... */ return; }

  // 2. NUEVO: Obtener estado del flujo
  const flowState = patientFlowStore.getState(from);
  const patient = db.getPatientByPhone(from);

  // 3. NUEVO: Si está en fase de formulario
  if (isFormCollectionState(flowState)) {
    await handleFormCollection(from, prompt, flowState, patient);
    return;
  }

  // 4. NUEVO: Si está en fase de consulta
  if (flowState === 'consultation') {
    await handleConsultation(from, prompt, patient);
    return;
  }

  // 5. Si ya completó todo, Gemini normal con contexto
  // ... flujo existente con Gemini ...
}
```

### Paso 8: Archivos a crear/modificar

**CREAR:**
- `src/database.js` — Setup SQLite + funciones CRUD
- `src/stores/patientFlowStore.js` — Máquina de estados
- `src/validators.js` — Validadores (RUT, email, teléfono)
- `src/handlers/formHandler.js` — Lógica de recolección del formulario
- `src/handlers/consultationHandler.js` — Lógica de consulta médica

**MODIFICAR:**
- `src/botPrompt.js` — Prompt más conciso + nuevos prompts de extracción
- `src/botPolicy.js` — Ajustar welcome para incluir info del formulario
- `src/config.js` — Agregar config de DB path, reducir BOT_MAX_WORDS a 80
- `src/app.js` — Inicializar database, pasarla al router
- `src/routes/webhook.js` — Integrar flujo de formulario y consulta
- `package.json` — Agregar `better-sqlite3`
- `docker-compose.yml` — Agregar volumen para datos
- `Dockerfile` — Crear directorio data, instalar build tools para better-sqlite3

### Paso 9: Consideraciones de Docker

`better-sqlite3` requiere compilación nativa. Actualizar Dockerfile:
```dockerfile
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["npm", "start"]
```

---

## Notas Importantes

- **NO implementar agendamiento real todavía**. Solo guardar `appointment_status = 'pending'` en la tabla `consultations`. La estructura queda lista para cuando se defina el sistema de horas.
- **El formulario se completa UNA vez por paciente** (identificado por su número de WhatsApp). Si el paciente vuelve a escribir después, se salta directo a consulta o conversación libre.
- **Las validaciones deben ser amigables**: si el RUT es inválido, no decir "formato inválido", sino algo como "No pude verificar ese RUT, ¿podrías escribirlo de nuevo? Por ejemplo: 12.345.678-9"
- **La máquina de estados debe ser resiliente**: si el bot se reinicia, debe reconstruir el estado desde la BD (verificar qué campos tiene el paciente para determinar en qué paso está).
- **Mantener compatibilidad** con el flujo existente de emergencias y derivación a humanos — esos policies tienen prioridad siempre.
- **Ejecutar tests manuales** después de implementar para verificar que el flujo completo funciona.
