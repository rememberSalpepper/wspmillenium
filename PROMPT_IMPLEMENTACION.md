# Prompt para Agente de Implementación

## Contexto del Proyecto

Eres un agente especializado en implementar mejoras en un bot de WhatsApp para consultas médicas online. El proyecto actual utiliza:
- Node.js/Express
- WhatsApp Cloud API
- Google Gemini AI para respuestas
- Almacenamiento en memoria (sin BD persistente)

## Tarea Principal

Implementar un sistema completo de formulario de atención al cliente que recolecte datos, los valide, almacene en base de datos, y guíe al usuario a través de un flujo de consulta médica.

## Requerimientos Detallados

### 1. Formulario de Atención Inicial

**Objetivo:** Recolectar datos del cliente antes de continuar con la consulta médica.

**Datos a recolectar (en este orden):**
1. RUT (formato chileno: XX.XXX.XXX-X)
2. Nombre completo
3. Correo electrónico
4. Teléfono (opcional, ya disponible desde WhatsApp)
5. Dirección

**Comportamiento:**
- En el **primer mensaje** del usuario, el bot debe informar: "Para continuar con tu atención, necesito que completes un breve formulario. ¿Podrías ayudarme con eso?"
- El bot debe pedir **un máximo de 2 campos por mensaje** para no abrumar al usuario
- Los datos deben validarse antes de aceptarse
- Todos los datos deben guardarse en base de datos
- El bot debe recordar qué campos ya tiene y cuáles faltan

**Validaciones:**
- RUT: Formato válido chileno con dígito verificador correcto
- Email: Formato válido de email
- Nombre: Mínimo 2 palabras, sin números
- Dirección: No vacío, mínimo 10 caracteres

### 2. Verificación y Continuación del Flujo

**Comportamiento:**
- Una vez que **todos los datos del formulario estén completos**, el bot debe:
  1. Guardar los datos en la base de datos
  2. Confirmar: "Perfecto, ya tengo tus datos. Ahora, ¿cómo te sientes hoy?"
  3. Esperar respuesta del usuario sobre cómo se siente
  4. Preguntar: "¿Cuál es el motivo de tu consulta?"
  5. El usuario describe sus síntomas/motivo
  6. El bot puede sugerir **posibles diagnósticos** (nada muy serio, solo sugerencias generales como "podría ser un resfriado", "posible gastritis", etc.)
  7. Enviar un "mini formulario" (preguntas adicionales sobre síntomas específicos)
  8. Gestionar la hora con el doctor (guardar en BD, pero **NO notificar aún** - dejar preparado para futuro)

**Importante:** El bot NO debe continuar con preguntas médicas hasta que el formulario inicial esté 100% completo.

### 3. Respuestas Más Precisas y Concisas

**Problema actual:** El bot escribe textos muy largos.

**Solución:**
- Reducir el límite de palabras de 120 a **60 palabras máximo**
- Actualizar el prompt del sistema para enfatizar:
  - "Responde siempre en máximo 2-3 oraciones"
  - "Sé directo y conciso"
  - "Evita explicaciones largas"
- Mantener el tono profesional pero breve

## Especificaciones Técnicas

### Base de Datos (SQLite)

**Instalar:** `better-sqlite3` (más rápido y moderno que sqlite3)

**Schema requerido:**

```sql
-- Tabla de pacientes
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  rut TEXT,
  nombre TEXT,
  correo TEXT,
  telefono TEXT,
  direccion TEXT,
  form_completed BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabla de consultas
CREATE TABLE IF NOT EXISTS consultations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL,
  como_se_siente TEXT,
  motivo_consulta TEXT,
  sintomas_adicionales TEXT,
  diagnostico_sugerido TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES patients(id)
);

-- Tabla de citas (preparada para futuro)
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL,
  consultation_id INTEGER,
  fecha_hora DATETIME,
  estado TEXT DEFAULT 'pendiente',
  notificado BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES patients(id),
  FOREIGN KEY (consultation_id) REFERENCES consultations(id)
);
```

### Nuevos Archivos a Crear

1. **`src/database/db.js`**
   - Configurar conexión a SQLite
   - Función para inicializar BD (crear tablas si no existen)
   - Función para ejecutar queries

