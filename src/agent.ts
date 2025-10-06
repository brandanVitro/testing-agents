import 'dotenv/config';
import cron from 'node-cron';
import { promises as fs } from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { createAgentRuntime, tool } from 'openai-agents';
import { createOpenAI } from 'openai-agents/providers/openai';
import { z } from 'zod';

const STATE_PATH = path.resolve('data/agent-state.json');
const MAX_TRACKED_EMAIL_IDS = 500;

type AgentState = {
  lastCheckedAt?: string;
  processedEmailIds?: string[];
};

type GmailEmail = {
  id: string;
  threadId?: string | null;
  subject: string;
  from: string;
  receivedAt: string;
  body: string;
};

const requiredEnv = [
  'OPENAI_API_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'GMAIL_REFRESH_TOKEN',
  'GOOGLE_CALENDAR_ID',
] as const;

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const openaiApiKey = process.env.OPENAI_API_KEY!;
const calendarId = process.env.GOOGLE_CALENDAR_ID!;
const cronExpression = process.env.CHECK_CRON ?? '0 8,20 * * *';
const timezone = process.env.TIMEZONE ?? 'Etc/UTC';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);
oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

function decodeBase64Url(data?: string | null): string {
  if (!data) return '';
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const buffer = Buffer.from(normalized, 'base64');
  return buffer.toString('utf8');
}

function extractHeader(headers: { name?: string | null; value?: string | null }[], name: string): string {
  return headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function extractBody(payload: any): string {
  if (!payload) return '';
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    return payload.parts.map((part: any) => decodeBase64Url(part.body?.data)).join('\n');
  }
  return '';
}

