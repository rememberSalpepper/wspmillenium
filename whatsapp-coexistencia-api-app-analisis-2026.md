# WhatsApp Cloud API + App móvil (Coexistencia) — análisis actualizado (8 de marzo de 2026)

## 1) Qué se descargó en este proceso
Sí, durante la investigación se descargaron artefactos temporales en `/tmp` para poder extraer documentación oficial y comparar proveedores.

- Cantidad total de archivos: **36**
- Tamaño total: **23,953,697 bytes** (~**22.84 MB**)
- Ubicación: **`/tmp`** (archivos temporales del sistema)

### Inventario exacto
- `/tmp/cjs_1.js` (365005 bytes)
- `/tmp/cjs_2.js` (3424510 bytes)
- `/tmp/cjs_3.js` (1002654 bytes)
- `/tmp/cjs_4.js` (592005 bytes)
- `/tmp/cjs_5.js` (3050024 bytes)
- `/tmp/cjs_6.js` (282826 bytes)
- `/tmp/cjs_7.js` (845328 bytes)
- `/tmp/cjs_8.js` (489651 bytes)
- `/tmp/cjs_9.js` (383002 bytes)
- `/tmp/coexist.html` (737568 bytes)
- `/tmp/coexist_content.json` (293464 bytes)
- `/tmp/coexist_content_strings.txt` (74421 bytes)
- `/tmp/coexist_js_1.js` (365005 bytes)
- `/tmp/coexist_js_2.js` (3424510 bytes)
- `/tmp/coexist_js_3.js` (1002654 bytes)
- `/tmp/coexist_js_4.js` (592005 bytes)
- `/tmp/coexist_js_5.js` (3050024 bytes)
- `/tmp/coexist_js_6.js` (282826 bytes)
- `/tmp/coexist_js_7.js` (845328 bytes)
- `/tmp/coexist_js_8.js` (489651 bytes)
- `/tmp/coexist_js_9.js` (383002 bytes)
- `/tmp/coexist_resp.json` (280990 bytes)
- `/tmp/coexist_warm.html` (738350 bytes)
- `/tmp/layout_coexist.json` (125275 bytes)
- `/tmp/meta_docs_cookie.txt` (131 bytes)
- `/tmp/whatsapp_display-names.json` (117666 bytes)
- `/tmp/whatsapp_display-names_strings.txt` (9114 bytes)
- `/tmp/whatsapp_embedded-signup_pre-verified-numbers.json` (141875 bytes)
- `/tmp/whatsapp_embedded-signup_pre-verified-numbers_strings.txt` (21844 bytes)
- `/tmp/whatsapp_get-started.json` (110861 bytes)
- `/tmp/whatsapp_messaging-limits.json` (136940 bytes)
- `/tmp/whatsapp_messaging-limits_strings.txt` (8859 bytes)
- `/tmp/whatsapp_official-business-accounts.json` (119954 bytes)
- `/tmp/whatsapp_official-business-accounts_strings.txt` (12973 bytes)
- `/tmp/whatsapp_solution-providers_partner-led-business-verification.json` (135932 bytes)
- `/tmp/whatsapp_solution-providers_partner-led-business-verification_strings.txt` (17470 bytes)

## 2) ¿Se pueden eliminar?
Sí. **Se pueden eliminar sin impacto en tu número de WhatsApp ni en tu configuración de Meta**, porque son archivos temporales de investigación local.

Comando de limpieza:

```bash
rm -f /tmp/cjs_*.js /tmp/coexist_js_*.js /tmp/coexist* /tmp/layout_coexist.json /tmp/meta_docs_cookie.txt /tmp/whatsapp_*.json /tmp/whatsapp_*_strings.txt
```

## 3) Por qué hoy no puedes lograr “mismo número en API + app móvil” como lo pides (sin partner)
Tu objetivo exacto es:
- mismo número,
- funcionando a la vez en Cloud API y app WhatsApp Business,
- con sincronización de chats/mensajes,
- sin partner,
- idealmente sin verificación de negocio.

Con la documentación oficial actual de Meta, ese combo **no está disponible** en modo directo (sin partner/proveedor):

1. En la guía de Coexistence (última actualización detectada: **2026-02-04**) se pide como requisito operar como **Solution Partner** o **Tech Provider** para ese onboarding con app + Cloud API.
2. La sincronización (historial y ecos de mensajes) se maneja por webhooks específicos (`history`, `smb_app_state_sync`, `smb_message_echoes`) dentro de ese flujo.
3. Hay restricciones: historial hasta ~180 días (6 meses), chats de grupo no se incluyen en ese historial, y ventana de 24 horas para iniciar sincronización tras onboarding.
4. En coexistencia, Meta documenta throughput fijo de 20 mps para esos números.

