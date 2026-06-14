const express = require('express');
const { Parser } = require('json2csv');
const db = require('../models/db');
const { authRequired } = require('../middleware/auth');
const { success, error, parseJson } = require('../utils/response');
const { triggerCallback, writeAuditLog } = require('../utils/callback');

const router = express.Router();

function buildCheckinResponse(reg, evt) {
  return {
    id: reg.id,
    event_id: reg.event_id,
    event_title: evt.title,
    event_location: evt.location,
    start_time: evt.start_time,
    end_time: evt.end_time,
    user_name: reg.user_name,
    user_identifier: reg.user_identifier,
    user_phone: reg.user_phone,
    user_email: reg.user_email,
    form_data: parseJson(reg.form_data),
    checkin_code: reg.checkin_code
  };
}

router.post('/verify', (req, res) => {
  const { code } = req.body;
  if (!code) {
    return error(res, '签到码不能为空');
  }

  const registration = db.prepare('SELECT * FROM registrations WHERE checkin_code = ?').get(code);
  if (!registration) {
    return error(res, '签到码无效', 404);
  }

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(registration.event_id);
  if (!event) {
    return error(res, '对应活动不存在', 404);
  }

  if (registration.status !== 'approved') {
    return error(res, '该报名未审核通过，无法签到');
  }

  if (registration.checkin_status === 'checked_in') {
    const resp = buildCheckinResponse(registration, event);
    resp.checkin_time = registration.checkin_time;
    return success(res, {
      already_checked_in: true,
      registration: resp
    }, '已重复签到，首次签到时间：' + registration.checkin_time);
  }

  db.prepare(`
    UPDATE registrations SET checkin_status = 'checked_in', checkin_time = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(registration.id);

  const checkinTime = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const resp = buildCheckinResponse(registration, event);
  resp.checkin_time = checkinTime;

  writeAuditLog(registration.event_id, registration.id, 'checkin_success', null);
  triggerCallback(event.organizer_id, 'checkin.success', {
    id: registration.id,
    event_id: registration.event_id,
    event_title: event.title,
    event_location: event.location,
    user_name: registration.user_name,
    user_identifier: registration.user_identifier,
    checkin_time: checkinTime
  });

  return success(res, {
    already_checked_in: false,
    registration: resp
  }, '签到成功');
});

router.post('/manual', authRequired, (req, res) => {
  const { event_id, user_identifier } = req.body;
  if (!event_id || !user_identifier) {
    return error(res, '活动ID和用户标识为必填项');
  }

  const event = db.prepare('SELECT * FROM events WHERE id = ? AND organizer_id = ?').get(event_id, req.organizer.id);
  if (!event) {
    return error(res, '活动不存在', 404);
  }

  const registration = db.prepare('SELECT * FROM registrations WHERE event_id = ? AND user_identifier = ?').get(event_id, user_identifier);
  if (!registration) {
    return error(res, '未找到该用户的报名记录', 404);
  }

  if (registration.status !== 'approved') {
    return error(res, '该报名未审核通过，无法签到');
  }

  if (registration.checkin_status === 'checked_in') {
    const resp = buildCheckinResponse(registration, event);
    resp.checkin_time = registration.checkin_time;
    return success(res, { already_checked_in: true, registration: resp }, '已重复签到');
  }

  db.prepare(`
    UPDATE registrations SET checkin_status = 'checked_in', checkin_time = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(registration.id);

  const checkinTime = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const resp = buildCheckinResponse(registration, event);
  resp.checkin_time = checkinTime;

  writeAuditLog(event_id, registration.id, 'checkin_manual', null);
  triggerCallback(req.organizer.id, 'checkin.success', {
    id: registration.id,
    event_id,
    event_title: event.title,
    event_location: event.location,
    user_name: registration.user_name,
    user_identifier: registration.user_identifier,
    checkin_time: checkinTime,
    manual: true
  });

  return success(res, {
    already_checked_in: false,
    registration: resp
  }, '签到成功');
});

router.use(authRequired);

router.get('/event/:eventId/stats', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ? AND organizer_id = ?').get(req.params.eventId, req.organizer.id);
  if (!event) {
    return error(res, '活动不存在', 404);
  }

  const total = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status != 'cancelled'").get(req.params.eventId).count;
  const approved = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'approved'").get(req.params.eventId).count;
  const pending = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'pending'").get(req.params.eventId).count;
  const waitlist = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'waitlist'").get(req.params.eventId).count;
  const cancelled = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'cancelled'").get(req.params.eventId).count;
  const rejected = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'rejected'").get(req.params.eventId).count;
  const checkedIn = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND checkin_status = 'checked_in'").get(req.params.eventId).count;

  const promoted = db.prepare(`
    SELECT COUNT(*) as count FROM audit_logs
    WHERE event_id = ? AND action = 'waitlist_promoted'
  `).get(req.params.eventId).count;

  return success(res, {
    capacity: event.capacity,
    waitlist_limit: event.waitlist_limit,
    total_registrations: total,
    approved_count: approved,
    pending_count: pending,
    waitlist_count: waitlist,
    cancelled_count: cancelled,
    rejected_count: rejected,
    checked_in_count: checkedIn,
    waitlist_promoted_count: promoted,
    attendance_rate: approved > 0 ? Number((checkedIn / approved * 100).toFixed(2)) : 0,
    conversion_rate: total > 0 ? Number((approved / total * 100).toFixed(2)) : 0
  });
});

router.get('/event/:eventId/export', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ? AND organizer_id = ?').get(req.params.eventId, req.organizer.id);
  if (!event) {
    return error(res, '活动不存在', 404);
  }

  const { status = 'all' } = req.query;

  let whereClause = 'WHERE event_id = ?';
  const params = [req.params.eventId];

  if (status !== 'all') {
    whereClause += ' AND status = ?';
    params.push(status);
  }

  const registrations = db.prepare(`
    SELECT id, user_identifier, user_name, user_phone, user_email, form_data, status, queue_position,
           checkin_status, checkin_time, created_at, approved_at, cancelled_at
    FROM registrations ${whereClause}
    ORDER BY created_at ASC
  `).all(...params);

  const rows = registrations.map(r => {
    const formData = parseJson(r.form_data) || {};
    const statusMap = {
      approved: '已通过',
      pending: '待审核',
      waitlist: '候补',
      cancelled: '已取消',
      rejected: '已拒绝'
    };
    const checkinMap = {
      none: '未签到',
      checked_in: '已签到'
    };
    return {
      ID: r.id,
      user_identifier: r.user_identifier,
      name: r.user_name,
      phone: r.user_phone || '',
      email: r.user_email || '',
      status: statusMap[r.status] || r.status,
      queue_position: r.queue_position || '',
      checkin_status: checkinMap[r.checkin_status] || r.checkin_status,
      checkin_time: r.checkin_time || '',
      created_at: r.created_at,
      approved_at: r.approved_at || '',
      cancelled_at: r.cancelled_at || '',
      ...formData
    };
  });

  const defaultFields = ['ID', 'user_identifier', 'name', 'phone', 'email', 'status', 'queue_position',
    'checkin_status', 'checkin_time', 'created_at', 'approved_at', 'cancelled_at'];
  const fields = rows.length > 0 ? Object.keys(rows[0]) : defaultFields;

  try {
    const parser = new Parser({ fields });
    const csv = parser.parse(rows);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="event_${event.id}_registrations.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    return error(res, '导出失败：' + err.message);
  }
});

module.exports = router;
