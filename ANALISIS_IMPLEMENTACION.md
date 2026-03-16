# Análisis del Proyecto - Implementación de Formulario y Flujo de Atención

## 📋 Resumen del Proyecto Actual

### Arquitectura Existente
- **Stack**: Node.js + Express
- **IA**: Google Gemini API (gemini-2.5-flash)
- **API**: WhatsApp Cloud API (Meta)
- **Almacenamiento**: In-memory stores (ConversationStore, DedupStore, InboundBufferStore, SenderQueue)
- **Sin base de datos persistente**: Actualmente no hay BD para almacenar datos de clientes

### Flujo Actual
1. Usuario envía mensaje → Webhook recibe
2. Mensaje pasa por validación, deduplicación, buffer
3. Se verifica si es primera interacción → Mensaje de bienvenida
4. Se verifica emergencias → Mensaje de emergencia
5. Se verifica si pide humano → Derivación
6. Si no, se envía a Gemini con contexto de conversación
7. Respuesta se limita a 120 palabras y se envía

### Componentes Clave
- `src/routes/webhook.js`: Maneja webhooks de WhatsApp
- `src/botPolicy.js`: Lógica de respuestas automáticas (emergencias, bienvenida, derivación)
- `src/botPrompt.js`: Construye el prompt del sistema para Gemini
- `src/services/gemini.js`: Servicio de IA
- `src/services/whatsapp.js`: Servicio de WhatsApp
- `src/stores/conversationStore.js`: Almacena contexto de conversación en memoria

---

## 🎯 Requerimientos a Implementar

### 1. Sistema de Formulario de Atención

#### Datos a Recolectar
- **RUT**: Identificación única del cliente
- **Nombre**: Nombre completo
- **Correo**: Email del cliente
- **Teléfono**: Número de contacto (ya disponible desde WhatsApp, pero debe confirmarse/almacenarse)
- **Dirección**: Domicilio completo

#### Comportamiento Esperado
- En el **primer mensaje**, el bot debe informar que para continuar debe rellenar un formulario de atención
- El bot debe solicitar los datos de forma conversacional (no todo de una vez)
- Los datos deben almacenarse en base de datos
- El bot debe validar que todos los datos estén completos antes de continuar

### 2. Validación y Continuación del Flujo

#### Validación
- Verificar que todos los campos del formulario estén completos
- Validar formato de RUT (formato chileno)
- Validar formato de email
- Validar que el teléfono tenga formato válido

#### Flujo Post-Formulario
- Una vez validado el formulario completo:
  1. Preguntar al paciente cómo se siente
  2. Preguntar motivos de consulta
  3. El cliente entrega posibles diagnósticos (nada muy serio)
  4. Enviar un mini formulario (aún no definido completamente)
  5. Gestionar la hora con el doctor (por ahora NO notificar, pero dejar preparado para futuro)

### 3. Mejora de Respuestas del Bot

#### Problema Actual
- El bot a veces escribe textos muy grandes
- Necesita ser más preciso y conciso

#### Solución
- Reducir el límite de palabras (actualmente 120)
- Ajustar el prompt del sistema para ser más directo
- Mejorar la lógica de truncamiento

---

## 🏗️ Arquitectura Propuesta

### 1. Base de Datos

#### Opción Recomendada: SQLite
- **Ventajas**: 
  - No requiere servidor separado
  - Fácil de implementar
  - Suficiente para el volumen inicial
  - Fácil backup (un solo archivo)
- **Alternativa**: PostgreSQL (si se requiere más robustez)

#### Esquema de Base de Datos

