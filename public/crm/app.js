/* eslint-env browser */
(function () {
  'use strict';

  var API = '/crm/api';
  var token = localStorage.getItem('crm_token');
  var currentPage = 0;
  var PAGE_SIZE = 20;
  var searchTimeout = null;
  var calYear, calMonth;
  var agendaDateStr;

  // ─── Helpers ────

  function $(id) { return document.getElementById(id); }

  function api(method, path, body) {
    var opts = {
      method: method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (body) opts.body = JSON.stringify(body);

    return fetch(API + path, opts).then(function (res) {
      if (res.status === 401) {
        logout();
        throw new Error('Session expired');
      }
      return res.json();
    });
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function formatDate(d) {
    if (!d) return '-';
    try {
      return new Date(d + 'Z').toLocaleDateString('es-CL', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch (_) { return escapeHtml(d); }
  }

  function formatDateShort(d) {
    if (!d) return '-';
    try {
      return new Date(d + 'T12:00:00').toLocaleDateString('es-CL', {
        day: '2-digit', month: 'short',
      });
    } catch (_) { return escapeHtml(d); }
  }

  function todayStr() {
    return new Date().toISOString().split('T')[0];
  }

  function badgeHtml(value, type) {
    var cls = 'badge badge-' + (value || 'open');
    if (type === 'appointment') cls = 'badge badge-' + (value || 'pending');
    return '<span class="' + cls + '">' + escapeHtml(value || '-') + '</span>';
  }

  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' toast-' + type : '');
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(function () {
      el.classList.add('show');
    });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 300);
    }, 2500);
  }

  // ─── Auth ────

  function showLogin() {
    $('loginView').style.display = 'flex';
    $('appView').style.display = 'none';
  }

  function showApp() {
    $('loginView').style.display = 'none';
    $('appView').style.display = 'flex';
    try {
      var payload = JSON.parse(atob(token.split('.')[1]));
      $('headerUser').textContent = payload.username || 'admin';
    } catch (_) { $('headerUser').textContent = 'admin'; }
    navigate(location.hash || '#dashboard');
  }

  function logout() {
    token = null;
    localStorage.removeItem('crm_token');
    showLogin();
  }

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var user = $('loginUser').value.trim();
    var pass = $('loginPass').value;
    $('loginError').textContent = '';

    api('POST', '/login', { username: user, password: pass })
      .then(function (data) {
        if (data.token) {
          token = data.token;
          localStorage.setItem('crm_token', token);
          showApp();
        } else {
          $('loginError').textContent = data.error === 'too_many_attempts'
            ? 'Demasiados intentos. Espere 15 minutos.'
            : 'Credenciales incorrectas';
        }
      })
      .catch(function () {
        $('loginError').textContent = 'Error de conexion';
      });
  });

  $('logoutBtn').addEventListener('click', logout);

  // ─── Router ────

  var views = ['dashboard', 'patients', 'patient-detail', 'calendar', 'agenda', 'settings'];

  function navigate(hash) {
    var parts = hash.replace('#', '').split('/');
    var view = parts[0] || 'dashboard';
    var param = parts[1] || null;

    // Show target view, hide others
    views.forEach(function (v) {
      var el = $('view-' + v);
      if (el) el.style.display = v === view ? 'block' : 'none';
    });

    // Update nav active state
    document.querySelectorAll('.nav-item').forEach(function (item) {
      item.classList.toggle('active', item.getAttribute('data-view') === view);
    });

    // Close mobile sidebar
    $('sidebar').classList.remove('open');
    $('sidebarOverlay').classList.remove('open');

    // Load view data
    switch (view) {
      case 'dashboard': loadDashboard(); break;
      case 'patients': loadPatients(0); break;
      case 'patient-detail': if (param) loadPatientDetail(parseInt(param)); break;
      case 'calendar': loadCalendar(); break;
      case 'agenda': loadAgenda(); break;
      case 'settings': loadSettings(); break;
    }
  }

  window.addEventListener('hashchange', function () {
    navigate(location.hash);
  });

  // ─── Mobile sidebar ────

  $('hamburgerBtn').addEventListener('click', function () {
    $('sidebar').classList.toggle('open');
    $('sidebarOverlay').classList.toggle('open');
  });

  $('sidebarOverlay').addEventListener('click', function () {
    $('sidebar').classList.remove('open');
    $('sidebarOverlay').classList.remove('open');
  });

  // ─── Dashboard ────

  $('refreshDashboard').addEventListener('click', loadDashboard);

  function loadDashboard() {
    api('GET', '/stats').then(function (data) {
      $('statsGrid').innerHTML = [
        statCard(data.totalPatients, 'Pacientes', 'stat-primary'),
        statCard(data.openConsultations, 'Consultas abiertas', 'stat-warning'),
        statCard(data.todayAppointments, 'Citas hoy', 'stat-success'),
        statCard(data.upcomingAppointments, 'Proximas citas', 'stat-info'),
        statCard(data.totalConsultations, 'Total consultas', 'stat-primary'),
      ].join('');
    }).catch(function () {});

    api('GET', '/appointments/today').then(function (data) {
      renderTodayAppointments(data);
    }).catch(function () {
      $('todayAppointments').innerHTML = '<p class="text-muted text-sm">Error cargando</p>';
    });

    api('GET', '/appointments').then(function (data) {
      renderUpcomingAppointments(data);
    }).catch(function () {
      $('upcomingAppointments').innerHTML = '<p class="text-muted text-sm">Error cargando</p>';
    });
  }

  function statCard(value, label, cls) {
    return '<div class="stat-card ' + (cls || '') + '">' +
      '<div class="stat-value">' + (value || 0) + '</div>' +
      '<div class="stat-label">' + escapeHtml(label) + '</div>' +
    '</div>';
  }

  function renderTodayAppointments(apts) {
    if (!Array.isArray(apts) || apts.length === 0) {
      $('todayAppointments').innerHTML = '<div class="empty-state"><p>Sin citas para hoy</p></div>';
      return;
    }
    $('todayAppointments').innerHTML = apts.map(function (a) {
      return '<div class="apt-list-item">' +
        '<span class="apt-time">' + escapeHtml(a.appointment_time) + '</span>' +
        '<span class="apt-name">' + escapeHtml(a.nombre || 'Paciente') + '</span>' +
        badgeHtml(a.status) +
      '</div>';
    }).join('');
  }

  function renderUpcomingAppointments(apts) {
    if (!Array.isArray(apts) || apts.length === 0) {
      $('upcomingAppointments').innerHTML = '<div class="empty-state"><p>Sin citas proximas</p></div>';
      return;
    }
    $('upcomingAppointments').innerHTML = apts.slice(0, 8).map(function (a) {
      return '<div class="apt-list-item">' +
        '<span class="apt-time">' + formatDateShort(a.appointment_date) + '</span>' +
        '<span class="apt-name">' + escapeHtml(a.nombre || 'Paciente') + ' ' + escapeHtml(a.appointment_time) + '</span>' +
        badgeHtml(a.status) +
      '</div>';
    }).join('');
  }

  // ─── Patients ────

  var searchEl = $('patientSearch');
  searchEl.addEventListener('input', function () {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(function () {
      loadPatients(0);
    }, 350);
  });

  function loadPatients(page) {
    currentPage = page;
    var offset = page * PAGE_SIZE;
    var search = searchEl.value.trim();

    var url = '/patients?limit=' + PAGE_SIZE + '&offset=' + offset;
    if (search) url += '&search=' + encodeURIComponent(search);

    api('GET', url).then(function (data) {
      renderPatientTable(data.patients || []);
      renderPagination(data.total || 0);
    }).catch(function () {});
  }

  function renderPatientTable(patients) {
    var tbody = $('patientTableBody');
    if (patients.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state"><p>Sin pacientes registrados</p></div></td></tr>';
      return;
    }

    tbody.innerHTML = patients.map(function (p) {
      return '<tr data-id="' + p.id + '">' +
        '<td><strong>' + escapeHtml(p.nombre || '-') + '</strong></td>' +
        '<td>' + escapeHtml(p.rut || '-') + '</td>' +
        '<td>' + escapeHtml(p.telefono || p.phone || '-') + '</td>' +
        '<td>' + formatDate(p.updated_at) + '</td>' +
      '</tr>';
    }).join('');

    tbody.querySelectorAll('tr').forEach(function (row) {
      row.addEventListener('click', function () {
        location.hash = '#patient-detail/' + row.getAttribute('data-id');
      });
    });
  }

  function renderPagination(total) {
    var totalPages = Math.ceil(total / PAGE_SIZE);
    if (totalPages <= 1) { $('pagination').innerHTML = ''; return; }

    var html = '';
    if (currentPage > 0) {
      html += '<button class="btn btn-sm btn-outline" data-page="' + (currentPage - 1) + '">Anterior</button>';
    }
    html += '<span class="page-info">Pagina ' + (currentPage + 1) + ' de ' + totalPages + '</span>';
    if (currentPage < totalPages - 1) {
      html += '<button class="btn btn-sm btn-outline" data-page="' + (currentPage + 1) + '">Siguiente</button>';
    }

    $('pagination').innerHTML = html;
    $('pagination').querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        loadPatients(parseInt(btn.getAttribute('data-page')));
      });
    });
  }

  // ─── Patient Detail ────

  $('backToPatients').addEventListener('click', function () {
    location.hash = '#patients';
  });

  function loadPatientDetail(id) {
    api('GET', '/patients/' + id).then(function (data) {
      showPatientDetail(data);
    }).catch(function () {});
  }

  function showPatientDetail(data) {
    var p = data.patient;
    $('patientInfo').innerHTML = [
      infoItem('Nombre', p.nombre),
      infoItem('RUT', p.rut),
      infoItem('Email', p.correo),
      infoItem('Telefono', p.telefono || p.phone),
      infoItem('Direccion', p.direccion),
      infoItem('Registro', formatDate(p.created_at)),
    ].join('');

    var consultations = data.consultations || [];
    if (consultations.length === 0) {
      $('consultationsList').innerHTML = '<div class="empty-state"><p>Sin consultas registradas</p></div>';
      return;
    }

    $('consultationsList').innerHTML = consultations.map(function (c) {
      return consultationCard(c);
    }).join('');

    // Load symptoms for each consultation
    consultations.forEach(function (c) {
      api('GET', '/consultations/' + c.id).then(function (detail) {
        var el = document.querySelector('[data-symptoms="' + c.id + '"]');
        if (el && Array.isArray(detail.symptoms) && detail.symptoms.length > 0) {
          el.textContent = detail.symptoms.map(function (s) { return s.sintoma; }).join(', ');
        }
      }).catch(function () {});
    });

    // Bind save buttons
    document.querySelectorAll('.save-consultation').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cId = parseInt(btn.getAttribute('data-id'));
        var statusEl = document.querySelector('[data-status-select="' + cId + '"]');
        var notesEl = document.querySelector('[data-notes="' + cId + '"]');
        var body = {};
        if (statusEl) body.status = statusEl.value;
        if (notesEl) body.notes = notesEl.value;

        api('PATCH', '/consultations/' + cId, body).then(function () {
          toast('Guardado correctamente', 'success');
        }).catch(function () {
          toast('Error al guardar', 'error');
        });
      });
    });
  }

  function consultationCard(c) {
    var emailBadge = c.email_notified
      ? '<span class="email-indicator">Email enviado</span>'
      : '';

    return '<div class="consultation-card">' +
      '<div class="consultation-card-header">' +
        '<span>' + formatDate(c.created_at) + '</span>' +
        badgeHtml(c.status || 'open') + ' ' +
        badgeHtml(c.appointment_status, 'appointment') + ' ' +
        emailBadge +
      '</div>' +
      '<div class="consultation-card-body">' +
        '<div class="consultation-field"><label>Sintomas</label><p data-symptoms="' + c.id + '">' + escapeHtml(c.sintomas || '-') + '</p></div>' +
        '<div class="consultation-field"><label>Motivo</label><p>' + escapeHtml(c.motivo_consulta || '-') + '</p></div>' +
        '<div class="consultation-field"><label>Orientacion</label><p>' + escapeHtml(c.orientacion || '-') + '</p></div>' +
        '<div class="edit-section">' +
          '<div class="form-group">' +
            '<label>Estado</label>' +
            '<select data-status-select="' + c.id + '">' +
              '<option value="open"' + (c.status === 'open' ? ' selected' : '') + '>Abierta</option>' +
              '<option value="attended"' + (c.status === 'attended' ? ' selected' : '') + '>Atendida</option>' +
              '<option value="closed"' + (c.status === 'closed' ? ' selected' : '') + '>Cerrada</option>' +
            '</select>' +
          '</div>' +
          '<div class="form-group">' +
            '<label>Notas</label>' +
            '<textarea data-notes="' + c.id + '">' + escapeHtml(c.notes || '') + '</textarea>' +
          '</div>' +
          '<button class="btn btn-sm btn-primary save-consultation" data-id="' + c.id + '">Guardar</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function infoItem(label, value) {
    return '<div class="info-item"><label>' + escapeHtml(label) + '</label><span>' + escapeHtml(value || '-') + '</span></div>';
  }

  // ─── Calendar ────

  function loadCalendar() {
    var now = new Date();
    if (!calYear) { calYear = now.getFullYear(); calMonth = now.getMonth(); }
    renderCalendar();
  }

  $('calPrev').addEventListener('click', function () {
    calMonth--;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    renderCalendar();
  });

  $('calNext').addEventListener('click', function () {
    calMonth++;
    if (calMonth > 11) { calMonth = 0; calYear++; }
    renderCalendar();
  });

  $('calToday').addEventListener('click', function () {
    var now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
    renderCalendar();
  });

  function renderCalendar() {
    var monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    var dayNames = ['Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab', 'Dom'];

    $('calMonthLabel').textContent = monthNames[calMonth] + ' ' + calYear;

    // Get first and last day of month
    var firstDay = new Date(calYear, calMonth, 1);
    var lastDay = new Date(calYear, calMonth + 1, 0);
    var startDow = (firstDay.getDay() + 6) % 7; // Mon=0
    var daysInMonth = lastDay.getDate();

    // Previous month fill
    var prevLast = new Date(calYear, calMonth, 0).getDate();

    // Calculate date range for API call
    var rangeStart = new Date(calYear, calMonth, 1 - startDow);
    var totalCells = startDow + daysInMonth;
    var extraEnd = (7 - (totalCells % 7)) % 7;
    var rangeEnd = new Date(calYear, calMonth + 1, extraEnd);

    var fromStr = rangeStart.toISOString().split('T')[0];
    var toStr = rangeEnd.toISOString().split('T')[0];

    var html = '<div class="cal-header-row">';
    dayNames.forEach(function (d) {
      html += '<div class="cal-header-cell">' + d + '</div>';
    });
    html += '</div><div class="cal-body">';

    var today = todayStr();
    var cells = [];

    // Prev month
    for (var i = startDow - 1; i >= 0; i--) {
      var d = prevLast - i;
      var dateStr = pad(calYear, calMonth, d, -1);
      cells.push({ day: d, dateStr: dateStr, otherMonth: true });
    }

    // Current month
    for (var j = 1; j <= daysInMonth; j++) {
      var ds = calYear + '-' + String(calMonth + 1).padStart(2, '0') + '-' + String(j).padStart(2, '0');
      cells.push({ day: j, dateStr: ds, otherMonth: false, isToday: ds === today });
    }

    // Next month fill
    for (var k = 1; cells.length % 7 !== 0; k++) {
      var ns = pad(calYear, calMonth + 2, k, 0);
      cells.push({ day: k, dateStr: ns, otherMonth: true });
    }

    cells.forEach(function (c) {
      var cls = 'cal-cell';
      if (c.otherMonth) cls += ' other-month';
      if (c.isToday) cls += ' today';

      html += '<div class="' + cls + '" data-date="' + c.dateStr + '">';
      if (c.isToday) {
        html += '<div class="cal-day"><div>' + c.day + '</div></div>';
      } else {
        html += '<div class="cal-day">' + c.day + '</div>';
      }
      html += '<div class="cal-dots" data-cal-dots="' + c.dateStr + '"></div>';
      html += '</div>';
    });

    html += '</div>';
    $('calendarGrid').innerHTML = html;

    // Click handler
    $('calendarGrid').querySelectorAll('.cal-cell').forEach(function (cell) {
      cell.addEventListener('click', function () {
        agendaDateStr = cell.getAttribute('data-date');
        $('agendaDate').value = agendaDateStr;
        location.hash = '#agenda';
      });
    });

    // Load appointment data
    api('GET', '/appointments?from=' + fromStr + '&to=' + toStr).then(function (apts) {
      if (!Array.isArray(apts)) return;
      var byDate = {};
      apts.forEach(function (a) {
        if (!byDate[a.appointment_date]) byDate[a.appointment_date] = [];
        byDate[a.appointment_date].push(a);
      });

      Object.keys(byDate).forEach(function (date) {
        var el = document.querySelector('[data-cal-dots="' + date + '"]');
        if (!el) return;
        var count = byDate[date].length;
        var dots = '';
        for (var i = 0; i < Math.min(count, 5); i++) {
          var status = byDate[date][i].status;
          var dotCls = 'cal-dot';
          if (status === 'completed') dotCls += ' dot-completed';
          if (status === 'cancelled') dotCls += ' dot-cancelled';
          dots += '<div class="' + dotCls + '"></div>';
        }
        if (count > 5) dots += '<span class="cal-count">+' + (count - 5) + '</span>';
        el.innerHTML = dots;
      });
    }).catch(function () {});
  }

  function pad(y, m, d, monthOffset) {
    var dt = new Date(y, m + (monthOffset || 0), d);
    return dt.toISOString().split('T')[0];
  }

  // ─── Agenda ────

  function loadAgenda() {
    if (!agendaDateStr) agendaDateStr = todayStr();
    $('agendaDate').value = agendaDateStr;
    renderAgenda();
  }

  $('agendaDate').addEventListener('change', function () {
    agendaDateStr = this.value;
    renderAgenda();
  });

  $('agendaPrev').addEventListener('click', function () {
    var d = new Date(agendaDateStr + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    agendaDateStr = d.toISOString().split('T')[0];
    $('agendaDate').value = agendaDateStr;
    renderAgenda();
  });

  $('agendaNext').addEventListener('click', function () {
    var d = new Date(agendaDateStr + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    agendaDateStr = d.toISOString().split('T')[0];
    $('agendaDate').value = agendaDateStr;
    renderAgenda();
  });

  function renderAgenda() {
    var timeline = $('agendaTimeline');
    timeline.innerHTML = '<p class="text-muted text-sm" style="padding:1rem">Cargando...</p>';

    Promise.all([
      api('GET', '/schedule'),
      api('GET', '/appointments/day/' + agendaDateStr),
    ]).then(function (results) {
      var schedule = results[0];
      var apts = results[1];

      if (!Array.isArray(schedule) || schedule.length === 0) {
        timeline.innerHTML = '<div class="empty-state"><p>Sin horario configurado para este dia</p></div>';
        return;
      }

      // Get day of week (JS: 0=Sun)
      var dow = new Date(agendaDateStr + 'T12:00:00').getDay();
      var dayBlocks = schedule.filter(function (s) { return s.day_of_week === dow; });

      if (dayBlocks.length === 0) {
        timeline.innerHTML = '<div class="empty-state"><p>Dia sin atencion programada</p></div>';
        return;
      }

      // Generate all slots
      var slots = [];
      dayBlocks.forEach(function (block) {
        var start = timeToMin(block.start_time);
        var end = timeToMin(block.end_time);
        var dur = block.slot_duration_min || 30;
        for (var t = start; t + dur <= end; t += dur) {
          slots.push(minToTime(t));
        }
      });

      // Map appointments by time
      var aptMap = {};
      if (Array.isArray(apts)) {
        apts.forEach(function (a) { aptMap[a.appointment_time] = a; });
      }

      var html = '';
      slots.forEach(function (time) {
        var apt = aptMap[time];
        if (apt) {
          html += '<div class="agenda-slot booked">' +
            '<div class="agenda-time">' + time + '</div>' +
            '<div class="agenda-content">' +
              '<div>' +
                '<div class="agenda-patient-name">' + escapeHtml(apt.nombre || 'Paciente') + '</div>' +
                '<div class="agenda-patient-detail">' + escapeHtml(apt.rut || '') + ' ' + badgeHtml(apt.status) + '</div>' +
              '</div>' +
              '<div class="agenda-actions">' +
                aptActionButtons(apt) +
              '</div>' +
            '</div>' +
          '</div>';
        } else {
          html += '<div class="agenda-slot">' +
            '<div class="agenda-time">' + time + '</div>' +
            '<div class="agenda-content"><span class="agenda-empty">Disponible</span></div>' +
          '</div>';
        }
      });

      timeline.innerHTML = html || '<div class="empty-state"><p>Sin slots</p></div>';

      // Bind action buttons
      timeline.querySelectorAll('[data-apt-action]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var id = parseInt(btn.getAttribute('data-apt-id'));
          var action = btn.getAttribute('data-apt-action');
          api('PATCH', '/appointments/' + id, { status: action }).then(function () {
            toast('Cita actualizada', 'success');
            renderAgenda();
          }).catch(function () {
            toast('Error', 'error');
          });
        });
      });
    }).catch(function () {
      timeline.innerHTML = '<div class="empty-state"><p>Error cargando agenda</p></div>';
    });
  }

  function aptActionButtons(apt) {
    var html = '';
    if (apt.status === 'scheduled') {
      html += '<button class="btn btn-sm btn-success" data-apt-id="' + apt.id + '" data-apt-action="completed">Completar</button>';
      html += '<button class="btn btn-sm btn-outline" data-apt-id="' + apt.id + '" data-apt-action="no_show">No show</button>';
      html += '<button class="btn btn-sm btn-danger" data-apt-id="' + apt.id + '" data-apt-action="cancelled">Cancelar</button>';
    } else if (apt.status === 'completed') {
      html += '<span class="badge badge-completed">Completada</span>';
    } else if (apt.status === 'cancelled') {
      html += '<span class="badge badge-cancelled">Cancelada</span>';
    } else if (apt.status === 'no_show') {
      html += '<span class="badge badge-no_show">No show</span>';
    }
    return html;
  }

  function timeToMin(t) {
    var parts = t.split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  }

  function minToTime(m) {
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  // ─── Settings ────

  function loadSettings() {
    loadScheduleEditor();
    loadDateBlocks();
  }

  function loadScheduleEditor() {
    api('GET', '/schedule').then(function (schedule) {
      renderScheduleEditor(schedule || []);
    }).catch(function () {
      $('scheduleEditor').innerHTML = '<p class="text-muted text-sm">Error cargando</p>';
    });
  }

  function renderScheduleEditor(schedule) {
    var dayNames = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];
    var byDay = {};
    for (var i = 0; i < 7; i++) byDay[i] = [];
    schedule.forEach(function (s) {
      if (!byDay[s.day_of_week]) byDay[s.day_of_week] = [];
      byDay[s.day_of_week].push(s);
    });

    // Show Mon-Sat, then Sun
    var order = [1, 2, 3, 4, 5, 6, 0];
    var html = '';

    order.forEach(function (dow) {
      html += '<div class="schedule-day" data-dow="' + dow + '">';
      html += '<div class="schedule-day-name">' + dayNames[dow] + '</div>';
      html += '<div class="schedule-blocks">';

      (byDay[dow] || []).forEach(function (b, idx) {
        html += '<div class="schedule-block-item">' +
          '<input type="time" value="' + b.start_time + '" data-field="start" data-dow="' + dow + '" data-idx="' + idx + '"> - ' +
          '<input type="time" value="' + b.end_time + '" data-field="end" data-dow="' + dow + '" data-idx="' + idx + '">' +
          '<button class="remove-block-btn" data-dow="' + dow + '" data-idx="' + idx + '">&times;</button>' +
        '</div>';
      });

      html += '<button class="add-block-btn" data-dow="' + dow + '">+ Bloque</button>';
      html += '</div></div>';
    });

    $('scheduleEditor').innerHTML = html;

    // Add block buttons
    $('scheduleEditor').querySelectorAll('.add-block-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var dow = parseInt(btn.getAttribute('data-dow'));
        var blocksContainer = btn.parentElement;
        var newBlock = document.createElement('div');
        newBlock.className = 'schedule-block-item';
        newBlock.innerHTML = '<input type="time" value="09:00" data-field="start"> - ' +
          '<input type="time" value="13:00" data-field="end">' +
          '<button class="remove-block-btn">&times;</button>';
        blocksContainer.insertBefore(newBlock, btn);

        newBlock.querySelector('.remove-block-btn').addEventListener('click', function () {
          newBlock.remove();
        });
      });
    });

    // Remove block buttons
    $('scheduleEditor').querySelectorAll('.remove-block-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        btn.parentElement.remove();
      });
    });
  }

  $('saveSchedule').addEventListener('click', function () {
    var blocks = [];
    $('scheduleEditor').querySelectorAll('.schedule-day').forEach(function (dayEl) {
      var dow = parseInt(dayEl.getAttribute('data-dow'));
      dayEl.querySelectorAll('.schedule-block-item').forEach(function (blockEl) {
        var startInput = blockEl.querySelector('[data-field="start"]');
        var endInput = blockEl.querySelector('[data-field="end"]');
        if (startInput && endInput && startInput.value && endInput.value) {
          blocks.push({
            day_of_week: dow,
            start_time: startInput.value,
            end_time: endInput.value,
            slot_duration_min: 30,
          });
        }
      });
    });

    api('PUT', '/schedule', { blocks: blocks }).then(function () {
      toast('Horario guardado', 'success');
      loadScheduleEditor();
    }).catch(function () {
      toast('Error guardando horario', 'error');
    });
  });

  // Date blocks
  function loadDateBlocks() {
    api('GET', '/schedule/blocks').then(function (blocks) {
      renderDateBlocks(blocks || []);
    }).catch(function () {
      $('blocksList').innerHTML = '<p class="text-muted text-sm">Error cargando</p>';
    });
  }

  function renderDateBlocks(blocks) {
    if (blocks.length === 0) {
      $('blocksList').innerHTML = '<p class="text-muted text-sm mt-1">Sin bloqueos configurados</p>';
      return;
    }

    $('blocksList').innerHTML = blocks.map(function (b) {
      return '<div class="block-item">' +
        '<span>' + escapeHtml(b.block_date) +
          (b.reason ? ' - ' + escapeHtml(b.reason) : '') +
          (b.start_time ? ' (' + escapeHtml(b.start_time) + ' - ' + escapeHtml(b.end_time) + ')' : ' (dia completo)') +
        '</span>' +
        '<button class="btn btn-sm btn-danger" data-block-id="' + b.id + '">Eliminar</button>' +
      '</div>';
    }).join('');

    $('blocksList').querySelectorAll('[data-block-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = parseInt(btn.getAttribute('data-block-id'));
        api('DELETE', '/schedule/blocks/' + id).then(function () {
          toast('Bloqueo eliminado', 'success');
          loadDateBlocks();
        }).catch(function () {
          toast('Error', 'error');
        });
      });
    });
  }

  $('addBlock').addEventListener('click', function () {
    var date = $('blockDate').value;
    var reason = $('blockReason').value.trim();
    if (!date) { toast('Seleccione una fecha', 'error'); return; }

    api('POST', '/schedule/blocks', { block_date: date, reason: reason }).then(function () {
      toast('Bloqueo agregado', 'success');
      $('blockDate').value = '';
      $('blockReason').value = '';
      loadDateBlocks();
    }).catch(function () {
      toast('Error', 'error');
    });
  });

  // ─── Init ────

  if (token) {
    showApp();
  } else {
    showLogin();
  }
})();
