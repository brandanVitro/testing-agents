# Gmail to Google Calendar Agent

This project provisions an autonomous agent powered by [`openai-agents`](https://github.com/openai/openai-agents-js) that twice per day scans a Gmail inbox with **gpt-5.1-mini** and adds any dated commitments it finds straight into Google Calendar.

The agent works by wiring OpenAI's runtime tools to the Gmail and Calendar APIs. On each scheduled run it:

1. Pulls in any newly received emails since the last successful scan.
2. Uses the `gpt-5.1-mini` model to interpret the messages and decide whether they describe a calendar-worthy event.
3. Creates the event in Google Calendar (including rich descriptions and attendee lists when available).

## Prerequisites

* Node.js 18+
* An OpenAI API key with access to the `gpt-5.1-mini` model
* A Google Cloud project with the Gmail and Calendar APIs enabled
* OAuth 2.0 credentials for a Gmail account and a refresh token with the following scopes:
  * `https://www.googleapis.com/auth/gmail.readonly`
  * `https://www.googleapis.com/auth/calendar`

## Environment setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create an `.env` file and fill in the required credentials:

   ```bash
   cp .env.example .env
   # edit .env to add your keys and tokens
   ```

   | Variable | Description |
   | --- | --- |
   | `OPENAI_API_KEY` | OpenAI key used to call the `gpt-5.1-mini` model. |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | OAuth2 client credentials that match the refresh token. |
   | `GMAIL_REFRESH_TOKEN` | Refresh token authorized for Gmail read-only and Calendar scopes. |
   | `GOOGLE_CALENDAR_ID` | Calendar identifier (e.g. `primary` or a specific calendar ID). |
   | `CHECK_CRON` | Optional cron expression controlling how often to scan Gmail (defaults to `0 8,20 * * *`). |
   | `TIMEZONE` | Time zone for cron scheduling (defaults to `Etc/UTC`). |

3. (Optional) Seed initial Gmail credentials.

   * Generate a refresh token by following Google's OAuth 2.0 flow for installed applications.
   * Be sure to include the Gmail and Calendar scopes listed above.

## Running the agent

Run the scheduler with:

```bash
npm run agent
```

* The script triggers one scan immediately and then continues on the cron schedule (twice per day by default).
* To execute a single run without starting the scheduler, set `RUN_ONCE=true` in the environment.

All run state (last scan time and processed email IDs) is stored in `data/agent-state.json` so the agent can safely resume across restarts.

## How it works

* The agent exposes two tools to the model:
  * `list_recent_emails` fetches recent Gmail messages with decoded bodies.
  * `create_calendar_event` inserts a fully specified event into Google Calendar.
* The system prompt asks the model to pull new emails, interpret natural-language dates/times, and only create non-duplicate events.
* Every tool invocation and the final assistant reasoning are printed to stdout for observability.

Refer to the [`openai-agents` documentation](https://github.com/openai/openai-agents-js) for more ideas on expanding this workflow or deploying it in production.