```sql
-- Tabla de pacientes/clientes
CREATE TABLE pacientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_id TEXT UNIQUE NOT NULL,  -- ID de WhatsApp (número de teléfono)
  rut TEXT UNIQUE NOT NULL,
  nombre TEXT NOT NULL,
  correo TEXT NOT NULL,
  telefono TEXT NOT NULL,
  direccion TEXT NOT NULL,
  estado_formulario TEXT DEFAULT 'incompleto',  -- 'incompleto', 'completo', 'en_consulta'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabla de consultas
CREATE TABLE consultas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paciente_id INTEGER NOT NULL,
  sintomas TEXT,
  motivo_consulta TEXT,
  posibles_diagnosticos TEXT,
  estado TEXT DEFAULT 'pendiente',  -- 'pendiente', 'agendada', 'completada'
  fecha_consulta DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (paciente_id) REFERENCES pacientes(id)
);

-- Tabla de sesiones de formulario (para tracking en tiempo real)
CREATE TABLE formulario_sesiones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_id TEXT UNIQUE NOT NULL,
  rut TEXT,
  nombre TEXT,
  correo TEXT,
  telefono TEXT,
  direccion TEXT,
  ultimo_campo_solicitado TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 2. Nuevo Store: FormStateStore

#### Propósito
- Gestionar el estado del formulario por usuario
- Trackear qué campos faltan
- Validar datos antes de guardar

#### Implementación
```javascript
class FormStateStore {
  constructor({ db }) {
    this.db = db;
    this.memoryCache = new Map(); // Cache en memoria para acceso rápido
  }

  async getFormState(whatsappId) {
    // Obtener estado desde BD o memoria
  }

  async updateField(whatsappId, field, value) {
    // Actualizar campo específico
  }

  async isFormComplete(whatsappId) {
    // Verificar si todos los campos están completos
  }

  async savePatient(whatsappId) {
    // Guardar paciente completo en BD
  }
}
```

### 3. Servicio de Base de Datos

#### Implementación
```javascript
// src/services/database.js
class DatabaseService {
  constructor(dbPath) {
    this.db = new sqlite3.Database(dbPath);
    this.init();
  }

  async init() {
    // Crear tablas si no existen
  }

