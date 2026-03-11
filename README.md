# wa-bot

Bot de WhatsApp Cloud API con Gemini para Consultas Milenium.

## Comportamiento actual

- Respuesta automatica inicial con el saludo de Catalina.
- Escalamiento inmediato de emergencias antes de consultar a Gemini.
- Derivacion inmediata si el usuario pide hablar con una persona o insiste en diagnostico.
- Respuestas de Gemini guiadas por un prompt clinico-comercial enfocado solo en consultas medicas online.
- Limite de 120 palabras por respuesta.

## Variables utiles

- `BOT_PRICE_TABLE`: tabla de valores para presupuesto inicial. Acepta `\n` para saltos de linea.
- `BOT_SYSTEM_INSTRUCTION`: agrega instrucciones extra al prompt base.
- `BOT_WELCOME_MESSAGE`: override del saludo inicial.
- `BOT_HUMAN_HANDOFF_MESSAGE`: mensaje para derivacion humana.
- `BOT_EMERGENCY_MESSAGE`: mensaje para emergencias.
- `BOT_MAX_WORDS`: maximo de palabras por respuesta. Por defecto `120`.
- `BOT_SYSTEM_INSTRUCTION_OVERRIDE`: reemplaza por completo el prompt base del bot.

## Nota operativa

Si no configuras `BOT_PRICE_TABLE`, el bot no inventa montos y deriva el valor exacto al flujo humano o al pre-agendamiento.
