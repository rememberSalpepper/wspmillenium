# Prompt para Agente de Implementación

## Contexto del Proyecto

Eres un agente especializado en implementar mejoras en un bot de WhatsApp que utiliza Node.js, Express, WhatsApp Cloud API y Google Gemini AI. El proyecto actual tiene:

- Sistema de webhooks para recibir mensajes de WhatsApp
- Integración con Gemini AI para respuestas inteligentes
- Stores en memoria para gestión de conversaciones (ConversationStore, DedupStore, InboundBufferStore, SenderQueue)
- Sistema de políticas para respuestas automáticas (emergencias, bienvenida, derivación)
- Límite de 120 palabras por respuesta

**Ubicación del código**: `/workspace`
**Branch actual**: `cursor/proceso-atenci-n-cliente-bot-bf3f`

---

## Tarea Principal

Implementar un sistema completo de formulario de atención al cliente y mejorar el flujo de consulta médica con las siguientes características:

### 1. Sistema de Formulario de Atención

**Requerimientos:**
- En el primer mensaje, el bot debe informar que para continuar debe rellenar un formulario de atención
- El bot debe recolectar los siguientes datos de forma conversacional (uno o dos a la vez):
  - **RUT** (formato chileno, con validación de dígito verificador)
  - **Nombre completo**
  - **Correo electrónico** (con validación de formato)
  - **Teléfono** (puede usar el de WhatsApp, pero debe confirmarse/almacenarse)
  - **Dirección completa**
- Todos los datos deben almacenarse en una base de datos SQLite
- El bot debe validar que todos los datos estén completos antes de continuar al siguiente paso
- El formulario debe ser conversacional, no un interrogatorio

**Implementación técnica:**
- Crear servicio de base de datos (`src/services/database.js`) usando `better-sqlite3`
- Crear esquema de BD con tablas: `pacientes`, `consultas`, `formulario_sesiones`
- Crear `FormStateStore` (`src/stores/formStateStore.js`) para gestionar estado del formulario
- Crear utilidades de validación (`src/utils/validators.js`) para RUT, email y teléfono
- Modificar `src/routes/webhook.js` para detectar estado del formulario y recolectar datos
- Modificar `src/botPolicy.js` para incluir lógica de formulario
- Actualizar `src/botPrompt.js` para incluir instrucciones sobre formulario

### 2. Validación y Flujo Post-Formulario

**Requerimientos:**
- Una vez que el formulario esté completo y validado:
  1. El bot pregunta: "¿Cómo te sientes hoy?"
  2. El bot pregunta: "¿Cuál es el motivo principal de tu consulta?"
  3. El cliente describe síntomas/motivos
  4. El bot (usando IA) sugiere posibles diagnósticos (nada muy serio)
  5. Se envía un mini formulario (estructura básica, puede expandirse después)
  6. Se gestiona la hora con el doctor (por ahora NO notificar, pero dejar estructura preparada para futuro)

**Implementación técnica:**
- Agregar estados de conversación: `formulario_incompleto`, `formulario_completo`, `en_consulta`
- Guardar consultas en tabla `consultas` con relación a `pacientes`
- Modificar prompt de Gemini para que sugiera diagnósticos simples (nada serio)
- Preparar estructura de BD para agendamiento (campo `fecha_consulta` en tabla `consultas`)

### 3. Mejora de Respuestas del Bot

**Problema actual:** El bot a veces escribe textos muy grandes

**Solución:**
- Reducir límite de palabras de 120 a 80 palabras por respuesta
- Modificar `src/botPrompt.js` para hacer el prompt más conciso y directo
- Agregar instrucciones explícitas: "Sé breve y directo. Máximo 80 palabras por respuesta."
- Mejorar la función `limitReplyWords` si es necesario

---

## Especificaciones Técnicas Detalladas

### Base de Datos SQLite

**Esquema:**