  async savePatient(data) { }
  async getPatient(whatsappId) { }
  async updatePatient(whatsappId, data) { }
  async saveConsulta(data) { }
}
```

### 4. Modificaciones al Flujo

#### En `src/routes/webhook.js`
1. **Antes de procesar con Gemini**:
   - Verificar estado del formulario del usuario
   - Si formulario incompleto → Modo recolección de datos
   - Si formulario completo → Modo consulta normal

2. **Modo recolección de datos**:
   - Extraer datos del mensaje usando IA o regex
   - Validar formato
   - Actualizar estado del formulario
   - Solicitar siguiente campo faltante
   - Cuando esté completo → Guardar en BD y cambiar a modo consulta

3. **Modo consulta**:
   - Flujo normal con Gemini
   - Recolectar síntomas y motivos
   - Guardar consulta en BD
   - Preparar para agendamiento (sin notificar aún)

#### En `src/botPolicy.js`
- Agregar función `isFormCollectionMode(whatsappId)` 
- Agregar función `getNextFormField(whatsappId)`
- Modificar `getAutomatedReply` para considerar estado del formulario

#### En `src/botPrompt.js`
- Modificar prompt para incluir instrucciones sobre formulario
- Hacer el prompt más conciso
- Agregar instrucciones para extraer datos del formulario

### 5. Validaciones

#### Validación de RUT (Chile)
```javascript
function validateRUT(rut) {
  // Formato: 12345678-9 o 12.345.678-9
  // Validar dígito verificador
}
```

#### Validación de Email
```javascript
function validateEmail(email) {
  // Regex básico de email
}
```

#### Validación de Teléfono
```javascript
function validatePhone(phone) {
  // Formato chileno: +56912345678 o 912345678
}
```

---

## 📝 Cambios Específicos por Archivo

### 1. `package.json`
- Agregar dependencia: `sqlite3` o `better-sqlite3`

### 2. `src/config.js`
- Agregar configuración de BD: `DB_PATH`

### 3. `src/app.js`
- Inicializar servicio de BD
- Inicializar FormStateStore
- Pasar stores al webhook router

### 4. `src/routes/webhook.js`
- Modificar `handleInboundBatch` para verificar estado del formulario
- Agregar lógica de recolección de datos
- Agregar validaciones antes de guardar

### 5. `src/botPolicy.js`
- Agregar funciones de estado de formulario
- Modificar lógica de respuestas automáticas

### 6. `src/botPrompt.js`
- Hacer prompt más conciso (reducir verbosidad)
- Agregar instrucciones para formulario
- Instrucciones para extraer datos estructurados

### 7. Nuevos archivos
- `src/services/database.js`: Servicio de BD
- `src/stores/formStateStore.js`: Store de estado de formulario
- `src/utils/validators.js`: Funciones de validación (RUT, email, teléfono)

---

## 🔄 Flujo Completo Propuesto

### Fase 1: Bienvenida y Formulario
1. Usuario envía primer mensaje
2. Bot responde: "Hola, para continuar necesito que completes un formulario de atención. ¿Podrías proporcionarme tu RUT?"
3. Usuario responde con RUT
4. Bot valida RUT y pregunta: "Perfecto. ¿Cuál es tu nombre completo?"
5. Usuario responde con nombre
6. Bot pregunta: "¿Cuál es tu correo electrónico?"
7. Usuario responde con email
8. Bot valida email y pregunta: "¿Cuál es tu número de teléfono?"
9. Usuario responde (o se usa el de WhatsApp)
10. Bot pregunta: "¿Cuál es tu dirección completa?"
11. Usuario responde con dirección
12. Bot valida que todo esté completo y guarda en BD
13. Bot confirma: "Gracias, tus datos han sido registrados. ¿Cómo te sientes hoy?"

### Fase 2: Consulta
14. Usuario describe cómo se siente
15. Bot pregunta: "¿Cuál es el motivo principal de tu consulta?"
16. Usuario describe motivo
17. Bot (usando IA) sugiere posibles diagnósticos (nada serio)
18. Bot envía mini formulario (a definir)
19. Bot gestiona hora (preparado pero sin notificar aún)

---

## ⚠️ Consideraciones Importantes

### Seguridad
- Validar y sanitizar todos los inputs
- Prevenir SQL injection
- Validar formato de datos antes de guardar

### Performance
- Cache en memoria para acceso rápido a estado de formulario
- Limpiar sesiones de formulario antiguas
- Índices en BD para búsquedas rápidas

### UX
- No pedir todos los datos de una vez
- Validar en tiempo real
- Mensajes claros y concisos
- Permitir corregir datos si el usuario se equivoca

### Escalabilidad Futura
- Preparar estructura para agendamiento (tabla de horarios, doctores)
- Preparar notificaciones (webhooks, emails, etc.)
- Considerar migración a PostgreSQL si crece el volumen

---

## 🧪 Testing

### Casos de Prueba
1. Usuario completa formulario correctamente
2. Usuario proporciona RUT inválido
3. Usuario proporciona email inválido
4. Usuario abandona formulario a mitad
5. Usuario intenta completar formulario dos veces
6. Usuario corrige un dato después de proporcionarlo
7. Flujo completo: formulario → consulta → diagnóstico

---

## 📦 Dependencias Nuevas

```json
{
  "better-sqlite3": "^9.0.0"  // O "sqlite3": "^5.1.6"
}
```

---

## 🚀 Plan de Implementación

1. **Setup de Base de Datos**
   - Instalar dependencia
   - Crear servicio de BD
   - Crear esquema de tablas

2. **FormStateStore**
   - Implementar store
   - Integrar con BD
   - Agregar validaciones

3. **Modificar Flujo de Webhook**
   - Agregar verificación de estado de formulario
   - Implementar modo recolección
   - Integrar validaciones

4. **Ajustar Bot Prompt**
   - Hacer más conciso
   - Agregar instrucciones de formulario

5. **Testing**
   - Probar flujo completo
   - Validar casos edge
   - Ajustar según resultados

---

## 📌 Notas Finales

- El sistema actual usa stores en memoria, así que la integración de BD debe ser cuidadosa para no romper la funcionalidad existente
- El agendamiento está preparado pero no implementado (solo estructura de BD)
- Las respuestas del bot deben ser más cortas y directas
- El formulario debe ser conversacional, no un interrogatorio
