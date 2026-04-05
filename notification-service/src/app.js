'use strict';

const express = require('express');
const {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} = require('@aws-sdk/client-sqs');
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const app = express();
app.use(express.json());

// HIPAA: structured logging, no PHI
const log = {
  info:  (msg, meta = {}) => console.log(JSON.stringify({
    level: 'info', message: msg, ...meta, timestamp: new Date().toISOString()
  })),
  error: (msg, meta = {}) => console.error(JSON.stringify({
    level: 'error', message: msg, ...meta, timestamp: new Date().toISOString()
  })),
};

// ── AWS Clients ────────────────────────────────────────────────────────────
const region    = process.env.AWS_REGION || 'us-east-1';
const sqsClient = new SQSClient({ region });
const sesClient = new SESClient({ region });

const QUEUE_URL      = process.env.SQS_QUEUE_URL;
const FROM_EMAIL     = process.env.SES_FROM_EMAIL || 'noreply@mediflow.com';

// ── Email Templates ────────────────────────────────────────────────────────
// HIPAA: email templates contain minimum necessary information only
const templates = {
  APPOINTMENT_CREATED: (payload) => ({
    subject: 'MediFlow — Appointment Confirmation',
    body: `
Your appointment has been successfully scheduled.

Department : ${payload.department}
Date & Time: ${new Date(payload.scheduledAt).toLocaleString()}
Reference  : ${payload.appointmentId}

Please arrive 15 minutes before your scheduled time.
If you need to reschedule, contact us at least 24 hours in advance.

MediFlow Hospital Management System
    `.trim(),
  }),

  APPOINTMENT_STATUS_UPDATED: (payload) => ({
    subject: `MediFlow — Appointment ${payload.status}`,
    body: `
Your appointment status has been updated.

New Status : ${payload.status.toUpperCase()}
Reference  : ${payload.appointmentId}

If you have questions, please contact your care team.

MediFlow Hospital Management System
    `.trim(),
  }),
};

// ── SQS Polling ────────────────────────────────────────────────────────────
const processMessage = async (message) => {
  try {
    const body      = JSON.parse(message.Body);
    const { eventType, payload } = body;

    log.info('Processing SQS message', { eventType });

    const template = templates[eventType];
    if (!template) {
      log.info('No template for event type, skipping', { eventType });
      return;
    }

    // In production this would look up the patient email from Patient Service
    // For demo: we send to a verified SES email
    const { subject, body: emailBody } = template(payload);

    if (QUEUE_URL && process.env.SES_FROM_EMAIL) {
      await sesClient.send(new SendEmailCommand({
        Source: FROM_EMAIL,
        Destination: {
          // HIPAA: in production pulled from patient record securely
          ToAddresses: [FROM_EMAIL],
        },
        Message: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body:    { Text: { Data: emailBody, Charset: 'UTF-8' } },
        },
      }));
      log.info('Email sent successfully', { eventType });
    } else {
      log.info('SES not configured, logging email instead', { subject });
    }

  } catch (err) {
    log.error('Failed to process message', { error: err.message });
  }
};

const pollQueue = async () => {
  if (!QUEUE_URL) {
    log.info('SQS_QUEUE_URL not set, polling disabled');
    return;
  }

  try {
    const response = await sqsClient.send(new ReceiveMessageCommand({
      QueueUrl:            QUEUE_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds:     20, // long polling — cost efficient
    }));

    if (response.Messages?.length) {
      log.info('Messages received', { count: response.Messages.length });

      await Promise.all(response.Messages.map(async (msg) => {
        await processMessage(msg);
        // Delete after successful processing
        await sqsClient.send(new DeleteMessageCommand({
          QueueUrl:      QUEUE_URL,
          ReceiptHandle: msg.ReceiptHandle,
        }));
      }));
    }
  } catch (err) {
    log.error('SQS polling error', { error: err.message });
  }

  // Poll again immediately — ECS keeps this running continuously
  setImmediate(pollQueue);
};

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:  'healthy',
    service: 'notification-service',
    version: '1.0.0',
    polling: !!QUEUE_URL,
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

app.listen(PORT, '0.0.0.0', () => {
  log.info('Notification service running', { port: PORT });
  pollQueue(); // start SQS polling loop
});

module.exports = app;