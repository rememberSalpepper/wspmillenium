// Plain text helpers shared by the webhook and handlers.

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function previewText(text, max = 160) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function stripMarkdown(text) {
  return String(text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`(.+?)`/g, '$1');
}

function truncateText(text, maxChars) {
  const clean = String(text || '').trim();
  if (!clean) return 'No pude generar una respuesta.';
  return clean.length > maxChars ? clean.slice(0, maxChars) : clean;
}

function isStaleMessage(timestampSeconds, maxAgeSeconds) {
  if (!timestampSeconds) return false;

  const ts = Number(timestampSeconds);
  if (!Number.isFinite(ts) || ts <= 0) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ageSeconds = nowSeconds - ts;

  return ageSeconds > maxAgeSeconds;
}

function getUnsupportedMessageReply(type) {
  const base =
    'Por ahora solo puedo procesar mensajes de texto. Escríbeme tu consulta en texto.';

  switch (type) {
    case 'audio':
      return 'Por ahora no puedo escuchar audios. Escríbeme tu mensaje en texto.';
    case 'image':
      return 'Por ahora no puedo analizar imágenes. Escríbeme tu consulta en texto.';
    case 'sticker':
      return 'Por ahora no puedo interpretar stickers. Escríbeme tu mensaje en texto.';
    case 'video':
      return 'Por ahora no puedo analizar videos. Escríbeme tu consulta en texto.';
    case 'document':
      return 'Por ahora no puedo leer documentos automáticamente. Escríbeme tu consulta en texto.';
    case 'location':
      return 'Por ahora no puedo procesar ubicaciones automáticamente. Escríbeme la información en texto.';
    case 'contacts':
      return 'Por ahora no puedo procesar contactos compartidos automáticamente. Escríbeme tu consulta en texto.';
    default:
      return base;
  }
}

module.exports = {
  normalizeDigits,
  previewText,
  stripMarkdown,
  truncateText,
  isStaleMessage,
  getUnsupportedMessageReply,
};