```sql
-- Tabla de pacientes
CREATE TABLE pacientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_id TEXT UNIQUE NOT NULL,
  rut TEXT UNIQUE NOT NULL,
  nombre TEXT NOT NULL,
  correo TEXT NOT NULL,
  telefono TEXT NOT NULL,
  direccion TEXT NOT NULL,
  estado_formulario TEXT DEFAULT 'incompleto',
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
  estado TEXT DEFAULT 'pendiente',
  fecha_consulta DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (paciente_id) REFERENCES pacientes(id)
);

-- Tabla de sesiones de formulario (para tracking)
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

**Ubicación del archivo BD:** `./data/bot.db` (crear directorio `data/` si no existe)

### Validaciones Requeridas

**RUT (Chile):**
- Formato: `12345678-9` o `12.345.678-9`
- Validar dígito verificador usando algoritmo chileno
- Función: `validateRUT(rut)` en `src/utils/validators.js`

**Email:**
- Validar formato básico con regex
- Función: `validateEmail(email)` en `src/utils/validators.js`

**Teléfono:**
- Aceptar formato chileno: `+56912345678`, `912345678`, `+56 9 1234 5678`
- Función: `validatePhone(phone)` en `src/utils/validators.js`

### Flujo de Estados

El bot debe manejar estos estados por usuario:

1. **`sin_formulario`**: Usuario nuevo, no ha iniciado formulario
2. **`formulario_incompleto`**: Usuario está completando formulario
3. **`formulario_completo`**: Formulario completo, puede iniciar consulta
4. **`en_consulta`**: Usuario está en proceso de consulta médica

### Modificaciones a Archivos Existentes

**`package.json`:**
- Agregar: `"better-sqlite3": "^9.0.0"`

**`src/config.js`:**
- Agregar: `DB_PATH: process.env.DB_PATH || './data/bot.db'`
- Reducir: `BOT_MAX_WORDS: toNumber(process.env.BOT_MAX_WORDS, 80)` (de 120 a 80)

**`src/app.js`:**
- Importar y inicializar `DatabaseService`
- Importar y crear `FormStateStore`
- Pasar ambos al webhook router

**`src/routes/webhook.js`:**
- En `handleInboundBatch`, antes de procesar con Gemini:
  - Obtener estado del formulario del usuario
  - Si `formulario_incompleto`: Extraer datos del mensaje y actualizar formulario
  - Si `sin_formulario`: Iniciar formulario
  - Si `formulario_completo`: Continuar con flujo normal de consulta
- Agregar función `processFormCollection` para manejar recolección de datos
- Agregar función `extractFormData` para extraer datos del mensaje usando IA o regex

**`src/botPolicy.js`:**
- Agregar función `getFormState(whatsappId, formStateStore)`
- Agregar función `getNextFormField(whatsappId, formStateStore)`
- Modificar `getAutomatedReply` para considerar estado del formulario
- Si formulario incompleto, retornar respuesta automática solicitando siguiente campo

**`src/botPrompt.js`:**
- Hacer el prompt más conciso (reducir verbosidad)
- Agregar sección sobre formulario:
  ```
  'Formulario de atención:',
  '- Si el usuario no ha completado el formulario, solicita los datos faltantes de forma conversacional.',
  '- Los datos requeridos son: RUT, nombre completo, correo, teléfono, dirección.',
  '- Solicita máximo 1-2 datos por mensaje.',
  '- Valida que los datos tengan formato correcto antes de aceptarlos.',
  '- Una vez completo, confirma y pregunta cómo se siente el paciente.',
  ].join('\n')
  ```
- Cambiar límite de palabras en instrucciones: "Mantén cada respuesta bajo 80 palabras."
- Agregar: "Sé breve, directo y profesional. Evita textos largos."

### Nuevos Archivos a Crear

1. **`src/services/database.js`**
   - Clase `DatabaseService` con métodos:
     - `init()`: Crear tablas
     - `savePatient(data)`: Guardar paciente
     - `getPatient(whatsappId)`: Obtener paciente
     - `updatePatient(whatsappId, data)`: Actualizar paciente
     - `saveConsulta(data)`: Guardar consulta
     - `getFormSession(whatsappId)`: Obtener sesión de formulario
     - `updateFormSession(whatsappId, data)`: Actualizar sesión

2. **`src/stores/formStateStore.js`**
   - Clase `FormStateStore` con métodos:
     - `getState(whatsappId)`: Obtener estado del formulario
     - `updateField(whatsappId, field, value)`: Actualizar campo
     - `isComplete(whatsappId)`: Verificar si está completo
     - `saveToDatabase(whatsappId)`: Guardar en BD y cambiar estado
     - `reset(whatsappId)`: Reiniciar formulario (por si acaso)

3. **`src/utils/validators.js`**
   - `validateRUT(rut)`: Validar RUT chileno
   - `validateEmail(email)`: Validar email
   - `validatePhone(phone)`: Validar teléfono
   - Funciones helper para normalizar datos

---

## Flujo de Implementación Sugerido

1. **Setup inicial:**
   - Instalar `better-sqlite3`
   - Crear directorio `data/`
   - Crear `src/services/database.js` con esquema básico

2. **Validadores:**
   - Crear `src/utils/validators.js` con todas las validaciones
   - Probar validaciones con casos edge

3. **FormStateStore:**
   - Crear `src/stores/formStateStore.js`
   - Integrar con DatabaseService
   - Probar operaciones CRUD

4. **Modificar botPolicy:**
   - Agregar lógica de formulario
   - Integrar con FormStateStore

5. **Modificar webhook:**
   - Agregar detección de estado de formulario
   - Implementar recolección de datos
   - Integrar validaciones

6. **Ajustar prompt:**
   - Hacer más conciso
   - Agregar instrucciones de formulario
   - Reducir límite de palabras

7. **Testing:**
   - Probar flujo completo
   - Validar casos edge
   - Ajustar según resultados

---

## Consideraciones Importantes

### Seguridad
- Sanitizar todos los inputs antes de guardar en BD
- Usar prepared statements para prevenir SQL injection
- Validar formato antes de aceptar datos

### Performance
- Usar cache en memoria para estado de formulario (FormStateStore)
- Limpiar sesiones de formulario antiguas periódicamente
- Crear índices en BD para búsquedas rápidas

### UX
- No pedir todos los datos de una vez
- Validar en tiempo real y dar feedback claro
- Mensajes cortos y claros
- Permitir que el usuario corrija datos si se equivoca

### Compatibilidad
- No romper funcionalidad existente
- Mantener stores en memoria funcionando
- Integrar BD de forma no intrusiva

---

## Mensajes del Bot

### Mensaje de inicio de formulario:
```
"Hola 👋 Para continuar con tu atención, necesito que completes un breve formulario. ¿Podrías proporcionarme tu RUT?"
```

### Mensajes de solicitud de campos:
- RUT: "¿Podrías proporcionarme tu RUT?"
- Nombre: "Perfecto. ¿Cuál es tu nombre completo?"
- Email: "¿Cuál es tu correo electrónico?"
- Teléfono: "¿Cuál es tu número de teléfono? (puedo usar el de WhatsApp si prefieres)"
- Dirección: "¿Cuál es tu dirección completa?"

### Mensaje de confirmación:
```
"Gracias, tus datos han sido registrados correctamente. ¿Cómo te sientes hoy?"
```

### Mensajes de error de validación:
- RUT inválido: "El RUT que proporcionaste no es válido. Por favor, ingrésalo en formato 12345678-9"
- Email inválido: "El correo electrónico no tiene un formato válido. Por favor, ingrésalo nuevamente."
- Teléfono inválido: "El número de teléfono no es válido. Por favor, ingrésalo nuevamente."

---

## Testing

Asegúrate de probar:
1. ✅ Usuario completa formulario correctamente
2. ✅ Usuario proporciona RUT inválido → Bot pide corregir
3. ✅ Usuario proporciona email inválido → Bot pide corregir
4. ✅ Usuario abandona formulario y vuelve → Continúa donde quedó
5. ✅ Usuario completa formulario dos veces → No duplica datos
6. ✅ Usuario corrige un dato → Se actualiza correctamente
7. ✅ Flujo completo: formulario → consulta → diagnóstico
8. ✅ Respuestas del bot son más cortas (máximo 80 palabras)

---

## Entregables

Al finalizar, debes:
1. ✅ Todos los archivos modificados y nuevos implementados
2. ✅ Base de datos funcionando con esquema correcto
3. ✅ Formulario recolectando datos correctamente
4. ✅ Validaciones funcionando
5. ✅ Flujo completo operativo
6. ✅ Respuestas del bot más cortas
7. ✅ Código commiteado y pusheado al branch `cursor/proceso-atenci-n-cliente-bot-bf3f`
8. ✅ Documentación actualizada si es necesario

---

## Notas Finales

- **NO implementar notificaciones de agendamiento aún**, solo dejar estructura preparada
- **Mantener compatibilidad** con funcionalidad existente
- **Priorizar UX**: formulario conversacional, no interrogatorio
- **Código limpio**: comentarios donde sea necesario, funciones bien nombradas
- **Manejo de errores**: try/catch apropiados, logs informativos

¡Comienza la implementación!
