# Análisis del Proyecto y Plan de Implementación

## Resumen del Proyecto Actual

El proyecto es un bot de WhatsApp que utiliza:
- **WhatsApp Cloud API** para recibir y enviar mensajes
- **Google Gemini AI** para generar respuestas inteligentes
- **Node.js/Express** como backend
- **Almacenamiento en memoria** (ConversationStore, DedupStore) - NO hay base de datos persistente

### Estructura Actual:
- `server.js`: Punto de entrada
- `src/app.js`: Configuración de Express y stores
- `src/routes/webhook.js`: Manejo de webhooks de WhatsApp
- `src/services/whatsapp.js`: Servicio para enviar mensajes
- `src/services/gemini.js`: Servicio para generar respuestas con Gemini
- `src/botPrompt.js`: Construcción del prompt del sistema
- `src/botPolicy.js`: Lógica de respuestas automáticas (bienvenida, emergencias, derivación)
- `src/stores/`: Stores en memoria (conversaciones, deduplicación, buffer)

### Flujo Actual:
1. Usuario envía mensaje → Webhook recibe
2. Se verifica si es primera interacción → Mensaje de bienvenida automático
3. Se verifica emergencias → Respuesta automática de urgencia
4. Se verifica si pide humano/diagnóstico → Derivación automática
5. Si no hay respuesta automática → Gemini genera respuesta basada en conversación

## Requerimientos a Implementar

### 1. Formulario de Atención Inicial
**Datos a recolectar:**
- RUT
- Nombre
- Correo
- Teléfono
- Dirección

**Comportamiento:**
- El primer mensaje debe informar que para continuar debe rellenar un formulario
- Los datos deben almacenarse en base de datos
- El bot debe guiar al usuario para completar el formulario campo por campo

### 2. Verificación y Continuación
**Comportamiento:**
- Verificar que todos los datos estén completos
- Si están completos, continuar con:
  - Preguntar cómo se siente
  - Motivos de consulta
  - El bot puede sugerir posibles diagnósticos (nada muy serio)
  - Enviar un mini formulario (probablemente para síntomas adicionales)
  - Gestionar la hora con el doctor (sin notificar aún, pero preparado para futuro)

### 3. Respuestas Más Precisas
**Problema actual:**
- El bot a veces escribe textos muy grandes
- Límite actual: 120 palabras (BOT_MAX_WORDS)

**Solución:**
- Reducir límite de palabras (sugerido: 60-80 palabras)
- Ajustar el prompt del sistema para ser más conciso
- Mejorar la lógica de truncamiento

## Arquitectura Propuesta

### 1. Base de Datos
**Opción recomendada: SQLite** (simple, sin dependencias externas)
- Tabla `patients`: Almacenar datos del formulario
- Tabla `consultations`: Almacenar consultas
- Tabla `appointments`: Almacenar citas (preparado para futuro)

**Schema propuesto:**
```sql
CREATE TABLE patients (
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

CREATE TABLE consultations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER,
  sintomas TEXT,
  motivo_consulta TEXT,
  diagnostico_sugerido TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES patients(id)
);

CREATE TABLE appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER,
  consultation_id INTEGER,
  fecha_hora DATETIME,
  estado TEXT DEFAULT 'pendiente',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES patients(id),
  FOREIGN KEY (consultation_id) REFERENCES consultations(id)
);
```

### 2. Sistema de Estados del Formulario
Crear un nuevo store: `FormStateStore` que maneje:
- Estado del formulario por usuario (phone)
- Campos completados
- Campo actual que se está solicitando
- Validación de datos

### 3. Flujo Modificado

```
Usuario envía primer mensaje
  ↓
¿Es primera interacción?
  ↓ SÍ
Mensaje: "Para continuar necesitas completar un formulario..."
  ↓
Iniciar recolección de datos (RUT, nombre, correo, teléfono, dirección)
  ↓
¿Todos los datos completos?
  ↓ NO
Seguir pidiendo datos faltantes (1-2 por mensaje)
  ↓ SÍ
Guardar en BD
  ↓
Preguntar: "¿Cómo te sientes?" y "Motivos de consulta"
  ↓
Usuario responde
  ↓
Bot sugiere diagnósticos posibles (no serios)
  ↓
Enviar mini formulario (síntomas adicionales)
  ↓
Gestionar hora con doctor (guardar en BD, sin notificar aún)
```

### 4. Modificaciones de Código Necesarias

#### A. Nuevos Archivos:
- `src/database/db.js`: Configuración de SQLite
- `src/database/migrations.js`: Crear tablas
- `src/stores/formStateStore.js`: Manejo de estado del formulario
- `src/services/patientService.js`: Lógica de negocio para pacientes
- `src/services/consultationService.js`: Lógica de negocio para consultas
- `src/utils/formValidators.js`: Validadores para RUT, email, etc.

#### B. Archivos a Modificar:
- `src/routes/webhook.js`: 
  - Agregar lógica de verificación de formulario
  - Integrar FormStateStore
  - Llamar a servicios de BD antes de Gemini
  
- `src/botPolicy.js`:
  - Modificar mensaje de bienvenida para mencionar formulario
  - Agregar lógica para detectar si el formulario está completo
  
- `src/botPrompt.js`:
  - Reducir límite de palabras sugerido
  - Agregar instrucciones sobre formulario
  - Instrucciones para ser más conciso
  
- `package.json`:
  - Agregar dependencia: `better-sqlite3` o `sqlite3`

### 5. Validaciones Necesarias

- **RUT**: Formato chileno (XX.XXX.XXX-X)
- **Email**: Formato válido
- **Teléfono**: Formato chileno (opcional, ya viene del WhatsApp)
- **Nombre**: Mínimo 2 palabras
- **Dirección**: No vacío

### 6. Mejoras de Respuestas

- Reducir `BOT_MAX_WORDS` de 120 a 60-80
- Actualizar prompt del sistema para enfatizar brevedad
- Agregar instrucciones específicas: "Responde en máximo 2-3 oraciones"

## Consideraciones Técnicas

1. **Persistencia**: SQLite es suficiente para empezar, fácil migrar a PostgreSQL después
2. **Estado del Formulario**: Mantener en memoria (FormStateStore) + BD para persistencia
3. **Validación de RUT**: Implementar algoritmo de dígito verificador chileno
4. **Manejo de Errores**: Validar datos antes de guardar, dar feedback claro al usuario
5. **Compatibilidad**: Mantener funcionalidad existente (emergencias, derivación, etc.)

## Orden de Implementación Sugerido

1. Instalar dependencias de BD (better-sqlite3)
2. Crear schema de BD y migraciones
3. Crear servicios de BD (patientService, consultationService)
4. Crear FormStateStore
5. Crear validadores
6. Modificar botPolicy para nuevo mensaje de bienvenida
7. Modificar webhook.js para integrar flujo de formulario
8. Actualizar botPrompt para respuestas más concisas
9. Agregar lógica de consulta y diagnóstico
10. Agregar lógica de citas (sin notificación)
11. Testing y ajustes
