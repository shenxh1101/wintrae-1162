const axios = require('axios');
const db = require('../models/db');

async function triggerCallback(organizerId, eventType, payload) {
  try {
    const organizer = db.prepare('SELECT callback_url FROM organizers WHERE id = ?').get(organizerId);
    if (!organizer || !organizer.callback_url) {
      return false;
    }

    await axios.post(organizer.callback_url, {
      event: eventType,
      timestamp: new Date().toISOString(),
      data: payload
    }, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    }).catch(() => {});

    return true;
  } catch {
    return false;
  }
}

function writeAuditLog(eventId, registrationId, action, details) {
  db.prepare(`INSERT INTO audit_logs (event_id, registration_id, action, details) VALUES (?, ?, ?, ?)`).run(
    eventId,
    registrationId,
    action,
    details ? JSON.stringify(details) : null
  );
}

module.exports = { triggerCallback, writeAuditLog };