async function loadState(): Promise<AgentState> {
  try {
    const content = await fs.readFile(STATE_PATH, 'utf8');
    return JSON.parse(content) as AgentState;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function saveState(state: AgentState): Promise<void> {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

async function fetchEmails(afterIso: string, maxResults: number, processedIds: Set<string>): Promise<GmailEmail[]> {
  const afterDate = new Date(afterIso);
  const afterSeconds = Math.floor(afterDate.getTime() / 1000);
  const query = `after:${afterSeconds} -is:chat`;

  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    q: query,
    labelIds: ['INBOX'],
  });

  const messages = listResponse.data.messages ?? [];
  const emails: GmailEmail[] = [];

  for (const message of messages) {
    if (!message.id) continue;
    if (processedIds.has(message.id)) {
      continue;
    }
    const fullMessage = await gmail.users.messages.get({
      id: message.id,
      userId: 'me',
      format: 'full',
    });

    const payload = fullMessage.data.payload ?? {};
    const headers = Array.isArray(payload.headers) ? payload.headers : [];
    const subject = extractHeader(headers, 'Subject');
    const from = extractHeader(headers, 'From');
    const internalDate = fullMessage.data.internalDate
      ? new Date(Number(fullMessage.data.internalDate)).toISOString()
      : new Date().toISOString();
    const body = extractBody(payload).slice(0, 8000);

    emails.push({
      id: message.id,
      threadId: fullMessage.data.threadId,
      subject,
      from,
      receivedAt: internalDate,
      body,
    });
  }

  return emails;
}

let defaultAfterIso = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
const seenEmailIdsThisRun = new Set<string>();

const runtime = createAgentRuntime({
  model: 'gpt-5.1-mini',
  provider: createOpenAI({ apiKey: openaiApiKey }),
  tools: [
    tool({
      name: 'list_recent_emails',
      description:
        'Fetch recent Gmail messages received after a given ISO timestamp. Use this to inspect emails for potential calendar events.',
      inputSchema: z.object({
        after: z.string().datetime().optional().describe('ISO-8601 timestamp to start searching from.'),
        maxResults: z.number().int().min(1).max(30).optional().describe('Maximum number of messages to load (default 10).'),
      }),
      async execute({ after, maxResults }) {
        const state = await loadState();
        const processedIds = new Set(state.processedEmailIds ?? []);
        const effectiveAfter = after ?? defaultAfterIso;
        const limit = maxResults ?? 10;
        const emails = await fetchEmails(effectiveAfter, limit, processedIds);
        emails.forEach((email) => seenEmailIdsThisRun.add(email.id));
        return {
          emails: emails.map((email) => ({
            id: email.id,
            threadId: email.threadId,
            subject: email.subject,
            from: email.from,
            receivedAt: email.receivedAt,
            body: email.body,
          })),
          after: effectiveAfter,
        };
      },
    }),
    tool({
      name: 'create_calendar_event',
      description: 'Create a Google Calendar event with the supplied details.',
      inputSchema: z.object({
        summary: z.string().min(1).describe('Event title.'),
        description: z.string().optional().describe('Context from the email or any additional notes.'),
        location: z.string().optional().describe('Event location if available.'),
        start: z
          .object({
            dateTime: z.string().datetime().describe('ISO timestamp for event start.'),
            timeZone: z.string().min(1).describe('IANA time zone identifier.'),
          })
          .describe('Start time definition.'),
        end: z
          .object({
            dateTime: z.string().datetime().describe('ISO timestamp for event end.'),
            timeZone: z.string().min(1).describe('IANA time zone identifier.'),
          })
          .describe('End time definition.'),
        attendees: z
          .array(
            z.object({
              email: z.string().email().describe('Attendee email address.'),
              optional: z.boolean().optional().describe('Mark attendee as optional.'),
            }),
          )
          .optional()
          .describe('List of attendees derived from the email.'),
        sourceEmailId: z
          .string()
          .optional()
          .describe('Gmail message ID that inspired the event (for bookkeeping).'),
      }),
      async execute({ summary, description, location, start, end, attendees, sourceEmailId }) {
        const response = await calendar.events.insert({
          calendarId,
          requestBody: {
            summary,
            description,
            location,
            start,
            end,
            attendees,
            source: sourceEmailId
              ? { title: 'Gmail', url: `https://mail.google.com/mail/u/0/#inbox/${sourceEmailId}` }
              : undefined,
          },
        });
        return {
          eventId: response.data.id,
          htmlLink: response.data.htmlLink,
        };
      },
    }),
  ],
});

async function runAgentCycle(): Promise<void> {
  const state = await loadState();
  const nowIso = new Date().toISOString();
  const lastCheckedAt = state.lastCheckedAt ?? new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  defaultAfterIso = lastCheckedAt;
  seenEmailIdsThisRun.clear();

  console.log(`\n[${new Date().toISOString()}] Starting Gmail scan (after ${lastCheckedAt})...`);

  const runResult = await runtime.run({
    messages: [
      {
        role: 'system',
        content:
          'You are an automation agent that triages new Gmail messages and schedules calendar events. '\
          + 'First call list_recent_emails using the provided "after" timestamp. For any email that clearly describes a meeting, appointment, flight, or other dated commitment, create a single calendar event that captures the title, timing, participants, location, and important notes. '\
          + 'Avoid creating duplicate events if they already exist or if the email has been processed before. '
          + 'If no relevant events are found, respond with a short confirmation.',
      },
      {
        role: 'user',
        content: `The last scan finished at ${lastCheckedAt}. Review new messages and add any events to my calendar.`,
      },
    ],
  });

  console.log('\nAssistant response:\n');
  console.log(runResult.outputText());

  if (runResult.toolResults.length > 0) {
    console.log('\nTool results:');
    for (const result of runResult.toolResults) {
      console.log(`- ${result.toolName}:`, result.result);
    }
  }

  const updatedProcessedIds = Array.from(
    new Set([...(state.processedEmailIds ?? []), ...seenEmailIdsThisRun]),
  );
  const trimmedProcessedIds = updatedProcessedIds.slice(-MAX_TRACKED_EMAIL_IDS);

  await saveState({
    lastCheckedAt: nowIso,
    processedEmailIds: trimmedProcessedIds,
  });

  console.log(`\n[${new Date().toISOString()}] Scan complete. Next run scheduled by cron.`);
}

async function main() {
  if (process.env.RUN_ONCE === 'true') {
    await runAgentCycle();
    return;
  }

  await runAgentCycle();
  console.log(`Scheduling recurring scans with cron expression "${cronExpression}" (${timezone}).`);

  cron.schedule(
    cronExpression,
    () => {
      runAgentCycle().catch((error) => {
        console.error('Scheduled run failed:', error);
      });
    },
    { timezone },
  );
}

main().catch((error) => {
  console.error('Agent failed to start:', error);
  process.exitCode = 1;
});