2. **`src/database/schema.sql`**
   - Contener todas las CREATE TABLE statements

3. **`src/stores/formStateStore.js`**
   - Manejar estado del formulario por usuario (phone)
   - Campos: `{ phone, currentField, completedFields, allFields }`
   - Métodos: `getState(phone)`, `setField(phone, field, value)`, `isComplete(phone)`, `reset(phone)`

4. **`src/services/patientService.js`**
   - `getPatientByPhone(phone)`: Obtener paciente por teléfono
   - `createOrUpdatePatient(data)`: Crear o actualizar paciente
   - `isFormComplete(phone)`: Verificar si formulario está completo
   - `getMissingFields(phone)`: Obtener campos faltantes

5. **`src/services/consultationService.js`**
   - `createConsultation(patientId, data)`: Crear consulta
   - `createAppointment(patientId, consultationId, fechaHora)`: Crear cita (sin notificar)

6. **`src/utils/formValidators.js`**
   - `validateRUT(rut)`: Validar RUT chileno con dígito verificador
   - `validateEmail(email)`: Validar formato de email
   - `validateName(name)`: Validar nombre (mínimo 2 palabras)
   - `validateAddress(address)`: Validar dirección

### Archivos a Modificar

1. **`package.json`**
   - Agregar: `"better-sqlite3": "^9.0.0"`

2. **`src/config.js`**
   - Agregar: `DB_PATH: process.env.DB_PATH || './data/bot.db'`
   - Reducir: `BOT_MAX_WORDS: toNumber(process.env.BOT_MAX_WORDS, 60)` (de 120 a 60)

3. **`src/botPrompt.js`**
   - Modificar `DEFAULT_WELCOME_MESSAGE` para incluir mención al formulario
   - Actualizar `buildBotSystemInstruction` para:
     - Enfatizar respuestas concisas (máximo 2-3 oraciones)
     - Agregar instrucciones sobre el flujo del formulario
     - Indicar que NO debe continuar con consulta médica hasta formulario completo

4. **`src/botPolicy.js`**
   - Modificar `getAutomatedReply` para verificar estado del formulario
   - Si es primera interacción Y formulario incompleto → mensaje de formulario
   - Si formulario completo → permitir flujo normal

5. **`src/routes/webhook.js`**
   - Importar `formStateStore`, `patientService`, `consultationService`
   - En `handleInboundBatch`:
     - Verificar si formulario está completo
     - Si NO está completo:
       - Extraer datos del mensaje del usuario
       - Identificar qué campo está respondiendo
       - Validar y guardar campo
       - Pedir siguiente campo faltante
       - NO llamar a Gemini hasta formulario completo
     - Si SÍ está completo:
       - Verificar si ya preguntó "cómo se siente"
       - Si no, preguntar
       - Si ya preguntó, continuar con motivo de consulta
       - Llamar a Gemini solo para diagnóstico sugerido y respuestas generales

6. **`src/app.js`**
   - Inicializar base de datos al inicio
   - Pasar `patientService` y `consultationService` al webhook router

## Flujo de Implementación Detallado

### Paso 1: Setup de Base de Datos
1. Instalar `better-sqlite3`
2. Crear `src/database/db.js` con funciones de inicialización
3. Crear `src/database/schema.sql`
4. Crear directorio `data/` para el archivo .db
5. Inicializar BD en `src/app.js` al arrancar

### Paso 2: Servicios y Validadores
1. Crear `src/utils/formValidators.js` con todas las validaciones
2. Crear `src/services/patientService.js` con CRUD de pacientes
3. Crear `src/services/consultationService.js` con lógica de consultas y citas

### Paso 3: Estado del Formulario
1. Crear `src/stores/formStateStore.js`
2. Integrar con `patientService` para persistencia

### Paso 4: Modificar Flujo del Bot
1. Actualizar `src/botPrompt.js`:
   - Nuevo mensaje de bienvenida con formulario
   - Instrucciones más concisas
2. Actualizar `src/botPolicy.js`:
   - Lógica de verificación de formulario
3. Actualizar `src/routes/webhook.js`:
   - Integrar recolección de formulario
   - Modificar flujo para verificar formulario antes de Gemini

