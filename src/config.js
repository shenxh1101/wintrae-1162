module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET || 'event-service-secret-key-2024',
  jwtExpiresIn: '24h',
  database: {
    path: process.env.DB_PATH || './data/event.db'
  },
  registration: {
    defaultWaitlistLimit: 50,
    qrCodeBaseUrl: process.env.QR_BASE_URL || 'http://localhost:3000/checkin/verify'
  }
};
