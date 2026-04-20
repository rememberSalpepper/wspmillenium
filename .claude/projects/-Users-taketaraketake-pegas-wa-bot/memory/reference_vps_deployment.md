---
name: VPS deployment details
description: Deployment info for wa-bot on VPS - IP, paths, Docker, Caddy, network, domain
type: reference
---

## VPS Deployment

- **VPS hostname**: vps-aeb05009
- **IP pública**: 192.99.168.235
- **Dominio**: bot.moniessence.store
- **Ruta en VPS**: /home/srv/apps/wa-bot
- **Contenedor**: wa-bot-app-1
- **Puerto interno**: 3000 (no publicado al host)

## Reverse Proxy

- **Caddy** (no "Candify") como reverse proxy
- Contenedor: edugeo-reverse-proxy-1
- Config: /home/srv/apps/edugeo/Caddyfile
- Regla: `bot.moniessence.store -> reverse_proxy wa-bot:3000`
- Red Docker compartida: `edugeo_default` (externa, vive en /home/srv/apps/edugeo)
- IP interna del bot en la red: 172.18.0.6

## Otros contenedores en el mismo VPS

- edugeo-frontend-1, edugeo-backend-1
- moniessence-app-1 (usa host:3000, no confundir con el bot)

## Endpoints públicos

- GET /health → OK
- GET/POST /webhook → webhook de Meta
- GET /crm/ → panel CRM (SPA)
- /crm/api/* → API del CRM
- GET / → 404 (no hay home)

## Base de datos

- SQLite WAL en /home/srv/apps/wa-bot/data/bot.db
- Archivos asociados: bot.db-wal, bot.db-shm (los 3 son necesarios para backup)

## Variables .env configuradas

WHATSAPP_TOKEN, PHONE_NUMBER_ID, WABA_ID, VERIFY_TOKEN, GEMINI_API_KEY, GEMINI_MODEL (gemini-2.5-flash), CRM_USER, CRM_PASS, CRM_JWT_SECRET, PORT

## Variables .env NO configuradas

SMTP_HOST/USER/PASS, NOTIFY_EMAIL, BOT_PRICE_TABLE, BOT_WELCOME_MESSAGE, BOT_HUMAN_HANDOFF_MESSAGE, BOT_EMERGENCY_MESSAGE, BOT_SYSTEM_INSTRUCTION_OVERRIDE

## Notas

- No hay git inicializado en la carpeta del VPS
- No hay CI/CD
- SMTP deshabilitado por falta de config
- El bot usa mensajes por defecto del código
- Tiene instrucción extra para responder siempre en español
