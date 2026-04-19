/* eslint-env browser */
(function () {
  'use strict';

  const API = '/crm/api';
  let token = localStorage.getItem('crm_token');
  let currentPage = 0;
  const PAGE_SIZE = 20;

  // --- Helpers ---

  function $(id) { return document.getElementById(id); }

  function api(method, path, body) {
    const opts = {
      method,
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

  function formatDate(d) {
    if (!d) return '-';
    try {
      return new Date(d + 'Z').toLocaleDateString('es-CL', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch (_) { return escapeHtml(d); }
  }

  function badgeHtml(value, type) {
    var cls = 'badge badge-' + (value || 'open');
    if (type === 'appointment') cls = 'badge badge-' + (value || 'pending');
    return '<span class="' + cls + '">' + escapeHtml(value || '-') + '</span>';
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // --- Auth ---

  function showLogin() {
    $('loginView').style.display = 'flex';
    $('appView').style.display = 'none';
  }

  function showApp() {
    $('loginView').style.display = 'none';
    $('appView').style.display = 'block';
    try {
      var payload = JSON.parse(atob(token.split('.')[1]));
      $('headerUser').textContent = payload.username || 'admin';
    } catch (_) { $('headerUser').textContent = 'admin'; }
    loadDashboard();
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

  // --- Dashboard ---

  function loadDashboard() {
    loadStats();
    loadPatients(0);
  }

  function loadStats() {
    api('GET', '/stats').then(function (data) {
      $('statsGrid').innerHTML = [
        statCard(data.totalPatients, 'Pacientes'),
        statCard(data.totalConsultations, 'Consultas totales'),
        statCard(data.openConsultations, 'Consultas abiertas'),
        statCard(data.confirmedAppointments, 'Citas confirmadas'),
        statCard(data.pendingAppointments, 'Citas pendientes'),
      ].join('');
    }).catch(function () {});
  }

  function statCard(value, label) {
    return '<div class="stat-card"><div class="stat-value">' +
      (value || 0) + '</div><div class="stat-label">' +
      escapeHtml(label) + '</div></div>';
  }

  // --- Patients ---

  function loadPatients(page) {
    currentPage = page;
    var offset = page * PAGE_SIZE;

    api('GET', '/patients?limit=' + PAGE_SIZE + '&offset=' + offset)
      .then(function (data) {
        renderPatientTable(data.patients || []);
        renderPagination(data.total || 0);
      })
      .catch(function () {});
  }

  function renderPatientTable(patients) {
    var tbody = $('patientTableBody');
    if (patients.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">Sin pacientes registrados</td></tr>';
      return;
    }

    tbody.innerHTML = patients.map(function (p) {
      return '<tr data-id="' + p.id + '">' +
        '<td>' + escapeHtml(p.nombre || '-') + '</td>' +
        '<td>' + escapeHtml(p.rut || '-') + '</td>' +
        '<td>' + escapeHtml(p.telefono || p.phone || '-') + '</td>' +
        '<td>' + formatDate(p.updated_at) + '</td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('tr').forEach(function (row) {
      row.addEventListener('click', function () {
        var id = parseInt(row.getAttribute('data-id'));
        loadPatientDetail(id);
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
    html += '<span style="font-size:0.85rem;color:var(--text-muted)">Pagina ' + (currentPage + 1) + ' de ' + totalPages + '</span>';
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

  // --- Patient Detail ---

  function loadPatientDetail(id) {
    api('GET', '/patients/' + id).then(function (data) {
      showPatientDetail(data);
    }).catch(function () {});
  }

  function showPatientDetail(data) {
    $('patientListView').style.display = 'none';
    $('patientDetailView').style.display = 'block';
    $('patientDetailView').className = 'detail-panel active';

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
      $('consultationsList').innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">Sin consultas registradas</p>';
      return;
    }

    $('consultationsList').innerHTML = consultations.map(function (c) {
      return consultationCard(c);
    }).join('');

    // Load symptoms for each consultation
    consultations.forEach(function (c) {
      api('GET', '/consultations/' + c.id).then(function (detail) {
        var symptomsEl = document.querySelector('[data-symptoms="' + c.id + '"]');
        if (symptomsEl && Array.isArray(detail.symptoms) && detail.symptoms.length > 0) {
          symptomsEl.textContent = detail.symptoms.map(function (s) { return s.sintoma; }).join(', ');
        }
      }).catch(function () {});
    });

    // Bind edit actions
    document.querySelectorAll('.save-consultation').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cId = parseInt(btn.getAttribute('data-id'));
        var statusEl = document.querySelector('[data-status-select="' + cId + '"]');
        var notesEl = document.querySelector('[data-notes="' + cId + '"]');
        var body = {};
        if (statusEl) body.status = statusEl.value;
        if (notesEl) body.notes = notesEl.value;

        api('PATCH', '/consultations/' + cId, body).then(function () {
          btn.textContent = 'Guardado';
          setTimeout(function () { btn.textContent = 'Guardar'; }, 1500);
          loadStats();
        }).catch(function () {
          btn.textContent = 'Error';
          setTimeout(function () { btn.textContent = 'Guardar'; }, 1500);
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
        '<span>' + formatDate(c.created_at) + ' ' +
          badgeHtml(c.status || 'open') + ' ' +
          badgeHtml(c.appointment_status, 'appointment') + ' ' +
          emailBadge +
        '</span>' +
      '</div>' +
      '<div class="consultation-card-body">' +
        '<div class="consultation-field"><label>Sintomas</label><p data-symptoms="' + c.id + '">' + escapeHtml(c.sintomas || '-') + '</p></div>' +
        '<div class="consultation-field"><label>Motivo</label><p>' + escapeHtml(c.motivo_consulta || '-') + '</p></div>' +
        '<div class="consultation-field"><label>Orientacion</label><p>' + escapeHtml(c.orientacion || '-') + '</p></div>' +
        '<div class="edit-section">' +
          '<div class="form-group">' +
            '<label>Estado consulta</label>' +
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

  $('backToList').addEventListener('click', function () {
    $('patientListView').style.display = 'block';
    $('patientDetailView').style.display = 'none';
    $('patientDetailView').className = 'detail-panel';
  });

  $('refreshBtn').addEventListener('click', function () {
    loadDashboard();
  });

  // --- Init ---
  if (token) {
    showApp();
  } else {
    showLogin();
  }
})();
