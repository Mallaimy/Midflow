'use strict';

const express = require('express');
const { Pool } = require('pg');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// HIPAA: structured logging, no PHI
const log = {
  info:  (msg, meta = {}) => console.log(JSON.stringify({ level: 'info',  message: msg, ...meta, timestamp: new Date().toISOString() })),
  error: (msg, meta = {}) => console.error(JSON.stringify({ level: 'error', message: msg, ...meta, timestamp: new Date().toISOString() })),
};

// HIPAA: mask PHI before logging
const maskId = (id) => id ? `${id.substring(0, 8)}***` : 'unknown';

// ── Database ───────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  log.error('DATABASE_URL environment variable not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true }, // HIPAA: enforce SSL
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// ── SQS ───────────────────────────────────────────────────────────────────
const sqsClient = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });

const publishEvent = async (eventType, payload) => {
  if (!process.env.SQS_QUEUE_URL) {
    log.info('SQS_QUEUE_URL not set, skipping event publish');
    return;
  }
  try {
    await sqsClient.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_QUEUE_URL,
      MessageBody: JSON.stringify({ eventType, payload, timestamp: new Date().toISOString() }),
    }));
    log.info('Event published to SQS', { eventType });
  } catch (err) {
    log.error('Failed to publish SQS event', { eventType, error: err.message });
  }
};

// ── DB Init ───────────────────────────────────────────────────────────────
const initDb = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patient_id    UUID NOT NULL,
        doctor_name   VARCHAR(255) NOT NULL,
        department    VARCHAR(255) NOT NULL,
        scheduled_at  TIMESTAMP NOT NULL,
        status        VARCHAR(50) NOT NULL DEFAULT 'scheduled',
        notes         TEXT,
        created_at    TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    log.info('Database initialized successfully');
  } finally {
    client.release();
  }
};

// ── Routes ────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', service: 'appointment-service', version: '1.0.0' });
  } catch {
    log.error('Health check failed - database unreachable');
    res.status(503).json({ status: 'unhealthy', service: 'appointment-service' });
  }
});

app.get('/appointments', async (req, res) => {
  try {
    const page    = parseInt(req.query.page) || 1;
    const perPage = Math.min(parseInt(req.query.per_page) || 20, 100);
    const offset  = (page - 1) * perPage;

    const [data, count] = await Promise.all([
      pool.query('SELECT * FROM appointments ORDER BY scheduled_at DESC LIMIT $1 OFFSET $2', [perPage, offset]),
      pool.query('SELECT COUNT(*) FROM appointments'),
    ]);

    log.info('Appointments retrieved', { count: data.rows.length });
    res.json({
      appointments: data.rows,
      total:        parseInt(count.rows[0].count),
      page,
      per_page:     perPage,
    });
  } catch (err) {
    log.error('Failed to retrieve appointments', { error: err.message });
    res.status(500).json({ error: 'Failed to retrieve appointments' });
  }
});

app.post('/appointments', async (req, res) => {
  try {
    const { patient_id, doctor_name, department, scheduled_at, notes } = req.body;

    if (!patient_id || !doctor_name || !department || !scheduled_at) {
      return res.status(400).json({ error: 'Missing required fields: patient_id, doctor_name, department, scheduled_at' });
    }

    const result = await pool.query(
      `INSERT INTO appointments (patient_id, doctor_name, department, scheduled_at, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [patient_id, doctor_name, department, new Date(scheduled_at), notes || null]
    );

    const appointment = result.rows[0];

    // Publish event to SQS — Notification Service will pick this up
    await publishEvent('APPOINTMENT_CREATED', {
      appointmentId: appointment.id,
      patientId:     maskId(appointment.patient_id), // HIPAA: masked
      department:    appointment.department,
      scheduledAt:   appointment.scheduled_at,
    });

    log.info('Appointment created', { appointmentId: appointment.id });
    res.status(201).json(appointment);

  } catch (err) {
    log.error('Failed to create appointment', { error: err.message });
    res.status(500).json({ error: 'Failed to create appointment' });
  }
});

app.get('/appointments/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM appointments WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Appointment not found' });
    log.info('Appointment accessed', { appointmentId: maskId(req.params.id) });
    res.json(result.rows[0]);
  } catch (err) {
    log.error('Failed to retrieve appointment', { error: err.message });
    res.status(500).json({ error: 'Failed to retrieve appointment' });
  }
});

app.put('/appointments/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['scheduled', 'confirmed', 'cancelled', 'completed'];

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const result = await pool.query(
      `UPDATE appointments SET status = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Appointment not found' });

    await publishEvent('APPOINTMENT_STATUS_UPDATED', {
      appointmentId: result.rows[0].id,
      status,
    });

    log.info('Appointment status updated', { appointmentId: maskId(req.params.id), status });
    res.json(result.rows[0]);

  } catch (err) {
    log.error('Failed to update appointment status', { error: err.message });
    res.status(500).json({ error: 'Failed to update appointment' });
  }
});

app.delete('/appointments/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM appointments WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Appointment not found' });
    log.info('Appointment deleted', { appointmentId: maskId(req.params.id) });
    res.status(204).send();
  } catch (err) {
    log.error('Failed to delete appointment', { error: err.message });
    res.status(500).json({ error: 'Failed to delete appointment' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      log.info(`Appointment service running`, { port: PORT });
    });
  })
  .catch((err) => {
    log.error('Failed to initialize database', { error: err.message });
    process.exit(1);
  });

module.exports = app;