// Spanish date formatting helpers. Centralizes the month/day name tables that
// were duplicated across email.js, consultationHandler.js and webhook.js.

const MONTH_NAMES = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// dateStr is an ISO date "YYYY-MM-DD". Returns "5 de marzo" (or with weekday/year).
function formatSpanishDate(dateStr, { withWeekday = false, withYear = false } = {}) {
  const clean = String(dateStr || '').trim();
  const [year, month, day] = clean.split('-');
  const monthNum = parseInt(month, 10);
  const dayNum = parseInt(day, 10);

  if (!monthNum || !dayNum) return clean;

  let label = `${dayNum} de ${MONTH_NAMES[monthNum]}`;

  if (withWeekday) {
    const dateObj = new Date(`${clean}T00:00:00`);
    const weekday = DAY_NAMES[dateObj.getDay()];
    label = `${weekday} ${label}`;
  }

  if (withYear && year) {
    label = `${label} ${year}`;
  }

  return label;
}

module.exports = { MONTH_NAMES, DAY_NAMES, formatSpanishDate };