Conclusión técnica: **sin partner/proveedor no se habilita el flujo oficial de coexistencia del mismo número con sync app+API**.

## 4) Sobre “no verificar negocio”
No hay una vía robusta de largo plazo para operar escalado serio sin verificaciones:

1. Meta documenta que portfolios nuevos arrancan en 250 mensajes y escalan (2k, 10k, 100k, ilimitado) por caminos que incluyen verificación o desempeño de plantillas.
2. Para OBA (check azul), Meta exige verificación de negocio + requisitos adicionales (nombre visible aprobado, 2FA, relevancia, etc.).
3. En documentación de partner (360dialog), para coexistencia se menciona que la verificación de negocio estándar no aplica en ese flujo y se usan alternativas como partner-led verification/Meta Verified (según caso).

Resumen práctico: puedes empezar pequeño sin verificar todo, pero para estabilidad, escala y funciones avanzadas normalmente terminas entrando a verificación (directa o vía partner).

## 5) Partners/proveedores que más te ajustan (bot IA para soporte)
Criterio de ajuste: prioridad en **coexistencia real (app+API mismo número)** + operación bot/IA + costo visible.

## 5.1 360dialog (mejor ajuste para tu requisito principal)
- Precio público base:
  - **$49/mes** (regular)
  - **$99/mes** (premium)
  - **$299/mes** (alta capacidad)
- Cobro de Meta aparte (conversaciones/plantillas).
- Tiene documentación explícita de coexistencia app+API y límites asociados.
- Encaje: **alto** para tu caso (mismo número + sync + bot IA encima de API).

## 5.2 Interakt (bueno para SMB si te sirve stack más “app-first”)
- Precio público en plan mensual:
  - **₹2499/mes** (Growth)
  - **₹3499/mes** (Advanced)
  - Enterprise: a medida
- Meta conversation charges aparte.
- Encaje: **medio**. Bueno para soporte con automatización, pero revisaría cobertura/región y detalles de coexistencia para tu país antes de decidir.

## 5.3 Vonage (enterprise/API fuerte, pricing por mensaje)
- Modelo: plataforma + tarifa Meta por categoría/país.
- Vonage muestra tabla por país con ejemplos (incluye Chile) y cambio de modelo desde **1 de julio de 2025**.
- Encaje: **medio** para integraciones enterprise; para tu requisito de coexistencia debes confirmar soporte específico con ventas/soporte.

## 5.4 Twilio (descartado si exiges mismo número en app + API)
- Pricing público ejemplo:
  - **$0.005** por template message exitoso
  - **$0.001** por template fallido
  - además del fee de Meta
- En su doc de migración aparece advertencia de que no podrás seguir usando WhatsApp Business App con ese mismo número tras migrar.
- Encaje para tu caso puntual: **bajo** (si la coexistencia del mismo número es obligatoria).

## 6) Recomendación concreta para tu objetivo (bot IA + soporte)
Si tu requisito no negociable es **mismo número en API y app móvil con visibilidad de chats**:

1. Opción más directa: **migrar a partner con coexistencia explícita (360dialog es el candidato más claro por evidencia pública)**.
2. Mantener Cloud API para el bot IA (OpenAI o similar) y usar los webhooks de coexistencia para sincronizar historial/echoes.
3. Aceptar que “sin ninguna verificación” puede servir al inicio, pero para escalar operación normalmente tendrás que completar verificación (directa o partner-led).

Si quieres, en el siguiente paso te puedo armar una **matriz de costo mensual estimada** para tu volumen (ej. 1k/5k/20k conversaciones) comparando 360dialog vs Vonage vs Twilio.

## 7) Fuentes (consultadas y vigentes al 8-mar-2026)
### Meta / documentación oficial
- Coexistence (onboarding app users): https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
- Messaging limits: https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits
- Official Business Accounts (OBA): https://developers.facebook.com/documentation/business-messaging/whatsapp/official-business-accounts
- Display names: https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names
- Partner-led business verification: https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/partner-led-business-verification

### Proveedores / pricing
- 360dialog pricing: https://360dialog.com/pricing/
- 360dialog coexistence docs: https://docs.360dialog.com/docs/waba-management/coexistence
- Interakt pricing: https://www.interakt.shop/pricing
- Vonage WhatsApp pricing: https://api.support.vonage.com/hc/en-us/articles/10841875469852-WhatsApp-Pricing
- Twilio WhatsApp pricing: https://www.twilio.com/en-us/whatsapp/pricing
- Twilio migration warning (app usage): https://www.twilio.com/docs/whatsapp/migration/migrate-your-whatsapp-sender-from-other-provider-to-twilio
