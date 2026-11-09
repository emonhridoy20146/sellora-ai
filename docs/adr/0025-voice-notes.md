# ADR 0025 — Voice notes: saved, playable and turned into text for the AI

**Status:** accepted (2026-11-09). Part 3 of "AI data sync" in the plan (Phase 1). Parts 1 and 2
are ADR 0023 (catalog sync) and ADR 0024 (website crawl).

**Context.** Many customers in Bangladesh send voice notes instead of typing, in Bangla,
Banglish or English, on Messenger, Instagram and WhatsApp. Until now Sellora kept Meta's
expiring link for Messenger audio and skipped WhatsApp audio, so staff could not play it later
and the AI sales agent never knew what was asked. The plan asks for voice notes to be
transcribed and handled like typed text, metered in AI credits like every other AI call, with
no provider name or price hard-coded in features.

**Decision.**

- **Saved like photos (ADR 0012).** An incoming audio attachment (Messenger and Instagram
  `type: audio`, WhatsApp `audio` with a media id) becomes an attachment with `kind: 'audio'`,
  status `pending` and its source. The media worker downloads it (WhatsApp with the channel's
  token), checks the bytes (Ogg, MP4/M4A, MP3, AAC, AMR, WAV, WebM are recognised by their
  signatures, never by the declared type) and stores it as a private `chat_media` file under
  the same size limit and plan storage as photos. Staff play it through the inbox route, which
  needs a signed-in member who can see the conversation and answers HTTP byte ranges (players
  read the end of an Ogg file to show its length, and seek).
- **Measured.** The recording's length is read from the file (`music-metadata`), kept on the
  attachment (`durationMs`) and shown as "0:04". Files that cannot be measured are estimated at
  3,000 bytes a second for the credit hold only.
- **Transcribed in the worker.** Saving queues one `transcribe` job on the AI queue (3 attempts,
  5 s exponential backoff; a job id per message, attachment and run). The job checks, in order,
  and records a plain-language reason when it stops:
  1. the business is active;
  2. its plan has the AI sales agent module;
  3. "Turn voice notes into text" is on (AI agent settings, default on);
  4. a speech-to-text model is enabled in the catalogue and its provider has a key, and the
     credit price list in force has a voice note price; otherwise "not set up on this server",
     with one platform alert a day;
  5. the recording can be read (at most the upload limit) and is no longer than
     `VOICE_NOTE_MAX_SECONDS` (default 300);
  6. the wallet can hold the price (else "the AI credit balance is used up").
     It then claims the run (so two workers never transcribe the same note), holds the credits,
     sends the audio with a language hint (Bangla or English when the agent's language setting is
     one of those; otherwise none) and a vocabulary prompt (the business name and its top 15
     products, at most 400 characters), and settles the charge on the measured length. Retryable
     provider errors (timeouts, 429, 5xx) go back to the queue until the last attempt; an
     unreadable file or a refused key fails at once. Every failure releases the hold.
- **Speech-to-text is a model like any other.** `ai_models` gains `purpose` (`chat` or
  `transcription`) and `audioUsdMicrosPerMinute`. The super-admin adds and prices speech models
  in Admin › AI credits & models; "default" is scoped per tier for chat models and across all
  speech models. Providers are adapters behind one `Transcriber` interface; the first is an
  OpenAI-style `/audio/transcriptions` client (`AI_OPENAI_API_KEY`, optional
  `AI_OPENAI_BASE_URL`). The seeded model is `gpt-4o-mini-transcribe` at $0.003 a minute; the
  super-admin must check it against the provider's current price list (it only affects
  reported cost and profit, never what businesses pay).
- **Charged by the second.** Credit price lists gain `transcriptionCreditsPerMinute`
  (seeded 15). A voice note costs `ceil(ms × credits per minute / 60,000)` hundredths of a
  credit with the usual per-request minimum, billed in the wallet like a chat reply, recorded
  in `ai_usage` with `audioMs` and no tier, and shown to the business as "Voice notes to text"
  in Billing › Usage. A price list without a voice price leaves voice notes audio only. Profit
  reports group them under "voice notes".
- **The AI agent hears it.** A reply waits while a recording or its text is pending (up to
  15 checks, 2 s apart), then sees the note in the history as
  `[The customer sent a voice note (0:12). Speech-to-text heard: "…"]`, or a line saying it
  could not be turned into text. The prompt tells it to answer in the language spoken, to
  confirm names, phone numbers and addresses before an order (speech-to-text can mishear them),
  and to ask the customer to type when a note could not be read. Handover keywords match spoken
  words too.
- **In the inbox.** The bubble shows a player with the length, then "Turning into text…", the
  quoted words with "Voice-to-text · N credits · may mishear names and numbers", "No words were
  heard", or the reason it stopped. Staff who can reply can press "Try again" (or "Turn into
  text" for older notes), which queues a new run only for a saved voice note whose text is
  missing, failed or skipped. The chat list preview says "Voice note".

**Consequences.**

- One metering path: voice notes reserve, settle and release credits exactly like chat
  replies, so wallet holds, shortfalls and the profit report need no special cases.
- The transcript is plain text on the message: searchable later, exported in backups, and
  never sent back to the customer.
- Not built: recording or sending voice notes from the website chat or by staff; reading
  WhatsApp documents. Some providers refuse AMR or AAC; such notes fail with a reason and stay
  playable. The `tier` field is unused for speech models.
- Tried only against fakes (the e2e suite's fake speech service) and
  `scripts/speech-stand-in.mjs` with the Graph and Claude stand-ins (the browser flow). The
  stand-in answers a scripted sentence without listening; no real recording has been sent to
  a real speech-to-text service yet.
