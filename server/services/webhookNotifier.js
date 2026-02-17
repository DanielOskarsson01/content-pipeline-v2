/**
 * Notification Service — webhook + email + Telegram notifications.
 *
 * Webhook:  Set WEBHOOK_URL in .env to POST JSON on every event.
 * Email:    Set SMTP_HOST, SMTP_USER, SMTP_PASS, NOTIFY_EMAIL in .env to send emails.
 * Telegram: Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env to send messages.
 *
 * Both are fire-and-forget: errors are logged but never thrown.
 * Used by stageWorker.js after submodule execution completes or fails.
 */

import nodemailer from 'nodemailer';

const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const TIMEOUT = 5000;

// Email config
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || '';

let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS && NOTIFY_EMAIL) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  console.log(`[notify] Email notifications enabled → ${NOTIFY_EMAIL}`);
}

// Telegram config
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
  console.log(`[notify] Telegram notifications enabled → chat ${TELEGRAM_CHAT_ID}`);
}

/**
 * Send a webhook notification. Fire-and-forget: never throws.
 */
async function sendWebhook(event, payload) {
  if (!WEBHOOK_URL) return;

  const body = {
    event,
    timestamp: new Date().toISOString(),
    ...payload,
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    console.warn(`[webhook] Failed to deliver ${event}: ${err.message}`);
  }
}

/**
 * Send an email notification. Fire-and-forget: never throws.
 */
async function sendEmail(subject, text) {
  if (!transporter) return;

  try {
    await transporter.sendMail({
      from: SMTP_USER,
      to: NOTIFY_EMAIL,
      subject: `[Pipeline] ${subject}`,
      text,
    });
  } catch (err) {
    console.warn(`[email] Failed to send: ${err.message}`);
  }
}

/**
 * Send a Telegram message. Fire-and-forget: never throws.
 */
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    console.warn(`[telegram] Failed to send: ${err.message}`);
  }
}

/**
 * Notify that a submodule completed successfully.
 */
export function notifyCompletion({ submoduleId, submoduleRunId, runId, stepIndex, result }) {
  const summary = result?.summary || {};
  const errors = summary.errors || [];

  const payload = {
    submodule_id: submoduleId,
    submodule_run_id: submoduleRunId,
    run_id: runId,
    step_index: stepIndex,
    summary: {
      total_entities: summary.total_entities || 0,
      total_items: summary.total_items || 0,
      errors,
      description: summary.description || '',
    },
  };

  sendWebhook('submodule.completed', payload);

  // Email: always on completion (includes error details if any entities failed)
  const lines = [
    `Submodule: ${submoduleId}`,
    `Step: ${stepIndex}`,
    `Result: ${summary.description || 'completed'}`,
    `Items: ${summary.total_items || 0}`,
  ];

  if (errors.length > 0) {
    lines.push('', `Entity errors (${errors.length}):`);
    for (const err of errors) {
      lines.push(`  - ${err}`);
    }
  }

  const subject = errors.length > 0
    ? `${submoduleId} completed with ${errors.length} error(s)`
    : `${submoduleId} completed — ${summary.total_items || 0} items`;

  sendEmail(subject, lines.join('\n'));

  // Telegram
  const emoji = errors.length > 0 ? '⚠️' : '✅';
  const tgLines = [`${emoji} <b>${submoduleId}</b> completed`, summary.description || ''];
  if (errors.length > 0) {
    tgLines.push('', `<b>Errors (${errors.length}):</b>`);
    for (const err of errors.slice(0, 10)) {
      tgLines.push(`• ${err}`);
    }
  }
  sendTelegram(tgLines.join('\n'));
}

/**
 * Notify that a submodule execution failed.
 */
export function notifyFailure({ submoduleId, submoduleRunId, runId, stepIndex, error }) {
  sendWebhook('submodule.failed', {
    submodule_id: submoduleId,
    submodule_run_id: submoduleRunId,
    run_id: runId,
    step_index: stepIndex,
    error,
  });

  sendEmail(
    `${submoduleId} FAILED`,
    [`Submodule: ${submoduleId}`, `Step: ${stepIndex}`, `Error: ${error}`].join('\n')
  );

  sendTelegram(`❌ <b>${submoduleId}</b> FAILED\nStep: ${stepIndex}\nError: ${error}`);
}
