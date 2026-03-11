# Proyecto WhatsApp Bot - Notas de desarrollo

## ✅ Funcionalidades implementadas

- [x] Estructura del proyecto organizada en `src/` con rutas, servicios, stores y utilidades.
- [x] Servidor Express y webhook (`/webhook`) recibiendo y normalizando mensajes.
- [x] Stores para sesiones, deduplicación, buffer y cola de envío.
- [x] Servicios `whatsapp.js` y `gemini.js` (IA) con lógica encapsulada.
- [x] La IA conserva el contexto de la conversación entre mensajes.
- [x] Logging y manejo de timeouts centralizados.
- [x] Bot operativo 24/7 en VPS con dominio `moniessense.store`.
- [x] Verificación de Meta vía GitHub Pages y app configurada en WhatsApp Business.
- [x] Estado "escribiendo" activo y reconexión automática ante errores.
- [x] Fallbacks básicos para audios, imágenes y otros medios no textuales.
- [x] Despliegue con Docker/`docker-compose`, SSL/TLS y supervisión (`pm2`).
- [x] Comunicación segura en el webhook y configuración de variables de entorno.

## 🚀 Integración y arquitectura

- API propia abstrae WhatsApp y permite cambiar proveedor de IA.
- Mensajes pasan por validación, buffer, dedupe, IA y cola antes de enviar.
- Sesiones de usuarios en `conversationStore` y logs en cada etapa.
- Variables de entorno centralizadas en `config.js`.

## 📡 Despliegue y operación

- VPS con Node.js, Docker y SSL listo.
- Despliegue automatizado, reboot y monitoreo activo.

## 📝 Pendientes / Próximos pasos

- [ ] Backup automático de chats y base de datos de clientes.
- [ ] Migrar a VPS privada
- [ ] Dominio final y API de IA propia (reemplazo de Gemini).
- [ ] Ajustar comportamiento de IA
- [ ] Coexistencia con app móvil.

---

## ❓ Preguntas

- ¿Qué datos de los usuarios/consultas son prioritarios para almacenar? (nombre, teléfono, historial, etiquetas...)
- ¿Cuál debe ser el flujo ideal del usuario desde el primer mensaje hasta el final?
- ¿Qué comportamiento específico esperan de la IA?
- Coordinar una reunión para entender a fondo el funcionamiento final del producto y requisitos adicionales.
