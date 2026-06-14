const express = require('express');
const { Parser } = require('json2csv');
const db = require('../models/db');
const { authRequired } = require('../middleware/auth');
const { success, error, parseJson } = require('../utils/response');
const { triggerCallback, writeAuditLog } = require('../utils/callback');

const router = express.Router();

router.post('/verify', (req, res) => {
  const { code } = req.body;
  if (!code) {
    return error(res, '签到码不能为空');
  }

  const registration = db.prepare(`
    SELECT r.*, e.title as event_title, e.location as event_location, e.start_time, e.organizer_id, o.name as organizer_name
    FROM registrations r
    JOIN events e ON r.event_id = e.id
    JOIN organizers o ON e.organizer_id = o.id
    WHERE r.checkin_code = ?
  `).get(code);

  if (!registration) {
    return error(res, '签到码无效', 404);
  }

  if (registration.status !== 'approved') {
    return error(res, '该报名未审核通过，无法签到');
  }

  if (registration.checkin_status === 'checked_in') {
    return success(res, {
      already_checked_in: true,
      registration: {
        id: registration.id,
        event_id: registration.event_id,
        event_title: registration.event_title,
        user_name: registration.user_name,
        checkin_time: registration.checkin_time
      }
    }, '已重复签到，首次签到时间：' + registration.checkin_time);
  }

  db.prepare(`
    UPDATE registrations SET checkin_status = 'checked_in', checkin_time = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(registration.id);

  writeAuditLog(registration.event_id, registration.id, 'checkin_success', null);
  triggerCallback(registration.organizer_id, 'checkin.success', {
    id: registration.id,
    event_id: registration.event_id,
    user_name: registration.user_name,
    user_identifier: registration.user_identifier,
    checkin_time: new Date().toISOString()
  });

  return success(res, {
    already_checked_in: false,
    registration: {
      id: registration.id,
      event_id: registration.event_id,
      event_title: registration.event_title,
      event_location: registration.event_location,
      start_time: registration.start_time,
      user_name: registration.user_name,
      user_phone: registration.user_phone,
      user_email: registration.user_email,
      form_data: parseJson(registration.form_data),
      checkin_time: new Date().toISOString()
    }
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
    return success(res, { already_checked_in: true, checkin_time: registration.checkin_time }, '已重复签到');
  }

  db.prepare(`
    UPDATE registrations SET checkin_status = 'checked_in', checkin_time = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(registration.id);

  writeAuditLog(event_id, registration.id, 'checkin_manual', null);
  triggerCallback(req.organizer.id, 'checkin.success', {
    id: registration.id,
    event_id,
    user_name: registration.user_name,
    user_identifier: registration.user_identifier,
    checkin_time: new Date().toISOString(),
    manual: true
  });

  return success(res, {
    already_checked_in: false,
    registration: {
      id: registration.id,
      user_name: registration.user_name,
      checkin_time: new Date().toISOString()
    }
  }, '签到成功');
});

router.use(authRequired);

router.get('/event/:eventId/stats', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ? AND organizer_id = ?').get(req.params.eventId, req.organizer.id);
  if (!event) {
    return error(res, '活动不存在', 404);
  }

  const total = db.prepare('SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status != ?').get(req.params.eventId, 'cancelled').count;
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
      报名ID: r.id,
      用户标识: r.user_identifier,
      姓名: r.user_name,
      手机号: r.user_phone || '',
      邮箱: r.user_email || '',
      状态: statusMap[r.status] || r.status,
      候补序号: r.queue_position || '',
      签到状态: checkinMap[r.checkin_status] || r.checkin_status,
      签到时间: r.checkin_time || '',
      报名时间: r.created_at,
      审核通过时间: r.approved_at || '',
      取消时间: r.cancelled_at || '',
      ...formData
    };
  });

  const fields = Object.keys(rows[0] || [
    '报名ID', '用户标识', '姓名', '手机号', '邮箱', '状态', '候补序号',
    '签到状态', '签到时间', '报名时间', '审核通过时间', '取消时间'
  ]);

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
