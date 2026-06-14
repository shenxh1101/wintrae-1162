const express = require('express');
const cors = require('cors');
const config = require('./config');

const authRoutes = require('./routes/auth');
const eventRoutes = require('./routes/events');
const registrationRoutes = require('./routes/registrations');
const flowRoutes = require('./routes/flow');
const checkinRoutes = require('./routes/checkin');
const blacklistRoutes = require('./routes/blacklist');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.json({
    name: 'Event Registration Service',
    version: '1.0.0',
    description: '线下活动报名、候补、签到统一管理后端服务',
    endpoints: {
      auth: '/api/auth',
      events: '/api/events',
      registrations: '/api/registrations',
      flow: '/api/flow',
      checkin: '/api/checkin',
      blacklist: '/api/blacklist'
    },
    default_account: {
      username: 'admin',
      password: 'admin123'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/registrations', registrationRoutes);
app.use('/api/flow', flowRoutes);
app.use('/api/checkin', checkinRoutes);
app.use('/api/blacklist', blacklistRoutes);

app.use((err, req, res, next) => {
  console.error('[Error]', err);
  res.status(500).json({
    code: -1,
    message: '服务器内部错误',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

app.use((req, res) => {
  res.status(404).json({
    code: -1,
    message: '接口不存在'
  });
});

app.listen(config.port, () => {
  console.log(`\n========================================`);
  console.log(`  Event Registration Service`);
  console.log(`  Server running on http://localhost:${config.port}`);
  console.log(`  Default account: admin / admin123`);
  console.log(`========================================\n`);
});

module.exports = app;
