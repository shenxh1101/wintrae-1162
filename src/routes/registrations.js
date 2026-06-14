const express = require('express');
const { v4: uuidv4 } = require('uuid');
const qrcode = require('qrcode');
const db = require('../models/db');
const config = require('../config');
const { authRequired } = require('../middleware/auth');
const { success, error, parseJson, stringifyJson } = require('../utils/response');
const { triggerCallback, writeAuditLog } = require('../utils/callback');

const router = express.Router();

router.get('/public/:eventId', (req, res) => {
  const event = db.prepare(`
    SELECT e.*, o.name as organizer_name
    FROM events e
    JOIN organizers o ON e.organizer_id = o.id
    WHERE e.id = ? AND e.status = 'published'
  `).get(req.params.eventId);

  if (!event) {
    return error(res, '活动不存在或未发布', 404);
  }

  const approvedCount = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'approved'").get(event.id).count;
  const waitlistCount = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'waitlist'").get(event.id).count;

  return success(res, {
    id: event.id,
    title: event.title,
    description: event.description,
    location: event.location,
    start_time: event.start_time,
    end_time: event.end_time,
    organizer_name: event.organizer_name,
    require_approval: !!event.require_approval,
    form_fields: parseJson(event.form_fields),
    stats: {
      capacity: event.capacity,
      approved_count: approvedCount,
      waitlist_count: waitlistCount,
      remaining_spots: Math.max(0, event.capacity - approvedCount),
      waitlist_available: waitlistCount < event.waitlist_limit
    }
  });
});

router.post('/public/:eventId/register', async (req, res) => {
  const { user_identifier, user_name, user_phone, user_email, form_data } = req.body;
  const eventId = req.params.eventId;

  if (!user_identifier || !user_name) {
    return error(res, '用户标识和姓名为必填项');
  }

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) {
    return error(res, '活动不存在', 404);
  }
  if (event.status !== 'published') {
    return error(res, '活动未开放报名');
  }

  const blacklisted = db.prepare('SELECT id FROM blacklist WHERE organizer_id = ? AND user_identifier = ?').get(event.organizer_id, user_identifier);
  if (blacklisted) {
    return error(res, '您已被列入黑名单，无法报名该主办方活动', 403);
  }

  const existing = db.prepare('SELECT * FROM registrations WHERE event_id = ? AND user_identifier = ?').get(eventId, user_identifier);
  if (existing) {
    if (existing.status === 'cancelled') {
      return error(res, '您已取消过报名，如需重新报名请联系主办方');
    }
    return error(res, '您已报名此活动，请勿重复提交');
  }

  const tx = db.transaction(() => {
    const approvedCount = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'approved'").get(eventId).count;
    const waitlistCount = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'waitlist'").get(eventId).count;

    let status = 'approved';
    let queuePosition = null;

    if (approvedCount < event.capacity) {
      if (event.require_approval) {
        status = 'pending';
      }
    } else if (waitlistCount < event.waitlist_limit) {
      status = 'waitlist';
      queuePosition = waitlistCount + 1;
    } else {
      throw new Error('活动名额已满，候补队列也已满员');
    }

    const checkinCode = uuidv4().replace(/-/g, '').substring(0, 16);

    const result = db.prepare(`
      INSERT INTO registrations (event_id, user_identifier, user_name, user_phone, user_email, form_data, status, queue_position, checkin_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      user_identifier,
      user_name,
      user_phone || null,
      user_email || null,
      form_data ? stringifyJson(form_data) : null,
      status,
      queuePosition,
      checkinCode
    );

    return { registrationId: result.lastInsertRowid, status, queuePosition, checkinCode };
  });

  try {
    const { registrationId, status, queuePosition, checkinCode } = tx();
    const registration = db.prepare('SELECT * FROM registrations WHERE id = ?').get(registrationId);

    let qrCodeUrl = null;
    let qrCodeDataUri = null;
    if (status === 'approved') {
      qrCodeUrl = `${config.registration.qrCodeBaseUrl}?code=${checkinCode}`;
      try {
        qrCodeDataUri = await qrcode.toDataURL(qrCodeUrl);
      } catch {}
    }

    writeAuditLog(eventId, registrationId, 'registration_created', { status, queue_position: queuePosition });
    triggerCallback(event.organizer_id, 'registration.created', formatRegistration(registration));

    return success(res, {
      registration: formatRegistration(registration),
      qr_code_url: qrCodeUrl,
      qr_code_data_uri: qrCodeDataUri,
      queue_position: queuePosition,
      waitlist_count: status === 'waitlist' ? db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'waitlist'").get(eventId).count : null
    }, status === 'approved' ? '报名成功' : (status === 'waitlist' ? '已加入候补队列' : '已提交，等待审核'));
  } catch (err) {
    return error(res, err.message);
  }
});

router.use(authRequired);

router.get('/event/:eventId', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ? AND organizer_id = ?').get(req.params.eventId, req.organizer.id);
  if (!event) {
    return error(res, '活动不存在', 404);
  }

  const { status, page = 1, page_size = 50, keyword } = req.query;
  const offset = (page - 1) * page_size;

  let whereClause = 'WHERE event_id = ?';
  const params = [req.params.eventId];

  if (status) {
    whereClause += ' AND status = ?';
    params.push(status);
  }

  if (keyword) {
    whereClause += ' AND (user_name LIKE ? OR user_phone LIKE ? OR user_email LIKE ? OR user_identifier LIKE ?)';
    const kw = `%${keyword}%`;
    params.push(kw, kw, kw, kw);
  }

  const registrations = db.prepare(`
    SELECT * FROM registrations ${whereClause}
    ORDER BY CASE status
      WHEN 'approved' THEN 1
      WHEN 'pending' THEN 2
      WHEN 'waitlist' THEN 3
      WHEN 'cancelled' THEN 4
      ELSE 5 END,
      queue_position ASC NULLS FIRST,
      created_at ASC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(page_size), offset);

  const total = db.prepare(`SELECT COUNT(*) as count FROM registrations ${whereClause}`).get(...params).count;

  return success(res, {
    list: registrations.map(formatRegistration),
    total,
    page: parseInt(page),
    page_size: parseInt(page_size)
  });
});

router.get('/:id', (req, res) => {
  const registration = db.prepare(`
    SELECT r.*, e.title as event_title, e.organizer_id
    FROM registrations r
    JOIN events e ON r.event_id = e.id
    WHERE r.id = ? AND e.organizer_id = ?
  `).get(req.params.id, req.organizer.id);

  if (!registration) {
    return error(res, '报名记录不存在', 404);
  }

  return success(res, formatRegistration(registration));
});

function formatRegistration(reg) {
  return {
    ...reg,
    form_data: parseJson(reg.form_data),
    require_approval: undefined
  };
}

module.exports = router;