### Paso 5: Lógica de Consulta
1. En `webhook.js`, después de formulario completo:
   - Preguntar "¿Cómo te sientes?"
   - Guardar respuesta
   - Preguntar "Motivo de consulta"
   - Guardar respuesta
   - Usar Gemini para sugerir diagnósticos posibles (no serios)
   - Hacer preguntas adicionales (mini formulario)
   - Crear cita (sin notificar)

### Paso 6: Ajustes y Testing
1. Reducir `BOT_MAX_WORDS` a 60
2. Probar flujo completo
3. Ajustar mensajes para ser más concisos

## Validación de RUT Chileno

Implementar algoritmo de dígito verificador:
```javascript
function validateRUT(rut) {
  // Limpiar formato
  const clean = rut.replace(/[.\-]/g, '').toUpperCase();
  if (clean.length < 8) return false;
  
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  
  let sum = 0;
  let multiplier = 2;
  
  for (let i = body.length - 1; i >= 0; i--) {
    sum += parseInt(body[i]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  
  const remainder = sum % 11;
  const calculatedDV = remainder < 2 ? remainder.toString() : (11 - remainder).toString();
  
  if (calculatedDV === '10') return dv === 'K';
  return calculatedDV === dv;
}
```

## Mensajes del Bot

### Mensaje de Bienvenida (Actualizado)
```
Hola 👋 Bienvenido(a) a Consultas Milenium Online.

Soy Catalina, asistente del Dr. Luis Martínez.

Para continuar con tu atención, necesito que completes un breve formulario con tus datos. ¿Podrías ayudarme con eso?
```

### Mensajes de Recolección de Datos
- "Perfecto. Para comenzar, ¿podrías darme tu RUT? (formato: XX.XXX.XXX-X)"
- "Gracias. Ahora necesito tu nombre completo."
- "Excelente. ¿Cuál es tu correo electrónico?"
- "Perfecto. Por último, ¿cuál es tu dirección completa?"

### Mensaje de Confirmación
```
Perfecto, ya tengo todos tus datos registrados. 

Ahora, ¿cómo te sientes hoy?
```

### Después de Consulta
```
Entiendo. Basado en lo que describes, podría ser [diagnóstico sugerido no serio]. 

Para darte una mejor atención, necesito hacerte algunas preguntas adicionales sobre tus síntomas.
```

## Consideraciones Importantes

1. **No romper funcionalidad existente:**
   - Mantener detección de emergencias
   - Mantener derivación a humano
   - Mantener todas las políticas actuales

2. **Persistencia:**
   - El estado del formulario debe persistir entre reinicios
   - Usar BD para almacenar progreso

3. **Manejo de Errores:**
   - Si validación falla, explicar claramente qué está mal
   - Permitir corregir datos incorrectos
   - No perder progreso si hay error

4. **Citas (Futuro):**
   - Guardar citas en BD con estado 'pendiente'
   - Campo `notificado = 0` para indicar que aún no se notifica
   - Preparar estructura para cuando se implemente notificación

5. **Respuestas Concisas:**
   - Máximo 60 palabras
   - Máximo 2-3 oraciones por respuesta
   - Ir directo al punto

## Testing

Probar los siguientes escenarios:
1. Usuario nuevo completa formulario correctamente
2. Usuario nuevo ingresa datos inválidos (debe corregir)
3. Usuario completa formulario y continúa con consulta
4. Usuario intenta saltarse formulario (debe insistir)
5. Usuario completa parcialmente y vuelve después (debe recordar progreso)
6. Respuestas del bot son concisas (< 60 palabras)

## Entregables

Al finalizar, el agente debe haber:
- ✅ Base de datos SQLite funcionando con todas las tablas
- ✅ Sistema de recolección de formulario completo
- ✅ Validaciones funcionando
- ✅ Flujo de consulta después del formulario
- ✅ Respuestas más concisas (máx 60 palabras)
- ✅ Citas guardadas en BD (sin notificar)
- ✅ Todo funcionando sin romper funcionalidad existente

## Notas Finales

- Mantener el código limpio y bien documentado
- Usar async/await consistentemente
- Manejar errores apropiadamente
- Seguir el estilo de código existente
- Hacer commits frecuentes con mensajes descriptivos
